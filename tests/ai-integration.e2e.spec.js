// 画面 ↔ 本物のAI解説サーバー（server/）↔ 偽のOpenAI をつないだ通しのテスト（iPad Air 縦・横）。
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { startFakeOpenAI } = require("./helpers/fake-openai");
const { loadConfig } = require("../server/config");
const { createServer } = require("../server/index");

const KEY = "sk-test-SECRET-KEY-123";
const CODE = "integration-code";
const TEXT = "問3 次のうち、正しいものを選びなさい。\nア．光は直進する\nイ．音は真空中を伝わる";

let fake, server, dir, base;

test.beforeEach(async () => {
  fake = await startFakeOpenAI();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "classi-ai-int-"));
  const config = loadConfig({ OPENAI_API_KEY: KEY, ACCESS_CODE: CODE, OPENAI_BASE_URL: fake.url, DATA_DIR: dir, SERVE_STATIC: "1" });
  ({ server } = createServer(config));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterEach(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  await fake.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function prepare(page) {
  const bodies = [];
  page.on("response", async (res) => { if (res.url().startsWith(base)) bodies.push(await res.text().catch(() => "")); });
  await page.goto(`${base}/`);
  await expect(page.locator("#sec-explain h2 .badge")).toHaveText("AI接続済み");
  await page.evaluate((t) => window.__classiAssistant.showReading({ text: t, uncertain: [] }), TEXT);
  await page.click("#confirm-text");
  await page.click("#ai-ask");
  return bodies;
}

test("サーバーから画面を配ると接続先が /api になり、確認→送信→解説の表示までできる", async ({ page }) => {
  const bodies = await prepare(page);
  await expect(page.locator("#ai-usage")).toContainText("0 / 50 回");
  await page.fill("#ai-code", CODE);
  await page.click("#ai-send");
  await expect(page.locator("#ai-message")).toContainText("AIの解説を受け取りました");
  await expect(page.locator('[data-ai-body="meaning"]')).toContainText("光の進み方");
  await expect(page.locator("#ai-usage")).toContainText("1 / 50 回");
  // OpenAIに届いた内容は、確認画面の内容だけ
  const sent = fake.responsesCalls();
  expect(sent).toHaveLength(1);
  expect(sent[0].body.input).toContain("ア．光は直進する");
  expect(sent[0].body.max_output_tokens).toBe(800);
  // 画面に届いたどの応答にも、APIキー・利用コードは入っていない
  for (const b of bodies) { expect(b).not.toContain(KEY); expect(b).not.toContain(CODE); }
  expect(await page.content()).not.toContain(KEY);
});

test("利用コードが違うと、OpenAIには何も送らず、分かりやすく表示する", async ({ page }) => {
  await prepare(page);
  await page.fill("#ai-code", "wrong");
  await page.click("#ai-send");
  await expect(page.locator("#ai-message")).toContainText("利用コードが違います");
  expect(fake.requests).toHaveLength(0);
});
