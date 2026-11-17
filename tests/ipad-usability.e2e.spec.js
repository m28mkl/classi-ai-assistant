// iPad Air での使いやすさ（文字の大きさ・ホーム画面のアイコン・移動メニュー）の画面テスト（縦・横）
const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.route(/^https?:\/\//, (route) =>
    route.request().url().startsWith("http://127.0.0.1") ? route.continue() : route.abort());
  await page.goto("/index.html");
  await page.evaluate(() => window.__classiAssistant.showReading({ text: "問1 正しいものを選びなさい。\nア．光は直進する\nイ．音は真空中を伝わる", uncertain: [] }));
  await page.click("#ai-paste-mock");
});

test("表示されている文字は、どれも13px以上（小さすぎて読めない文字がない）", async ({ page }) => {
  const tooSmall = await page.evaluate(() => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent.trim()) continue;
      const el = node.parentElement;
      if (!el || !el.getClientRects().length) continue; // 表示されていない
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < 13) out.push(`${el.tagName}.${el.className}: ${size}px「${node.textContent.trim().slice(0, 20)}」`);
    }
    return out;
  });
  expect(tooSmall).toEqual([]);
});

test("ホーム画面に追加したときのアイコンと名前がある", async ({ page, request }) => {
  const href = await page.getAttribute('link[rel="apple-touch-icon"]', "href");
  const res = await request.get(href);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("image/png");
  expect(await page.getAttribute('meta[name="apple-mobile-web-app-title"]', "content")).toBe("Classi AI");
});

test("上の移動メニューから「回答」（貼り付け欄）へ移動できる", async ({ page }) => {
  await page.click('.jump a[href="#paste-details"]');
  await expect(page.locator("#paste-details")).toBeInViewport();
});
