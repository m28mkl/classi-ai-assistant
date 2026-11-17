// AI接続（確認画面・送信・利用状況・停止・エラー）の画面テスト。iPad Air 縦・横。
// サーバーは page.route で偽物に差し替える（本物のAIには通信しない）。
const { test, expect } = require("@playwright/test");

const TEXT = "問3 次のうち、正しいものを選びなさい。\nア．光は直進する\nイ．音は真空中を伝わる\nウ．水は100℃で凍る\nエ．氷は水に浮く";
const UNCERTAIN = [{ text: "ウ．水は100℃で凍る", confidence: 52, words: [] }];
const EXPLANATION = {
  meaning: "光や音の性質を選ぶ問題です。",
  method: "選択肢を1つずつ確かめます。",
  candidates: ["ア", "エ"],
  reason: "光は直進し、氷は水に浮くからです。",
  pitfalls: "音は真空中を伝わりません。",
};

const statusOf = (over = {}) => ({
  month: "2026-11", spentJpy: 12.34, monthlyStopJpy: 300, todayCalls: 3, dailyMaxCalls: 50,
  pausedUntil: null, stopReason: null, available: true, model: "gpt-6-luna",
  limits: { maxInputTokens: 4000, maxOutputTokens: 800 },
  pricing: { updatedAt: "2026-11-16", stale: false }, accessCodeRequired: true, ...over,
});

let jsErrors;
let external;
let api; // { status, explain } 偽サーバーの応答を切り替える
let posts;

test.beforeEach(async ({ page }) => {
  jsErrors = [];
  external = [];
  posts = [];
  api = {
    status: () => ({ status: 200, json: { ok: true, ai: statusOf() } }),
    explain: () => ({ status: 200, json: { ok: true, explanation: EXPLANATION, costJpy: 0.05, costIsEstimate: true, status: statusOf({ todayCalls: 4, spentJpy: 12.39 }) } }),
  };
  page.on("pageerror", (e) => jsErrors.push(e.message));
  await page.route(/^https?:\/\//, async (route) => {
    const url = route.request().url();
    if (!url.startsWith("http://127.0.0.1")) { external.push(url); return route.abort(); }
    const m = url.match(/\/api\/(status|explain)$/);
    if (m) {
      if (m[1] === "explain") posts.push({ headers: route.request().headers(), body: JSON.parse(route.request().postData() || "null") });
      const r = api[m[1]]();
      if (r.abort) return route.abort();
      return route.fulfill({ status: r.status, contentType: "application/json", body: JSON.stringify(r.json) });
    }
    if (url.endsWith("/index.html") && api.endpoint) {
      const res = await route.fetch();
      const body = (await res.text()).replace('name="classi-ai-endpoint" content=""', `name="classi-ai-endpoint" content="${api.endpoint}"`);
      return route.fulfill({ response: res, body });
    }
    return route.continue();
  });
});

test.afterEach(() => {
  expect(jsErrors).toEqual([]);
  expect(external, "画面から外部への通信がない（OpenAIにも直接つながない）").toEqual([]);
});

async function open(page, { endpoint = "/api", uncertain = UNCERTAIN } = {}) {
  api.endpoint = endpoint;
  await page.goto("/index.html");
  if (endpoint) await expect(page.locator("#sec-explain h2 .badge")).not.toHaveText("AI接続を確認中");
  await page.evaluate(([t, u]) => window.__classiAssistant.showReading({ text: t, uncertain: u }), [TEXT, uncertain]);
}

async function confirmText(page) {
  page.once("dialog", (d) => d.accept());
  await page.click("#confirm-text");
  await expect(page.locator("#confirm-state")).toContainText("確認済み");
}

test.describe("AI未接続（接続先が空）", () => {
  test("何も通信せず、「AI接続前」と表示し、既存の機能は使える", async ({ page }) => {
    const apiCalls = [];
    page.on("request", (r) => { if (/\/api\//.test(r.url())) apiCalls.push(r.url()); });
    await open(page, { endpoint: "" });
    await expect(page.locator("#sec-explain h2 .badge")).toHaveText("AI接続前");
    await expect(page.locator("#ai-controls")).toBeHidden();
    await expect(page.locator('[data-ai-body] [data-pending="true"]')).toHaveCount(6);
    await expect(page.locator('[data-ai-body="meaning"]')).toContainText("AI接続前：まだ作成されていません");
    await page.click("#analyze");
    await expect(page.locator("#tasks .task").first()).toBeVisible();
    expect(apiCalls).toEqual([]);
  });
});

test.describe("利用状況の表示", () => {
  test("利用回数と推定利用額を表示し、請求の上限ではないと明記する", async ({ page }) => {
    await open(page);
    await expect(page.locator("#sec-explain h2 .badge")).toHaveText("AI接続済み");
    const usage = page.locator("#ai-usage");
    await expect(usage).toContainText("今日の利用回数");
    await expect(usage).toContainText("3 / 50 回");
    await expect(usage).toContainText("今月の推定利用額");
    await expect(usage).toContainText("¥12.34 / ¥300.00");
    await expect(usage).toContainText("推定値");
    await expect(usage).toContainText("請求の上限ではありません");
  });
  test("料金表が古いときは警告する", async ({ page }) => {
    api.status = () => ({ status: 200, json: { ok: true, ai: statusOf({ pricing: { updatedAt: "2026-01-01", stale: true } }) } });
    await open(page);
    await expect(page.locator("#ai-usage .warn")).toContainText("料金表の更新日（2026-01-01）が古い");
  });
  for (const [reason, text] of [["budget_reached", "停止ライン"], ["daily_limit", "回数の上限"], ["paused", "エラー"], ["ledger_error", "記録を読めない"]]) {
    test(`停止中（${reason}）：AIボタンが使えず、理由を表示し、AIなしの機能は使える`, async ({ page }) => {
      api.status = () => ({ status: 200, json: { ok: true, ai: statusOf({ stopReason: reason, available: false, pausedUntil: reason === "paused" ? "2026-11-16T05:30:00.000Z" : null }) } });
      await open(page);
      await expect(page.locator("#sec-explain h2 .badge")).toHaveText("AI停止中");
      await expect(page.locator("#ai-status")).toContainText(text);
      await expect(page.locator("#ai-ask")).toBeDisabled();
      await page.click("#analyze");
      await expect(page.locator("#tasks .task").first()).toBeVisible();
      expect(posts).toHaveLength(0);
    });
  }
  test("サーバーにつながらないときは「AIにつながりません」と表示し、AIなしで使える", async ({ page }) => {
    api.status = () => ({ abort: true });
    await open(page);
    await expect(page.locator("#sec-explain h2 .badge")).toHaveText("AIにつながりません");
    await expect(page.locator("#ai-ask")).toBeDisabled();
    await expect(page.locator('[data-ai-body="meaning"]')).toContainText("まだ作成されていません");
    await confirmText(page);
    await page.click("#analyze");
    await expect(page.locator("#tasks .task").first()).toBeVisible();
  });
});

test.describe("送信前の確認", () => {
  test("読み取り結果を確認するまでは、確認画面も出さず、何も送らない", async ({ page }) => {
    await open(page);
    await page.click("#ai-ask");
    await expect(page.locator("#ai-message")).toContainText("先に「② この内容で合っています」を押してください");
    await expect(page.locator("#ai-confirm")).toBeHidden();
    expect(posts).toHaveLength(0);
  });

  test("確認画面に送る内容をそのまま表示する（順番・要確認つき）。「送る」を押すまで通信しない", async ({ page }) => {
    await open(page);
    await confirmText(page);
    await page.click("#ai-ask");
    const confirm = page.locator("#ai-confirm");
    await expect(confirm).toBeVisible();
    const shown = await page.locator("#ai-payload").textContent();
    expect(shown).toContain("【問題文】\n問3 次のうち、正しいものを選びなさい。");
    expect(shown.indexOf("ア．光は直進する")).toBeLessThan(shown.indexOf("イ．音は真空中を伝わる"));
    expect(shown).toContain("ウ．水は100℃で凍る 【要確認】");
    await expect(confirm).toContainText("画像・ログイン情報・履歴は送りません");
    await expect(confirm).toContainText("1回の入力は約4,000トークンまで、AIの出力は800トークンまで");
    expect(posts).toHaveLength(0);
  });

  test("キャンセルすると何も送らない", async ({ page }) => {
    await open(page);
    await confirmText(page);
    await page.click("#ai-ask");
    await page.click("#ai-cancel");
    await expect(page.locator("#ai-confirm")).toBeHidden();
    await expect(page.locator("#ai-message")).toContainText("何も送信していません");
    expect(posts).toHaveLength(0);
  });

  test("確認画面を開いたあとに文章を直すと、確認画面が閉じ、古い内容は送られない", async ({ page }) => {
    await open(page);
    await confirmText(page);
    await page.click("#ai-ask");
    await expect(page.locator("#ai-confirm")).toBeVisible();
    await page.fill("#result", TEXT + "\nオ．追加");
    await expect(page.locator("#ai-confirm")).toBeHidden();
    expect(posts).toHaveLength(0);
  });
});

test.describe("送信と結果", () => {
  test("「送る」で、確認画面と同じ内容だけを送り、解説を表示する", async ({ page }) => {
    await open(page);
    await page.fill("#ai-code", "my-code");
    await confirmText(page);
    await page.click("#ai-ask");
    const shown = await page.locator("#ai-payload").textContent();
    await page.click("#ai-send");
    await expect(page.locator("#ai-message")).toContainText("AIの解説を受け取りました");
    expect(posts).toHaveLength(1);
    const { body, headers } = posts[0];
    expect(Object.keys(body).sort()).toEqual(["afterLines", "choices", "confirmedByUser", "stem"]);
    expect(body.confirmedByUser).toBe(true);
    expect(body.choices.map((c) => c.marker)).toEqual(["ア．", "イ．", "ウ．", "エ．"]);
    expect(body.choices[2].text).toBe("水は100℃で凍る 【要確認】");
    for (const part of [body.stem, ...body.choices.map((c) => c.marker + c.text)]) expect(shown).toContain(part);
    expect(headers["x-access-code"]).toBe("my-code");
    expect(JSON.stringify(body)).not.toMatch(/image|data:|password/i);

    await expect(page.locator('[data-ai-body="meaning"]')).toHaveText("光や音の性質を選ぶ問題です。");
    await expect(page.locator('[data-ai-body="candidates"] li')).toHaveText(["ア", "エ"]);
    await expect(page.locator('[data-ai-body="pitfalls"]')).toContainText("音は真空中を伝わりません");
    await expect(page.locator('[data-ai-body] [data-pending="true"]')).toHaveCount(0);
    await expect(page.locator("#ai-result-note")).toContainText("AIが作成した解説です");
    await expect(page.locator("#ai-result-note")).toContainText("推定料金");
    await expect(page.locator("#ai-usage")).toContainText("4 / 50 回");
    await expect(page.locator("#ai-usage")).toContainText("¥12.39");
  });

  test("利用コードは保存されない（画面の外にも残らない）", async ({ page }) => {
    await open(page);
    await page.fill("#ai-code", "my-code");
    await confirmText(page);
    await page.click("#ai-ask");
    await page.click("#ai-send");
    await expect(page.locator("#ai-message")).toContainText("受け取りました");
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie])).toEqual([0, 0, ""]);
  });

  test("文章を直すと、前のAIの解説は消える（古い解説を残さない）", async ({ page }) => {
    await open(page);
    await confirmText(page);
    await page.click("#ai-ask");
    await page.click("#ai-send");
    await expect(page.locator('[data-ai-body="meaning"]')).toContainText("光や音");
    await page.fill("#result", TEXT + "\nオ．追加");
    await expect(page.locator('[data-ai-body="meaning"] [data-pending="true"]')).toBeVisible();
    await expect(page.locator("#ai-result-note")).toBeHidden();
  });

  test("二重に押しても1回しか送らない", async ({ page }) => {
    api.explain = () => ({ status: 200, json: { ok: true, explanation: EXPLANATION, costJpy: 0.05, status: statusOf() } });
    await open(page);
    await confirmText(page);
    await page.click("#ai-ask");
    await page.locator("#ai-send").dblclick();
    await expect(page.locator("#ai-message")).toContainText("受け取りました");
    expect(posts).toHaveLength(1);
  });

  test("「すべて消去」で、解説・利用コード・確認画面も消える", async ({ page }) => {
    await open(page);
    await page.fill("#ai-code", "my-code");
    await confirmText(page);
    await page.click("#ai-ask");
    await page.click("#ai-send");
    await expect(page.locator('[data-ai-body="meaning"]')).toContainText("光や音");
    page.once("dialog", (d) => d.accept());
    await page.click("#clear-all");
    await expect(page.locator("#ai-code")).toHaveValue("");
    await expect(page.locator('[data-ai-body="meaning"] [data-pending="true"]')).toBeVisible();
    await expect(page.locator("#ai-confirm")).toBeHidden();
  });
});

test.describe("エラー時の安全な停止", () => {
  test("サーバーのエラーは、安全なメッセージだけ表示し、解説は作らず、再試行しない", async ({ page }) => {
    api.explain = () => ({ status: 502, json: { ok: false, code: "upstream_error", message: "AIとの通信でエラーが発生しました。もう一度お試しください。", status: statusOf({ todayCalls: 4 }) } });
    await open(page);
    await confirmText(page);
    await page.click("#ai-ask");
    await page.click("#ai-send");
    const msg = page.locator("#ai-message");
    await expect(msg).toContainText("AIとの通信でエラーが発生しました");
    await expect(msg).toHaveClass(/error/);
    await expect(page.locator('[data-ai-body] [data-pending="true"]')).toHaveCount(6);
    await expect(page.locator("#ai-result-note")).toBeHidden();
    expect(posts).toHaveLength(1);
    // AIなしの機能は使える
    await page.click("#analyze");
    await expect(page.locator("#tasks .task").first()).toBeVisible();
  });

  test("上限に達した応答（429）で、AIが停止中の表示になる", async ({ page }) => {
    api.explain = () => ({ status: 429, json: { ok: false, code: "budget_reached", message: "今月のAI利用額（推定）が、アプリ側の停止ラインに達したため、AIの利用を停止しています。", status: statusOf({ stopReason: "budget_reached", available: false }) } });
    await open(page);
    await confirmText(page);
    await page.click("#ai-ask");
    await page.click("#ai-send");
    await expect(page.locator("#sec-explain h2 .badge")).toHaveText("AI停止中");
    await expect(page.locator("#ai-ask")).toBeDisabled();
    await expect(page.locator("#ai-message")).toContainText("停止ライン");
  });

  test("通信できないとき（時間切れ・切断）は、メッセージを出して止まる。再試行しない", async ({ page }) => {
    api.explain = () => ({ abort: true });
    await open(page);
    await confirmText(page);
    await page.click("#ai-ask");
    api.status = () => ({ abort: true }); // サーバーが落ちている状態
    await page.click("#ai-send");
    await expect(page.locator("#ai-message")).toContainText("AIサーバーに接続できませんでした");
    expect(posts).toHaveLength(1);
    await expect(page.locator("#sec-explain h2 .badge")).toHaveText("AIにつながりません");
    await expect(page.locator("#ai-ask")).toBeDisabled(); // 状況を取り直せなければ、AIは使えない表示になる
  });

  test("サーバーのメッセージはHTMLとして実行されない", async ({ page }) => {
    api.explain = () => ({ status: 502, json: { ok: false, code: "x", message: '<img src=x onerror="window.__pwned=1">', status: statusOf() } });
    await open(page);
    await confirmText(page);
    await page.click("#ai-ask");
    await page.click("#ai-send");
    await expect(page.locator("#ai-message")).toContainText("<img");
    expect(await page.evaluate(() => !!window.__pwned || !!document.querySelector("#ai-message img"))).toBe(false);
  });
});

test.describe("接続先とAPIキー", () => {
  test("接続先は、同じサイトのパスか https（手元の試験だけ localhost の http）だけ", async ({ page }) => {
    await open(page, { endpoint: "" });
    const cases = [["", ""], ["/api", "/api"], ["/api/", "/api"], ["//evil.example/api", ""], ["http://evil.example/api", ""],
      ["https://ai.example.com/api/", "https://ai.example.com/api"], ["http://127.0.0.1:8787/api", "http://127.0.0.1:8787/api"],
      ["javascript:alert(1)", ""], ["data:text/html,x", ""], ["ftp://x/api", ""]];
    for (const [input, expected] of cases) {
      const got = await page.evaluate((v) => {
        document.querySelector('meta[name="classi-ai-endpoint"]').setAttribute("content", v);
        return window.__classiAssistant.ai.readAiEndpoint();
      }, input);
      expect(got, input).toBe(expected);
    }
  });

  test("画面のコードにAPIキーはなく、OpenAIには直接つながない", async ({ page }) => {
    await open(page);
    const html = await page.content();
    expect(html).not.toMatch(/sk-[A-Za-z0-9_-]{10,}/);
    expect(html).not.toContain("OPENAI_API_KEY");
    expect(html).not.toContain("api.openai.com");
    expect(html).not.toMatch(/Bearer\s/);
  });
});
