// Classi の実画像（iPad Air のスクリーンショット）を使った OCR 精度のテスト
//
// - tests/fixtures/classi-q01.png … 実際の Classi の画面（個人情報なし）
// - tests/fixtures/classi-q01.expected.json … 評価用の正解データ
// - 本物の tesseract.js 5.1.1・エンジン・日本語/英語の言語データ（npm 公式レジストリから取得したもの）を、
//   CDN の固定URLへの要求に対して返す（cdn.jsdelivr.net には通信しない）
// - 改善前（画像全体を jpn+eng で1回読むだけの従来の方法）と改善後を、正解データとの文字誤り率（CER）で比べる
// - Chromium と WebKit（Safari と同じエンジン、OCR_WEBKIT=1）の両方で実行する
const { test, expect } = require("@playwright/test");
const path = require("path");
const { isAllowedOcrUrl, fulfillLocal } = require("./helpers/ocr-assets");
const ev = require("./helpers/ocr-eval");
const EXPECTED = require("./fixtures/classi-q01.expected.json");

const CLASSI = path.join(__dirname, "fixtures", "classi-q01.png");
const SAMPLE_TEXT = "お知らせ・課題一覧\n数学 課題プリント3\n提出期限：2026年11月20日 17:00\n【重要】保護者会のお知らせ\nEnglish Homework p.10";
const JA_FIELDS = ["title", "instruction", "subNumber", "subInstruction", "direction"];
const EN_FIELDS = ["english", "rewrite", "choiceア", "choiceイ", "choiceウ", "choiceエ"];
const pct = (v) => (v * 100).toFixed(1) + "%";

/** 127.0.0.1 以外への http(s) 通信を記録し、OCR関連の固定URLだけに本物のファイルを返す */
async function setupNetwork(context) {
  const external = [];
  await context.route(/^https?:\/\//, (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith("http://127.0.0.1")) return route.continue();
    external.push({ url, method: req.method(), body: req.postData() });
    return isAllowedOcrUrl(url) ? fulfillLocal(route, url) : route.abort();
  });
  return external;
}

function expectOnlyOcrDownloads(external) {
  for (const r of external) {
    expect(isAllowedOcrUrl(r.url), `許可されていない外部通信: ${r.url}`).toBe(true);
    expect(r.method).toBe("GET");
    expect(r.body).toBeNull();
  }
}

/**
 * ページ内で OCR を実行する。
 * mode: "legacy"（改善前：画像全体を jpn+eng で1回）| "pipeline"（改善後）
 * variant: 画像の変形（"original" | "scale75" | "scale50" | "noStatusBar" | "wideMargins"）
 */
function runInPage(page, { fixture = "classi-q01.png", mode = "pipeline", variant = "original", options = {} } = {}) {
  return page.evaluate(async ({ fixture, mode, variant, options }) => {
    const T = await window.__classiAssistant.ocr.loadTesseract();
    const cfg = window.__classiAssistant.ocr.config;
    const img = await createImageBitmap(await (await fetch("/tests/fixtures/" + fixture)).blob());
    const W = img.width, H = img.height;
    const sizes = { original: [W, H], scale75: [W * 0.75, H * 0.75], scale50: [W * 0.5, H * 0.5], noStatusBar: [W, H - 70], wideMargins: [W + 800, H] };
    const [cw, ch] = sizes[variant].map(Math.round);
    const c = document.createElement("canvas");
    c.width = cw; c.height = ch;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.fillStyle = "#fff"; x.fillRect(0, 0, cw, ch);
    if (variant === "noStatusBar") x.drawImage(img, 0, -70);
    else if (variant === "wideMargins") x.drawImage(img, 400, 0);
    else x.drawImage(img, 0, 0, cw, ch);
    const hash = () => { const d = x.getImageData(0, 0, cw, ch).data; let h = 0; for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) >>> 0; return h; };
    const before = hash();
    const worker = await T.createWorker("jpn+eng", 1, { workerPath: cfg.workerPath, corePath: cfg.corePath });
    const t0 = performance.now();
    let text;
    let r = null;
    try {
      if (mode === "legacy") {
        const { data } = await worker.recognize(c);
        text = window.__classiAssistant.ocr.cleanupOcrText(data.text || "");
      } else {
        r = await window.ClassiOcr.runPipeline(worker, c, options);
        text = r.text;
      }
    } finally {
      await worker.terminate();
    }
    return { text, ms: Math.round(performance.now() - t0), unchanged: hash() === before, variantsUsed: r?.variantsUsed, structured: r?.structured };
  }, { fixture, mode, variant, options });
}

let pageErrors;
test.beforeEach(({ page }) => {
  pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
});
test.afterEach(() => expect(pageErrors, "未処理のJavaScriptエラーがない").toEqual([]));

/* ============ 画面からの読み取り（改善後）。1回読み取って結果を複数のテストで確認する ============ */
test.describe("Classi実画像：画面から読み取った結果（改善後）", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(180000);

  /** @type {import('@playwright/test').Page} */
  let page;
  let external;
  let text;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true });
    external = await setupNetwork(context);
    page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto("/index.html");
    await page.setInputFiles("#image", CLASSI);
    await page.click("#read");
    await expect(page.locator("#status")).toHaveText(/読み取り完了！|読み取りエラー/, { timeout: 150000 });
    text = await page.inputValue("#result");
  });
  test.afterAll(async () => { await page.context().close(); });

  test("読み取りが完了し、読み取り結果の確認画面が表示される", async () => {
    await expect(page.locator("#status")).toHaveText("読み取り完了！");
    await expect(page.locator("#review")).toBeVisible();
  });

  test("日本語（タイトル・問題文・小問・指示）を正しく読み取る（文字誤り率5%以下）", async () => {
    const e = ev.evaluate(EXPECTED, text);
    for (const k of JA_FIELDS) expect(e[k], `${k}\n${text}`).toBeLessThanOrEqual(0.05);
  });

  test("英文・書き換え・選択肢の英語を正しく読み取る（I と 1・l の取り違えなし）", async () => {
    const e = ev.evaluate(EXPECTED, text);
    for (const k of EN_FIELDS) expect(e[k], `${k}\n${text}`).toBe(0);
    expect(text).toContain("He is the man. I spoke to him yesterday.");
    expect(text).not.toMatch(/\b(1spoke|lspoke|tolspoke|to1spoke)\b/);
  });

  test("選択肢はア・イ・ウ・エの順番のまま、内容も画面どおり（文法の正誤は直さない）", async () => {
    expect(ev.choiceOrder(text)).toEqual(["ア", "イ", "ウ", "エ"]);
    const values = await page.locator("#review [data-choice]").evaluateAll((els) => els.map((e) => [e.dataset.choice, e.value]));
    expect(values).toEqual(EXPECTED.choices.map((c) => [c.label, c.text]));
  });

  test("問題文・英文・選択肢を混同せずに、確認画面の項目に分ける", async () => {
    const field = (k) => page.locator(`#review [data-field="${k}"]`).inputValue();
    expect(ev.fieldCer(EXPECTED.title, await field("title"), "ja")).toBeLessThanOrEqual(0.05);
    expect(ev.norm(await field("instruction"), "ja")).toBe(ev.norm(EXPECTED.instruction, "ja"));
    expect(await field("subNumber")).toBe(EXPECTED.subNumber);
    expect(ev.norm(await field("english"), "en")).toBe(ev.norm(EXPECTED.english, "en"));
    expect(ev.norm(await field("direction"), "ja")).toBe(ev.norm(EXPECTED.direction, "ja"));
    expect(ev.norm(await field("rewrite"), "en")).toBe(ev.norm(EXPECTED.rewrite, "en"));
    for (const c of EXPECTED.choices) {
      expect(await field("english")).not.toContain(c.text);
      expect(await field("subInstruction")).not.toContain(c.text);
    }
  });

  test("ステータスバー・ヘッダー・動画プレイヤー・回答ボタンの文字が入らない", async () => {
    for (const ui of EXPECTED.excludedUi) expect(text, ui).not.toContain(ui);
    // 下部の回答欄の「ア イ ウ エ」（選択肢の記号だけの行）が入らない
    expect(text.split("\n").filter((l) => /^[アイウエ\s]+$/.test(l.trim()))).toEqual([]);
  });

  test("自信がない部分は、元の画像から切り出して確信度と一緒に表示する", async () => {
    const items = page.locator("#review-uncertain li");
    const n = await items.count();
    expect(n).toBeGreaterThan(0);
    const withImage = await items.evaluateAll((els) => els.filter((li) => li.querySelector("canvas") && /確信度 \d+%/.test(li.textContent)).length);
    expect(withImage).toBe(n);
  });

  test("自動で直した箇所を表示し、推測で判断したもの（「=」→「⇒」など）は「要確認」とする", async () => {
    const changes = page.locator("#review-changes li");
    await expect(changes.filter({ hasText: "代名詞の I" }).first()).toBeVisible();
    await expect(changes.filter({ hasText: "⇒" })).toContainText("要確認");
  });

  test("元の画像と、除外した部分・読み取った行を重ねて表示する（元画像と結果を見比べられる）", async () => {
    const info = await page.evaluate(() => {
      const c = document.getElementById("review-canvas");
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      const px = (x, y) => { const i = (Math.round(y) * c.width + Math.round(x)) * 4; return [d[i], d[i + 1], d[i + 2]]; };
      // 画像の最上部（ステータスバー＝除外部分）は、元の青より暗く重ねて表示されている
      return { w: c.width, h: c.height, top: px(c.width / 2, 5), body: px(5, c.height / 3) };
    });
    expect(info.w / info.h).toBeCloseTo(2360 / 1640, 1);
    expect(info.top[2]).toBeLessThan(200); // 元の青（B≈233）が除外の色で暗くなっている
    expect(info.body).toEqual([255, 255, 255]); // 本文の背景は元のまま
  });

  test("修正前と修正後を比較でき、項目を直すと修正後に反映される", async () => {
    const diff = page.locator("#review-diff");
    await expect(diff.locator("div").first()).toContainText("修正前");
    await expect(diff.locator("del").first()).toBeVisible(); // 例：「|」→「I」
    await expect(diff.locator("ins").first()).toBeVisible();
    const choiceA = page.locator('#review [data-choice="ア"]');
    await choiceA.fill("to I spoke whom (edited)");
    await expect(diff.locator("div").nth(1)).toContainText("edited");
    await page.click("#review-apply");
    await expect(page.locator("#result")).toHaveValue(/ア to I spoke whom \(edited\)/);
    await expect(page.locator("#history")).toContainText("確認した内容を「読み取った情報」に反映");
    await choiceA.fill("to I spoke whom");
    await page.click("#review-apply");
  });

  test("外部への通信は OCR 関連の固定URLの取得だけ（画像や結果を送信しない）", async () => {
    expectOnlyOcrDownloads(external);
    expect(external.length).toBeGreaterThan(0);
  });
});

/* ============ 改善前と改善後の比較 ============ */
test.describe("Classi実画像：改善前と改善後の比較", () => {
  test.setTimeout(240000);

  test("改善後はすべての項目で改善前と同じか良く、全体の誤り率が下がる", async ({ page, context }, testInfo) => {
    const external = await setupNetwork(context);
    await page.goto("/index.html");
    const before = await runInPage(page, { mode: "legacy" });
    const after = await runInPage(page, { mode: "pipeline" });
    const eb = ev.evaluate(EXPECTED, before.text), ea = ev.evaluate(EXPECTED, after.text);
    const report = Object.keys(eb).map((k) => `${k.padEnd(15)} 改善前 ${pct(eb[k]).padStart(6)} → 改善後 ${pct(ea[k]).padStart(6)}`).join("\n");
    const totalBefore = ev.totalCer(ev.expectedText(EXPECTED), before.text);
    const totalAfter = ev.totalCer(ev.expectedText(EXPECTED), after.text);
    await testInfo.attach("改善前と改善後の比較", {
      contentType: "text/plain",
      body: `${report}\n全体（不要なUIの文字を含む） 改善前 ${pct(totalBefore)} → 改善後 ${pct(totalAfter)}\n\n--- 改善前（${before.ms}ms）\n${before.text}\n\n--- 改善後（${after.ms}ms）\n${after.text}\n`,
    });
    console.log(`[${testInfo.project.name}] 改善前と改善後の比較\n${report}\n全体 改善前 ${pct(totalBefore)} → 改善後 ${pct(totalAfter)}`);
    for (const k of Object.keys(eb)) expect(ea[k], k).toBeLessThanOrEqual(eb[k]);
    expect(ea.average).toBeLessThan(eb.average);
    expect(totalAfter).toBeLessThan(totalBefore);
    expectOnlyOcrDownloads(external);
  });

  test("UIのない画像（架空のサンプル）でも、改善前より精度が下がらない", async ({ page, context }) => {
    await setupNetwork(context);
    await page.goto("/index.html");
    const before = await runInPage(page, { fixture: "ocr-sample-ja.png", mode: "legacy" });
    const after = await runInPage(page, { fixture: "ocr-sample-ja.png", mode: "pipeline" });
    const cb = ev.totalCer(SAMPLE_TEXT, before.text), ca = ev.totalCer(SAMPLE_TEXT, after.text);
    expect(ca, `改善前 ${pct(cb)} / 改善後 ${pct(ca)}\n${after.text}`).toBeLessThanOrEqual(cb);
  });
});

/* ============ 前処理による精度の比較 ============ */
test.describe("画像の前処理による精度の比較", () => {
  test.setTimeout(240000);

  for (const [fixture, variant, label] of [
    ["classi-q01.png", "original", "Classi実画像"],
    ["classi-q01.png", "scale50", "Classi実画像を50%に縮小（文字が小さい場合）"],
    ["ocr-sample-ja.png", "original", "架空のサンプル"],
  ]) {
    test(`${label}：前処理あり（拡大・グレースケール・コントラスト・二値化の比較）は、前処理なし（等倍）より精度が下がらない`, async ({ page, context }, testInfo) => {
      await setupNetwork(context);
      await page.goto("/index.html");
      const raw = await runInPage(page, { fixture, variant, options: { preprocess: false } });
      const pre = await runInPage(page, { fixture, variant, options: { preprocess: true } });
      const expected = fixture === "classi-q01.png" ? ev.expectedText(EXPECTED) : SAMPLE_TEXT;
      const cRaw = ev.totalCer(expected, raw.text), cPre = ev.totalCer(expected, pre.text);
      console.log(`[${testInfo.project.name}] ${label}：前処理なし ${pct(cRaw)} / 前処理あり ${pct(cPre)}（採用：${JSON.stringify(pre.variantsUsed)}）`);
      expect(cPre, `前処理なし ${pct(cRaw)}\n${raw.text}\n\n前処理あり ${pct(cPre)}\n${pre.text}`).toBeLessThanOrEqual(cRaw);
    });
  }

  test("前処理は読み取り用のコピーに対して行い、元の画像は変更しない", async ({ page, context }) => {
    await setupNetwork(context);
    await page.goto("/index.html");
    const r = await runInPage(page, {});
    expect(r.unchanged).toBe(true);
  });
});

/* ============ 端末サイズ・画面構成が変わった場合 ============ */
test.describe("端末サイズや画面構成が変わっても読み取れる（固定座標に頼らない）", () => {
  test.setTimeout(300000);

  for (const variant of ["scale75", "scale50", "noStatusBar", "wideMargins"]) {
    const name = { scale75: "75%に縮小", scale50: "50%に縮小", noStatusBar: "ステータスバーなし", wideMargins: "左右に余白（横に広い画面）" }[variant];
    test(`${name}の画像でも、不要部分を除いて選択肢の順番どおりに読み取る`, async ({ page, context }) => {
      await setupNetwork(context);
      await page.goto("/index.html");
      const r = await runInPage(page, { variant });
      const e = ev.evaluate(EXPECTED, r.text);
      expect(e.average, r.text).toBeLessThanOrEqual(0.02);
      for (const k of EN_FIELDS) expect(e[k], `${k}\n${r.text}`).toBe(0);
      expect(ev.choiceOrder(r.text)).toEqual(["ア", "イ", "ウ", "エ"]);
      for (const ui of EXPECTED.excludedUi) expect(r.text).not.toContain(ui);
    });
  }
});
