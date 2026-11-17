// iPadのSplit View（右側の細い画面）・スマートフォンの幅での画面テスト
// 幅は代表的な値：320・375（細い画面）、590（Split View 半分）、780（Split View の広い側）
const { test, expect } = require("@playwright/test");

const TEXT = "問3 次のうち、正しいものを選びなさい。\nア．光は直進する\nイ．音は真空中を伝わる\nウ．水は100℃で凍る\nエ．氷は水に浮く";
const WIDTHS = [320, 375, 590, 780];

for (const width of WIDTHS) {
  test.describe(`幅${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, hasTouch: true, isMobile: true });

    test.beforeEach(async ({ page }) => {
      await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
      await page.goto("/index.html");
      await page.evaluate((t) => window.__classiAssistant.showReading({
        text: t,
        uncertain: [{ text: "ウ．水は100℃で凍る", confidence: 52, words: [{ text: "100℃", confidence: 31 }] }],
      }), TEXT);
      await page.click("#analyze");
    });

    test("横スクロールが出ず、1列で表示される", async ({ page }) => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      const side = await page.locator(".col-side").boundingBox();
      const main = await page.locator(".col-main").boundingBox();
      expect(main.y).toBeGreaterThan(side.y);
      const wide = await page.$$eval(".card, .q-choices li, .review-row, textarea", (els) =>
        els.filter((e) => e.getBoundingClientRect().right > window.innerWidth + 0.5).map((e) => e.className || e.tagName));
      expect(wide).toEqual([]);
    });

    test("ボタン・入力欄が44px近く（40px以上）あり、押しやすい", async ({ page }) => {
      const small = await page.$$eval("button, input, select, textarea, .jump a", (els) =>
        els.filter((e) => e.offsetParent && e.getBoundingClientRect().height < 40).map((e) => e.outerHTML.slice(0, 80)));
      expect(small).toEqual([]);
    });

    test("文字が16px以上で、入力時に自動ズームされない", async ({ page }) => {
      const sizes = await page.$$eval("textarea, input[type=text], select", (els) => els.map((e) => parseFloat(getComputedStyle(e).fontSize)));
      for (const s of sizes) expect(s).toBeGreaterThanOrEqual(16);
    });

    test("ジャンプメニューで解説に移動でき、スクロールしても上に固定される", async ({ page }) => {
      await page.click('.jump a[href="#sec-explain"]');
      await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(200);
      // なめらかなスクロールが止まるまで待つ
      let last = -1;
      await expect.poll(async () => { const y = await page.evaluate(() => scrollY); const same = y === last; last = y; return same; }).toBe(true);
      const nav = await page.locator(".jump").boundingBox();
      expect(nav.y).toBeLessThanOrEqual(1);
      const target = await page.locator("#sec-explain").boundingBox();
      expect(target.y).toBeGreaterThanOrEqual(nav.y + nav.height - 2); // 固定メニューの下に隠れない
    });

    test("右側の画面だけで、読み取り結果の確認から解説まで操作できる", async ({ page }) => {
      await page.click('#review [data-action="mark-ok"]');
      await page.click("#confirm-text");
      await expect(page.locator("#confirm-state")).toContainText("確認済み");
      await expect(page.locator("#ex-question-body .q-choices li")).toHaveCount(4);
      await expect(page.locator("#sec-explain .badge.b-pre")).toBeVisible();
    });
  });
}
