// 利用回数・推定利用額の記録（台帳）と、停止の判定。
// - 送る前に「最悪額」を予約し、応答後に実際のトークン使用量から精算する
// - 月・日の切り替わりは日本時間（Asia/Tokyo）
// - 台帳が壊れているときは、ゼロに戻さずAIを止める（安全側）
// - 1つのサーバープロセスだけで動かす前提（同時リクエストは順番に処理する）
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const jstParts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" });

function jstDay(date) { return jstParts.format(date); }       // 例 2026-11-16
function jstMonth(date) { return jstDay(date).slice(0, 7); }  // 例 2026-11
const round6 = (n) => Math.round(n * 1e6) / 1e6;

class Budget {
  constructor({ file, monthlyStopJpy, dailyMaxCalls, breaker, now = () => new Date(), staleReservationMs = 5 * 60 * 1000 }) {
    this.file = file;
    this.monthlyStopJpy = monthlyStopJpy;
    this.dailyMaxCalls = dailyMaxCalls;
    this.breakerConfig = breaker;
    this.now = now;
    this.staleReservationMs = staleReservationMs;
    this.broken = false;
    this._chain = Promise.resolve();
    this.state = { version: 1, month: "", spentJpy: 0, days: {}, reservations: {}, breaker: { failures: 0, until: 0, reason: "" } };
    this._load();
    this._rollover();
  }

  _load() {
    let text;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return; // 初回
      this.broken = true;
      return;
    }
    try {
      const s = JSON.parse(text);
      const ok = s && s.version === 1 && typeof s.month === "string" && Number.isFinite(s.spentJpy) && s.spentJpy >= 0 &&
        s.days && typeof s.days === "object" && s.reservations && typeof s.reservations === "object" && s.breaker;
      if (!ok) throw new Error("bad ledger");
      this.state = s;
    } catch {
      this.broken = true;
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }

  /** 月が変わったら集計を新しくし、古い予約（途中で止まった通信）は最悪額で確定する */
  _rollover() {
    const now = this.now();
    const s = this.state;
    const month = jstMonth(now);
    if (s.month !== month) {
      s.month = month;
      s.spentJpy = 0;
      s.days = {};
    }
    for (const [id, r] of Object.entries(s.reservations)) {
      if (now.getTime() - r.at > this.staleReservationMs) {
        s.spentJpy = round6(s.spentJpy + r.jpy);
        delete s.reservations[id];
      }
    }
  }

  _run(fn) {
    const next = this._chain.then(() => {
      if (this.broken) return fn(true);
      this._rollover();
      return fn(false);
    });
    this._chain = next.catch(() => {});
    return next;
  }

  _pendingJpy() { return Object.values(this.state.reservations).reduce((a, r) => a + r.jpy, 0); }
  _todayCalls() { return this.state.days[jstDay(this.now())] || 0; }

  /** 送る前の予約。通れば回数を1つ増やす（通信が失敗しても回数は戻さない） */
  reserve(worstJpy) {
    return this._run((broken) => {
      if (broken) return { ok: false, code: "ledger_error" };
      const s = this.state;
      if (s.breaker.until > this.now().getTime()) return { ok: false, code: "paused" };
      if (this._todayCalls() >= this.dailyMaxCalls) return { ok: false, code: "daily_limit" };
      if (s.spentJpy + this._pendingJpy() + worstJpy > this.monthlyStopJpy) return { ok: false, code: "budget_reached" };
      const id = crypto.randomUUID();
      const day = jstDay(this.now());
      s.days[day] = (s.days[day] || 0) + 1;
      s.reservations[id] = { jpy: round6(worstJpy), at: this.now().getTime() };
      this._save();
      return { ok: true, id };
    });
  }

  /** 実際の料金で確定する */
  settle(id, jpy) {
    return this._run((broken) => {
      if (broken) return;
      const r = this.state.reservations[id];
      if (!r) return;
      delete this.state.reservations[id];
      this.state.spentJpy = round6(this.state.spentJpy + Math.max(0, jpy));
      this._save();
    });
  }

  /** 金額が不確か（通信の途中で失敗など）なときは、最悪額で確定する */
  settleWorstCase(id) {
    return this._run((broken) => {
      if (broken) return;
      const r = this.state.reservations[id];
      if (!r) return;
      delete this.state.reservations[id];
      this.state.spentJpy = round6(this.state.spentJpy + r.jpy);
      this._save();
    });
  }

  /** 請求されていないことが確実なとき（APIが4xxで拒否した場合など）は、予約を取り消す */
  release(id) {
    return this._run((broken) => {
      if (broken) return;
      if (this.state.reservations[id]) {
        delete this.state.reservations[id];
        this._save();
      }
    });
  }

  recordSuccess() {
    return this._run((broken) => {
      if (broken || this.state.breaker.failures === 0) return;
      this.state.breaker.failures = 0;
      this._save();
    });
  }

  /** 失敗の記録。続けて失敗する（または認証・残高の問題）と、一定時間AIを止める */
  recordFailure({ halt = false, reason = "" } = {}) {
    return this._run((broken) => {
      if (broken) return;
      const b = this.state.breaker;
      b.failures += 1;
      if (halt || b.failures >= this.breakerConfig.failureThreshold) {
        b.until = this.now().getTime() + (halt ? this.breakerConfig.authCooldownMs : this.breakerConfig.cooldownMs);
        b.reason = reason;
        b.failures = 0;
      }
      this._save();
    });
  }

  /** 画面に出す状況（秘密や内容は含まない） */
  status() {
    const now = this.now();
    const s = this.state;
    const month = jstMonth(now);
    const monthMatches = s.month === month;
    const spent = monthMatches ? s.spentJpy : 0;
    const today = monthMatches ? (s.days[jstDay(now)] || 0) : 0;
    const paused = s.breaker.until > now.getTime();
    let stopReason = null;
    if (this.broken) stopReason = "ledger_error";
    else if (paused) stopReason = "paused";
    else if (spent + this._pendingJpy() >= this.monthlyStopJpy) stopReason = "budget_reached";
    else if (today >= this.dailyMaxCalls) stopReason = "daily_limit";
    return {
      month,
      spentJpy: round6(spent),
      monthlyStopJpy: this.monthlyStopJpy,
      todayCalls: today,
      dailyMaxCalls: this.dailyMaxCalls,
      pausedUntil: paused ? new Date(s.breaker.until).toISOString() : null,
      stopReason,
      available: stopReason === null,
    };
  }
}

module.exports = { Budget, jstDay, jstMonth };
