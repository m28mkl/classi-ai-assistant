// OCR（tesseract.js 5.1.1）の読み込み・Worker管理・エラー処理・実際の文字認識のテスト
//
// A〜C: 読み込み処理とエラー処理（ライブラリ本体は本物、必要に応じて window.Tesseract を偽物に差し替え）
// D   : 実際のOCR。npm公式レジストリから取得した本物のライブラリ・Worker・エンジン・日本語/英語の言語データを、
//       CDNの固定URLへの要求に対して返す（cdn.jsdelivr.net には通信しない）
// E   : CDN上の本物を使った確認。インターネット接続が必要なので OCR_ONLINE=1 のときだけ実行（GitHub Actions で実行）
//
// Safari と同じエンジン（WebKit）でも OCR_WEBKIT=1 で実行できる（GitHub Actions で実行）。
const { test, expect } = require("@playwright/test");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { OCR_URLS, isAllowedOcrUrl, localAsset, fulfillLocal } = require("./helpers/ocr-assets");
const { installFakeTesseract, TINY_PNG } = require("./helpers/fake-tesseract");

const NOW = new Date("2026-11-16T10:00:00+09:00");
const SAMPLE = path.join(__dirname, "fixtures", "ocr-sample-ja.png");
const INDEX_HTML = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const MSG = {
  LIB_LOAD: "OCRライブラリを読み込めませんでした",
  LIB_INVALID: "createWorker が見つかりません",
  WORKER_INIT: "OCRの準備（エンジン・言語データの読み込み）に失敗しました",
  TIMEOUT: "OCRの処理が途中で止まりました",
  IMAGE: "画像を開けませんでした",
  RECOGNIZE: "文字の認識中にエラーが発生しました",
};

const flat = (s) => s.replace(/\s+/g, "");

/**
 * ネットワークの準備。127.0.0.1 以外への http(s) 通信はすべて記録し、OCR関連の固定URLだけを許可する。
 * blob: や data: のURL（端末内のメモリ上のデータ。tesseract.js は blob: URL で Web Worker を起動する）は
 * 外部への通信ではないので対象にしない（WebKit ではこれらもルートの対象になるため、http(s) だけに限定する）。
 * - assets: "local"（node_modules の本物を返す）／"online"（本物のCDNへ通信する）
 * - block : 指定した種類（"library" | "lang"）の取得を失敗させる
 * - tamper: ライブラリの中身を書き換えて返す（SRIの確認用）
 * - delayMs: ライブラリの応答を遅らせる
 */
async function setupNetwork(context, { assets = "local", block = [], tamper = false, delayMs = 0 } = {}) {
  const external = [];
  await context.route(/^https?:\/\//, async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith("http://127.0.0.1")) return route.continue();
    external.push({ url, method: req.method(), body: req.postData() });
    if (!isAllowedOcrUrl(url)) return route.abort();
    if (block.includes("library") && url === OCR_URLS.library) return route.abort();
    if (block.includes("lang") && /traineddata/.test(url)) return route.abort();
    if (url === OCR_URLS.library && delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (tamper && url === OCR_URLS.library) {
      const body = "window.__tampered = true;\n" + fs.readFileSync(localAsset(url).file, "utf8");
      return route.fulfill({ status: 200, contentType: "text/javascript", headers: { "Access-Control-Allow-Origin": "*" }, body });
    }
    return assets === "online" ? route.continue() : fulfillLocal(route, url);
  });
  return external;
}

/** 外部通信が「OCR関連の固定URLへのGET（送信データなし）」だけであることを確認 */
function expectOnlyOcrDownloads(external) {
  for (const r of external) {
    expect(isAllowedOcrUrl(r.url), `許可されていない外部通信: ${r.url}`).toBe(true);
    expect(r.method).toBe("GET");
    expect(r.body).toBeNull();
  }
}

let pageErrors;
test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.clock.install({ time: NOW });
});
test.afterEach(() => {
  expect(pageErrors, "未処理のJavaScriptエラーがない").toEqual([]);
});

async function selectAndRead(page, file = TINY_PNG) {
  await page.setInputFiles("#image", file);
  await page.click("#read");
}

/** OCRが終わる（完了またはエラー）まで待ち、完了していることを確認する。エラーならすぐに失敗させる */
async function expectOcrDone(page, timeout = 150000) {
  const status = page.locator("#status");
  await expect(status).toHaveText(/読み取り完了！|読み取りエラー/, { timeout });
  await expect(status).toHaveText("読み取り完了！", { timeout: 1 });
}

/** 動作チェックが終わるまで待ち、「成功」であることを確認する */
async function expectSelftestOk(page, timeout = 150000) {
  const verdict = page.locator("#selftest-result .verdict");
  await expect(verdict).toBeVisible({ timeout });
  await expect(verdict, await page.locator("#selftest-result").textContent()).toHaveAttribute("data-result", "ok");
}

async function expectIdle(page) {
  await expect(page.locator("#read")).toBeEnabled();
  await expect(page.locator("#image")).toBeEnabled();
  await expect(page.locator("#ocr-selftest")).toBeEnabled();
  await expect(page.locator("#read")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#ocr-progress")).toBeHidden();
}

/* ======================= A. ライブラリの読み込み ======================= */
test.describe("A. OCRライブラリの読み込み", () => {
  test("ESM版や範囲指定のバージョン（@5 など）を使わず、すべて固定バージョンのURLになっている", () => {
    // コメント（不具合の説明）ではなく、URLなどの文字列として ESM 版を使っていないこと
    expect(INDEX_HTML).not.toMatch(/["'`][^"'`\n]*tesseract\.esm/);
    expect(INDEX_HTML).not.toMatch(/import\s*\(\s*["']https?:/);
    const urls = INDEX_HTML.match(/https:\/\/cdn\.jsdelivr\.net\/npm\/[^"'`\s]+/g);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u, `バージョン固定されていないURL: ${u}`).toMatch(/@\d+\.\d+\.\d+(\/|$)/);
  });

  test("SRIのハッシュが npm 公開版 tesseract.js@5.1.1 の tesseract.min.js と一致する", async ({ page, context }) => {
    await setupNetwork(context);
    await page.goto("/index.html");
    const config = await page.evaluate(() => window.__classiAssistant.ocr.config);
    const file = fs.readFileSync(localAsset(OCR_URLS.library).file);
    const expected = "sha384-" + crypto.createHash("sha384").update(file).digest("base64");
    expect(config.libraryIntegrity).toBe(expected);
    expect(config.libraryUrl).toBe(OCR_URLS.library);
    expect(config.version).toBe(require("tesseract.js/package.json").version);
  });

  test("UMD版を <script>（SRI付き）で読み込み、createWorker を関数として取得できる", async ({ page, context }) => {
    const external = await setupNetwork(context);
    await page.goto("/index.html");
    const result = await page.evaluate(async () => {
      const T = await window.__classiAssistant.ocr.loadTesseract();
      const again = await window.__classiAssistant.ocr.loadTesseract();
      const s = document.querySelector("script[data-ocr-library]");
      return { type: typeof T.createWorker, same: T === again, src: s.src, integrity: s.integrity, crossOrigin: s.crossOrigin, count: document.querySelectorAll("script[data-ocr-library]").length };
    });
    expect(result.type).toBe("function");
    expect(result.same).toBe(true); // 2回目以降は読み込み済みのものを使う
    expect(result.count).toBe(1);
    expect(result.src).toBe(OCR_URLS.library);
    expect(result.integrity).toMatch(/^sha384-/);
    expect(result.crossOrigin).toBe("anonymous");
    expect(external.map((r) => r.url)).toEqual([OCR_URLS.library]);
  });

  test("createWorker が undefined のとき、分かりやすいエラーを表示し、ボタンが元に戻る", async ({ page, context }) => {
    await installFakeTesseract(page, { mode: "no-createWorker" });
    await setupNetwork(context);
    await page.goto("/index.html");
    await selectAndRead(page);
    const status = page.locator("#status");
    await expect(status).toContainText("読み取りエラー：");
    await expect(status).toContainText(MSG.LIB_INVALID);
    await expect(status).toHaveClass(/error/);
    await expectIdle(page);
    await expect(page.locator("#history")).toContainText("画像の読み取りに失敗");
    // 結果欄は書き換えない
    await expect(page.locator("#result")).toHaveValue("");
  });

  test("ライブラリを取得できないとき分かりやすいエラーを表示し、通信が戻れば再試行で成功する", async ({ page, context }) => {
    await installFakeTesseract(page, { text: "数学 課題 11/30" });
    let offline = true;
    await setupNetwork(context);
    // 後から登録したルートが先に判定される：オフラインの間だけライブラリの取得を失敗させる
    await context.route(OCR_URLS.library, (route) => (offline ? route.abort() : route.fallback()));
    await page.goto("/index.html");
    await selectAndRead(page);
    await expect(page.locator("#status")).toContainText(MSG.LIB_LOAD);
    await expectIdle(page);
    offline = false;
    await page.click("#read");
    await expect(page.locator("#status")).toHaveText("読み取り完了！");
    await expect(page.locator("#result")).toHaveValue("数学 課題 11/30");
  });

  test("改ざんされたライブラリ（SRI不一致）は実行せず、エラーを表示する", async ({ page, context }) => {
    await setupNetwork(context, { tamper: true });
    await page.goto("/index.html");
    await selectAndRead(page);
    await expect(page.locator("#status")).toContainText(MSG.LIB_LOAD);
    expect(await page.evaluate(() => window.__tampered === true || typeof window.Tesseract !== "undefined")).toBe(false);
    await expectIdle(page);
  });

  test("読み込み中は「画像を読み取る」・画像選択・動作チェックのボタンが無効になる", async ({ page, context }) => {
    await installFakeTesseract(page, { text: "数学 課題 11/30" });
    await setupNetwork(context, { delayMs: 1500 });
    await page.goto("/index.html");
    await selectAndRead(page);
    await expect(page.locator("#read")).toBeDisabled();
    await expect(page.locator("#image")).toBeDisabled();
    await expect(page.locator("#ocr-selftest")).toBeDisabled();
    await expect(page.locator("#read")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#ocr-progress")).toBeVisible();
    await expect(page.locator("#status")).toContainText("OCRライブラリを読み込み中");
    await expect(page.locator("#status")).toHaveText("読み取り完了！", { timeout: 10000 });
    await expectIdle(page);
  });

  test("ボタンを連打しても読み取りは1回だけ行われる", async ({ page, context }) => {
    await installFakeTesseract(page, { text: "数学 課題 11/30", delayMs: 300 });
    await setupNetwork(context);
    await page.goto("/index.html");
    await page.setInputFiles("#image", TINY_PNG);
    await page.evaluate(() => { const b = document.getElementById("read"); b.click(); b.click(); b.click(); });
    await expect(page.locator("#status")).toHaveText("読み取り完了！");
    expect(await page.evaluate(() => window.__ocrCalls.createWorker.length)).toBe(1);
  });
});

/* ======================= B. Workerの初期化と終了 ======================= */
test.describe("B. Workerの初期化と終了", () => {
  test("日本語＋英語・固定バージョンのWorker/エンジンでWorkerを作り、終わったら終了する", async ({ page, context }) => {
    await installFakeTesseract(page, { text: "数学 課題 11/30" });
    await setupNetwork(context);
    await page.goto("/index.html");
    await selectAndRead(page);
    await expect(page.locator("#status")).toHaveText("読み取り完了！");
    const calls = await page.evaluate(() => window.__ocrCalls);
    expect(calls.createWorker).toEqual([{
      langs: "jpn+eng",
      oem: 1,
      workerPath: OCR_URLS.worker,
      corePath: OCR_URLS.coreDir.replace(/\/$/, ""),
    }]);
    expect(calls.recognize).toBe(1);
    expect(calls.terminate).toBe(1);
  });

  test("認識に失敗してもWorkerを終了し、分かりやすいエラーを表示する", async ({ page, context }) => {
    await installFakeTesseract(page, { mode: "recognize-fail" });
    await setupNetwork(context);
    await page.goto("/index.html");
    await selectAndRead(page);
    await expect(page.locator("#status")).toContainText(MSG.RECOGNIZE);
    expect(await page.evaluate(() => window.__ocrCalls.terminate)).toBe(1);
    await expectIdle(page);
  });

  test("Workerの初期化に失敗したとき、分かりやすいエラーを表示する", async ({ page, context }) => {
    await installFakeTesseract(page, { mode: "init-fail" });
    await setupNetwork(context);
    await page.goto("/index.html");
    await selectAndRead(page);
    await expect(page.locator("#status")).toContainText(MSG.WORKER_INIT);
    await expectIdle(page);
  });

  test("初期化が途中で止まったら、時間切れのエラーを表示してボタンを戻す", async ({ page, context }) => {
    await installFakeTesseract(page, { mode: "init-hang" });
    await setupNetwork(context);
    await page.goto("/index.html");
    await selectAndRead(page);
    await expect.poll(() => page.evaluate(() => window.__ocrCalls.createWorker.length)).toBe(1);
    await page.clock.runFor(91000);
    await expect(page.locator("#status")).toContainText(MSG.TIMEOUT);
    await expectIdle(page);
  });
});

/* ======================= C. 画像 ======================= */
test.describe("C. 画像の準備", () => {
  test("開けない画像は、ライブラリを取得する前に分かりやすいエラーを表示する", async ({ page, context }) => {
    const external = await setupNetwork(context);
    await page.goto("/index.html");
    await selectAndRead(page, { name: "broken.png", mimeType: "image/png", buffer: Buffer.from("not an image") });
    await expect(page.locator("#status")).toContainText(MSG.IMAGE);
    await expectIdle(page);
    expect(external).toEqual([]);
  });
});

/* ======================= D. 実際のOCR（本物のtesseract.js・オフライン） ======================= */
test.describe("D. 実際のOCR（本物のライブラリ・エンジン・言語データ）", () => {
  test.setTimeout(180000);

  test("スクリーンショットの日本語・英語を読み取り、課題カードに期限が付く", async ({ page, context }) => {
    const external = await setupNetwork(context);
    await page.goto("/index.html");
    await selectAndRead(page, SAMPLE);
    await expectOcrDone(page);

    const text = await page.inputValue("#result");
    const f = flat(text);
    for (const word of ["課題プリント", "提出期限", "2026年11月20日", "17:00", "保護者会", "お知らせ"]) {
      expect(f, `「${word}」を読み取れていない\n${text}`).toContain(word);
    }
    expect(text).toMatch(/English/i);
    // OCR特有の「1文字ずつの空白」が取り除かれている
    expect(text).toContain("保護者会");

    await page.click("#analyze");
    const task = page.locator("#tasks .task", { hasText: "課題プリント" });
    await expect(task.locator(".task-due")).toContainText("2026年11月20日（金） 17:00");
    await expect(task.locator(".badge").first()).toHaveText("課題");
    await expect(page.locator("#tasks .task", { hasText: "保護者会" }).locator(".badge")).toContainText(["お知らせ", "重要"]);

    // Workerは終了している
    await expect.poll(() => page.workers().length).toBe(0);
    expectOnlyOcrDownloads(external);
    const kinds = external.map((r) => r.url);
    expect(kinds).toContain(OCR_URLS.library);
    expect(kinds).toContain(OCR_URLS.worker);
    expect(kinds).toContain(OCR_URLS.jpn);
    expect(kinds).toContain(OCR_URLS.eng);

    // 2回目は言語データをダウンロードし直さない（ブラウザ内のキャッシュを使う）
    await page.click("#read");
    await expectOcrDone(page);
    expect(external.filter((r) => r.url === OCR_URLS.jpn).length).toBe(1);
    expect(external.filter((r) => r.url === OCR_URLS.eng).length).toBe(1);
  });

  test("「動作チェック」で、この端末で作ったサンプル画像を読み取り「成功」と表示する", async ({ page, context }) => {
    const external = await setupNetwork(context);
    await page.goto("/index.html");
    await page.click(".selftest summary");
    await page.click("#ocr-selftest");
    await expect(page.locator("#ocr-selftest")).toBeDisabled();
    await expectSelftestOk(page);
    await expect(page.locator("#selftest-result")).toContainText("Tesseract.js 5.1.1");
    await expect(page.locator("#history")).toContainText("OCRの動作チェック：成功");
    await expectIdle(page);
    expectOnlyOcrDownloads(external);
  });

  test("言語データを取得できないとき、分かりやすいエラーを表示し、Workerを残さない", async ({ page, context }) => {
    await setupNetwork(context, { block: ["lang"] });
    await page.goto("/index.html");
    await selectAndRead(page, SAMPLE);
    await expect(page.locator("#status")).toContainText(MSG.WORKER_INIT, { timeout: 60000 });
    await expectIdle(page);
    await expect.poll(() => page.workers().length).toBe(0);
  });
});

/* ======================= E. CDN上の本物（インターネット接続が必要） ======================= */
test.describe("E. CDN上の本物での確認（OCR_ONLINE=1）", () => {
  test.skip(!process.env.OCR_ONLINE, "インターネット接続が必要なため OCR_ONLINE=1 のときだけ実行");
  test.setTimeout(240000);

  test("CDNのライブラリがSRIと一致し、Worker・エンジン・言語データを取得できる", async ({ request }) => {
    const lib = await request.get(OCR_URLS.library);
    expect(lib.status()).toBe(200);
    const integrity = "sha384-" + crypto.createHash("sha384").update(await lib.body()).digest("base64");
    expect(INDEX_HTML).toContain(integrity);
    for (const url of [
      OCR_URLS.worker,
      OCR_URLS.coreDir + "tesseract-core-simd-lstm.wasm.js",
      OCR_URLS.coreDir + "tesseract-core-lstm.wasm.js",
      OCR_URLS.jpn,
      OCR_URLS.eng,
    ]) {
      const res = await request.head(url);
      expect(res.status(), url).toBe(200);
    }
  });

  test("CDNから読み込んで、スクリーンショットを実際に読み取れる", async ({ page, context }) => {
    const external = await setupNetwork(context, { assets: "online" });
    await page.goto("/index.html");
    await selectAndRead(page, SAMPLE);
    await expectOcrDone(page, 200000);
    const f = flat(await page.inputValue("#result"));
    for (const word of ["課題プリント", "提出期限", "2026年11月20日", "保護者会"]) expect(f).toContain(word);
    expectOnlyOcrDownloads(external);
  });

  test("CDNから読み込んで、動作チェックが「成功」になる", async ({ page, context }) => {
    await setupNetwork(context, { assets: "online" });
    await page.goto("/index.html");
    await page.click(".selftest summary");
    await page.click("#ocr-selftest");
    await expectSelftestOk(page, 200000);
  });
});
