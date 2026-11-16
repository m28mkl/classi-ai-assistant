// 実際のOCRテスト用のサンプル画像（架空の内容・個人情報なし）を作る。
// 使い方: node tests/fixtures/make-ocr-sample.js
// 生成済みの ocr-sample-ja.png をリポジトリに含めているので、通常は実行不要。
const { chromium } = require("@playwright/test");
const path = require("path");

const html = `<!doctype html><meta charset="utf-8">
<style>
  body { margin: 0; background: #fff; }
  .screen { width: 1000px; padding: 32px 40px; font-family: "IPAGothic", "Hiragino Sans", "Noto Sans CJK JP", sans-serif;
            color: #111; font-size: 34px; line-height: 1.7; }
  .head { font-weight: bold; font-size: 38px; border-bottom: 3px solid #333; margin-bottom: 12px; }
</style>
<div class="screen">
  <div class="head">お知らせ・課題一覧</div>
  <div>数学 課題プリント3</div>
  <div>提出期限：2026年11月20日 17:00</div>
  <div>【重要】保護者会のお知らせ</div>
  <div>English Homework p.10</div>
</div>`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.setContent(html);
  await page.locator(".screen").screenshot({ path: path.join(__dirname, "ocr-sample-ja.png") });
  await browser.close();
  console.log("tests/fixtures/ocr-sample-ja.png を作成しました");
})();
