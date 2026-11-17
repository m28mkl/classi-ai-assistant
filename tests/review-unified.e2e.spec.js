// 「要確認」を1か所（② 読み取った情報の確認・修正）にまとめた表示の画面テスト（iPad Air 縦・横）
// 改善版OCRの結果（位置情報つき）を偽物で作り、読み取りボタンと同じ処理（showOcrResult）で画面に反映する。
const { test, expect } = require("@playwright/test");

let jsErrors;
let requests;

test.beforeEach(async ({ page }) => {
  jsErrors = [];
  requests = [];
  page.on("pageerror", (e) => jsErrors.push(e.message));
  await page.route(/^https?:\/\//, (route) => {
    const url = route.request().url();
    if (url.startsWith("http://127.0.0.1")) return route.continue();
    requests.push(url);
    return route.abort();
  });
  await page.goto("/index.html");
});

test.afterEach(() => {
  expect(jsErrors).toEqual([]);
  expect(requests, "外部への通信がない").toEqual([]);
});

/** 改善版OCRの結果の偽物（架空の問題）を、読み取りボタンと同じ処理で反映する */
const showFakeOcr = (page) => page.evaluate(() => {
  const c = document.createElement("canvas");
  c.width = 800;
  c.height = 200;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 800, 200);
  ctx.fillStyle = "#000";
  ctx.font = "28px sans-serif";
  ctx.fillText("問1 次の文を書き換えなさい。", 10, 40);
  ctx.fillText("He is the man. I spoke to him.", 10, 90);
  ctx.fillText("⇒ He is the man to whom I spoke.", 10, 140);
  const lines = [
    { text: "問1 次の文を書き換えなさい。", parts: [{ confidence: 96 }], rect: { x: 10, y: 15, w: 420, h: 34 } },
    { text: "He is the man. I spoke to him.", parts: [{ confidence: 62 }], rect: { x: 10, y: 65, w: 430, h: 34 } },
    { text: "⇒ He is the man to whom I spoke.", parts: [{ confidence: 91 }], rect: { x: 10, y: 115, w: 470, h: 34 } },
  ];
  const text = lines.map((l) => l.text).join("\n");
  window.__classiAssistant.showOcrResult({
    text, raw: text.replace("I spoke", "l spoke"), beforeFix: text.replace("I spoke", "l spoke"),
    structured: null, lines, layout: { excluded: [] }, source: c,
    uncertain: [{ text: "spoke", confidence: 55, line: 1, rect: { x: 180, y: 65, w: 80, h: 34 } }],
    changes: [
      { from: "l", to: "I", reason: "英単語に挟まれた単独の「l」を代名詞の I と判断" },
      { from: "=", to: "⇒", reason: "行頭の記号「=」を書き換えの矢印「⇒」と判断（要確認）", uncertain: true },
    ],
  });
});

test("要確認は②の1か所だけに表示され、元の画像の切り抜きと確信度が付く", async ({ page }) => {
  await showFakeOcr(page);
  const rows = page.locator("#sec-result #review .review-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("He is the man. I spoke to him.");
  await expect(rows.first()).toContainText("自信度 62%");
  const crop = rows.first().locator(".crop");
  await expect(crop).toHaveCount(1);
  await expect(crop).toContainText("「spoke」 確信度 55%");
  expect(await crop.locator("canvas").count()).toBe(1);
  // 以前あった別の一覧はなく、右側に「要確認」の一覧が出ない
  await expect(page.locator("#review-uncertain")).toHaveCount(0);
  await expect(page.locator(".col-main .review-row")).toHaveCount(0);
});

test("推測で直したところは要確認の一覧に、決まったルールで直したところは「くわしい確認」に出る", async ({ page }) => {
  await showFakeOcr(page);
  await expect(page.locator("#review-guess li")).toHaveCount(1);
  await expect(page.locator("#review-guess li")).toContainText("「=」→「⇒」");
  await expect(page.locator("#review-guess li")).toContainText("要確認");
  await expect(page.locator("#review-changes li")).toHaveCount(1);
  await expect(page.locator("#review-changes li")).toContainText("代名詞の I");
  await expect(page.locator("#review-changes-count")).toHaveText("1件");
});

test("くわしい確認（元の画像・比較）は②の中にあり、開いたり閉じたりできる", async ({ page }) => {
  await showFakeOcr(page);
  const detail = page.locator("#sec-result #ocr-review");
  await expect(detail).toBeVisible();
  await expect(page.locator("#review-canvas")).toBeVisible();
  await page.click("#review-title");
  await expect(page.locator("#review-canvas")).toBeHidden();
  await page.click("#review-title");
  await expect(page.locator("#review-canvas")).toBeVisible();
});

test("くわしい確認で直して反映すると、手で直したときと同じく確認がやり直しになる", async ({ page }) => {
  await showFakeOcr(page);
  page.once("dialog", (d) => d.accept()); // 要確認が残っているときの確認
  await page.click("#confirm-text");
  await expect(page.locator("#confirm-state")).toContainText("確認済み");
  await page.fill('#ocr-review [data-field="body"]', "問1 次の文を書き換えなさい。\nHe is the man. I spoke to him yesterday.\n⇒ He is the man to whom I spoke.");
  await page.click("#review-apply");
  await expect(page.locator("#result")).toHaveValue(/yesterday/);
  await expect(page.locator("#confirm-state")).not.toContainText("確認済み");
  await expect(page.locator("#review .review-row .badge")).toHaveText("修正済み");
});

test("「合っている」を押すと確認済みになり、切り抜きは消える", async ({ page }) => {
  await showFakeOcr(page);
  await page.click('#review [data-action="mark-ok"]');
  await expect(page.locator("#review .review-row .badge")).toHaveText("確認済み");
  await expect(page.locator("#review .review-row .crop")).toHaveCount(0);
  await expect(page.locator("#confirm-state")).not.toContainText("要確認");
});

test("「すべて消去」で、くわしい確認も消える", async ({ page }) => {
  await showFakeOcr(page);
  page.once("dialog", (d) => d.accept());
  await page.click("#clear-all");
  await expect(page.locator("#ocr-review")).toBeHidden();
  await expect(page.locator("#review-guess")).toHaveCount(0);
});

test("横スクロールが出ない", async ({ page }) => {
  await showFakeOcr(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
