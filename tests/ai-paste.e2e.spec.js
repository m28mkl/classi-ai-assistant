// AIの回答の貼り付け・模擬データ・回答の下書きの画面テスト（iPad Air 縦・横）
// OCRライブラリは使わず、window.__classiAssistant.showReading で「OCRの結果が出た状態」を作る。
// AIのAPIは使わない。外部への通信がないことも毎回確かめる。
const { test, expect } = require("@playwright/test");

const TEXT = "問3 次のうち、正しいものを選びなさい。\nア．光は直進する\nイ．音は真空中を伝わる\nウ．水は100℃で凍る\nエ．氷は水に浮く";

// Claudeアプリなどから貼り付けた想定の回答（架空・Markdown混じり）
const PASTED = [
  "はい、解説します。",
  "",
  "【問題の意味】",
  "光・音・水の性質について、正しいものを選ぶ問題です。",
  "",
  "【解き方・考え方】",
  "1. 選択肢を1つずつ確かめます。",
  "2. 間違っているものを消していきます。",
  "",
  "**重要ポイント**",
  "- 光は同じ物質の中を直進する",
  "- 音は真空中を伝わらない",
  "",
  "【回答候補】",
  "・ア",
  "・エ",
  "",
  "【回答の理由】",
  "アとエは正しい性質です。",
  "",
  "【間違えやすいポイント】",
  "音は真空中を伝わりません。",
].join("\n");

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

const show = (page) => page.evaluate((t) => window.__classiAssistant.showReading({ text: t, uncertain: [] }), TEXT);

test.describe("質問文（回答の形式つき）", () => {
  test("確認後にワンタップでコピーでき、回答の形式（見出し）が入る", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:8765" });
    await show(page);
    await page.click("#confirm-text");
    await page.click("#copy-explain");
    await expect(page.locator("#explain-status")).toContainText("コピーしました");
    const prompt = await page.inputValue("#explain-prompt");
    for (const h of ["【問題の意味】", "【解き方・考え方】", "【重要ポイント】", "【回答候補】", "【回答の理由】", "【間違えやすいポイント】", "【回答の下書き】"]) {
      expect(prompt).toContain(h);
    }
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(prompt);
  });
});

test.describe("AIの回答の貼り付け", () => {
  test("使ったAIを選べる（無料のものだけ。模擬データは別のボタン）", async ({ page }) => {
    const options = await page.locator("#ai-provider option").allTextContents();
    expect(options).toEqual(["Claude（アプリ・Web）", "ChatGPT（アプリ・Web）", "Gemini（アプリ・Web）", "その他のAI"]);
  });

  test("貼り付けた回答が、項目ごとに分かれて表示される", async ({ page }) => {
    await show(page);
    await page.fill("#ai-paste", PASTED);
    await page.click("#ai-paste-apply");
    await expect(page.locator('[data-ai-body="meaning"]')).toHaveText("光・音・水の性質について、正しいものを選ぶ問題です。");
    await expect(page.locator('[data-ai-body="method"]')).toContainText("2. 間違っているものを消していきます。");
    await expect(page.locator('[data-ai-body="points"] li')).toHaveText(["光は同じ物質の中を直進する", "音は真空中を伝わらない"]);
    await expect(page.locator('[data-ai-body="candidates"] li')).toHaveText(["ア", "エ"]);
    await expect(page.locator('[data-ai-body="reason"]')).toHaveText("アとエは正しい性質です。");
    await expect(page.locator('[data-ai-body="pitfalls"]')).toHaveText("音は真空中を伝わりません。");
    await expect(page.locator('[data-ai-body] [data-pending="true"]')).toHaveCount(0);
    await expect(page.locator("#ai-result-note")).toContainText("Claudeの回答を貼り付けて整理しました");
    await expect(page.locator("#ai-result-note")).toContainText("必ず自分で確認");
    await expect(page.locator("#ai-paste-status")).toContainText("見つからなかった項目：回答の下書き");
  });

  test("選んだAIの名前が表示される", async ({ page }) => {
    await show(page);
    await page.selectOption("#ai-provider", "chatgpt");
    await page.fill("#ai-paste", PASTED);
    await page.click("#ai-paste-apply");
    await expect(page.locator("#ai-result-note")).toContainText("ChatGPTの回答");
  });

  test("見出しがない回答は、全文を「解き方・考え方」に入れて知らせる", async ({ page }) => {
    await show(page);
    await page.fill("#ai-paste", "アが正しいです。光は直進するからです。");
    await page.click("#ai-paste-apply");
    await expect(page.locator('[data-ai-body="method"]')).toHaveText("アが正しいです。光は直進するからです。");
    await expect(page.locator('[data-ai-body="meaning"]')).toHaveText("（回答に含まれていませんでした）");
    await expect(page.locator("#ai-paste-status")).toContainText("見出しが見つからなかった");
  });

  test("空のまま押すと、案内を出して何もしない", async ({ page }) => {
    await page.click("#ai-paste-apply");
    await expect(page.locator("#ai-paste-status")).toHaveText("先にAIの回答を貼り付けてください");
    await expect(page.locator("#draft-box")).toBeHidden();
  });

  test("「貼り付けた回答を消す」で、表示も元に戻る", async ({ page }) => {
    await show(page);
    await page.fill("#ai-paste", PASTED);
    await page.click("#ai-paste-apply");
    await page.click("#ai-paste-clear");
    await expect(page.locator("#ai-paste")).toHaveValue("");
    await expect(page.locator('[data-ai-body] [data-pending="true"]')).toHaveCount(6);
    await expect(page.locator("#draft-box")).toBeHidden();
  });

  test("問題文を直すと、前の回答は消える（違う問題の解説を残さない）", async ({ page }) => {
    await show(page);
    await page.fill("#ai-paste", PASTED);
    await page.click("#ai-paste-apply");
    await page.fill("#result", TEXT + "\nオ．なし");
    await expect(page.locator('[data-ai-body] [data-pending="true"]')).toHaveCount(6);
    await expect(page.locator("#ai-result-note")).toBeHidden();
  });
});

test.describe("模擬データ", () => {
  test("読み取り前は使えない", async ({ page }) => {
    await page.click("#ai-paste-mock");
    await expect(page.locator("#ai-paste-status")).toContainText("先に画像を読み取るか");
  });

  test("通信せずに全項目と下書きが埋まり、「模擬データ」と明記される", async ({ page }) => {
    await show(page);
    await page.click("#ai-paste-mock");
    await expect(page.locator("#ai-paste")).toHaveValue(/模擬データ/);
    await expect(page.locator('[data-ai-body] [data-pending="true"]')).toHaveCount(0);
    await expect(page.locator('[data-ai-body="candidates"] li')).toHaveText(["ア"]);
    await expect(page.locator("#ai-result-note")).toContainText("模擬データです。AIの回答ではなく");
    await expect(page.locator("#draft-text")).toHaveValue("（模擬）答え：ア");
    await expect(page.locator("#ai-paste-status")).toContainText("すべての項目が見つかりました");
  });
});

test.describe("回答の下書き", () => {
  test("回答候補と理由から下書きが作られ、提出は自分で行うと書かれている", async ({ page }) => {
    await show(page);
    await page.fill("#ai-paste", PASTED);
    await page.click("#ai-paste-apply");
    await expect(page.locator("#draft-box")).toBeVisible();
    await expect(page.locator("#draft-text")).toHaveValue("答え：ア．光は直進する、エ．氷は水に浮く\n理由：アとエは正しい性質です。");
    await expect(page.locator("#draft-box")).toContainText("提出は、このアプリではなく、あなたが自分で行います");
  });

  test("下書きを直してコピーできる", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:8765" });
    await show(page);
    await page.click("#ai-paste-mock");
    await page.fill("#draft-text", "答え：エ（自分で直した）");
    await page.click("#copy-draft");
    await expect(page.locator("#draft-status")).toContainText("下書きをコピーしました");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("答え：エ（自分で直した）");
  });

  test("直した下書きを作り直すときは確認し、キャンセルなら残す", async ({ page }) => {
    await show(page);
    await page.click("#ai-paste-mock");
    await page.fill("#draft-text", "自分で直した");
    page.once("dialog", (d) => d.dismiss());
    await page.click("#draft-reset");
    await expect(page.locator("#draft-text")).toHaveValue("自分で直した");
    page.once("dialog", (d) => d.accept());
    await page.click("#draft-reset");
    await expect(page.locator("#draft-text")).toHaveValue("（模擬）答え：ア");
  });
});

test.describe("安全性・iPad", () => {
  test("Classiへの提出・送信の仕組み（フォーム・送信ボタン）がない", async ({ page }) => {
    await show(page);
    await page.click("#ai-paste-mock");
    expect(await page.locator('form, input[type="password"], button[type="submit"]').count()).toBe(0);
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie])).toEqual([0, 0, ""]);
  });

  test("「すべて消去」で、貼り付けた回答と下書きも消える", async ({ page }) => {
    await show(page);
    await page.click("#ai-paste-mock");
    page.once("dialog", (d) => d.accept());
    await page.click("#clear-all");
    await expect(page.locator("#ai-paste")).toHaveValue("");
    await expect(page.locator("#draft-box")).toBeHidden();
  });

  test("横スクロールが出ず、ボタンが押しやすい大きさ", async ({ page }) => {
    await show(page);
    await page.click("#ai-paste-mock");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    for (const id of ["#ai-paste-apply", "#ai-paste-mock", "#copy-draft", "#draft-reset"]) {
      const box = await page.locator(id).boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(40);
    }
  });
});
