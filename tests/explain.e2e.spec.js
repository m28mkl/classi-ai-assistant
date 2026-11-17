// AI解説画面・要確認・確認ボタン・消去ボタンの画面テスト（iPad Air 縦・横）
// OCRライブラリは使わず、window.__classiAssistant.showReading で「OCRの結果が出た状態」を作る。
const { test, expect } = require("@playwright/test");

const TEXT = "問3 次のうち、正しいものを選びなさい。\nア．光は直進する\nイ．音は真空中を伝わる\nウ．水は100℃で凍る\nエ．氷は水に浮く";
const UNCERTAIN = [{ text: "ウ．水は100℃で凍る", confidence: 52, words: [{ text: "100℃", confidence: 31 }] }];

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

const show = (page, extra = {}) =>
  page.evaluate(([t, u, e]) => window.__classiAssistant.showReading({ text: t, uncertain: u, ...e }), [TEXT, UNCERTAIN, extra]);

test.describe("AI解説画面（AI接続前）", () => {
  test("AI接続前と明示され、AIが答えたようには見えない", async ({ page }) => {
    const panel = page.locator("#sec-explain");
    await expect(panel.locator(".badge.b-pre")).toHaveText("AI接続前");
    await expect(page.locator("#ai-status")).toContainText("AIはまだ接続されていません");
    await show(page);
    const pending = page.locator('#sec-explain [data-pending="true"]');
    await expect(pending).toHaveCount(5);
    for (const t of await pending.allTextContents()) expect(t).toContain("AI接続前：まだ作成されていません");
  });

  test("7つの項目が順番に用意されている", async ({ page }) => {
    const heads = await page.locator("#sec-explain .ex-item h3").allTextContents();
    expect(heads.map((h) => h.replace(/^\d+\./, ""))).toEqual([
      "読み取った問題", "問題の種類", "問題の意味", "解き方・考え方", "回答候補", "回答の理由", "間違えやすいポイント",
    ]);
  });

  test("問題文と選択肢が分かれ、選択肢は読み取った順番のまま表示される", async ({ page }) => {
    await show(page);
    await expect(page.locator("#ex-question-body .q-stem")).toContainText("次のうち、正しいものを選びなさい");
    await expect(page.locator("#ex-question-body .q-choices .marker")).toHaveText(["ア．", "イ．", "ウ．", "エ．"]);
    await expect(page.locator("#ex-type-body .q-type")).toHaveText("選択問題（記号で答える）");
    await expect(page.locator("#ex-type-body")).toContainText("AIが判断したものではありません");
  });

  test("読み取り前は案内を表示する", async ({ page }) => {
    await expect(page.locator("#ex-question-body")).toContainText("まだ読み取った問題がありません");
  });
});

test.describe("要確認・確認・修正", () => {
  test("自信のない行に「要確認」が付き、自信度と低い単語が示される", async ({ page }) => {
    await show(page);
    const row = page.locator("#review .review-row");
    await expect(row).toHaveCount(1);
    await expect(row.locator(".badge")).toHaveText("要確認");
    await expect(row).toContainText("自信度 52%");
    await expect(row.locator("mark")).toHaveText("100℃");
    await expect(page.locator("#ex-question-body .q-choices li", { hasText: "水は100℃" }).locator(".badge")).toHaveText("要確認");
    await expect(page.locator("#ex-question-body .q-choices .badge")).toHaveCount(1);
  });

  test("文章を直すと「修正済み」になり、解説側の要確認も消える（文章は勝手に変わらない）", async ({ page }) => {
    await show(page);
    await page.fill("#result", TEXT.replace("100℃で凍る", "100℃で沸騰する"));
    await expect(page.locator("#review .review-row .badge")).toHaveText("修正済み");
    await expect(page.locator("#ex-question-body .badge")).toHaveCount(0);
    await expect(page.locator("#ex-question-body .q-choices .text").nth(2)).toHaveText("水は100℃で沸騰する");
  });

  test("「合っている」で確認済みにできる", async ({ page }) => {
    await show(page);
    await page.click('#review [data-action="mark-ok"]');
    await expect(page.locator("#review .review-row .badge")).toHaveText("確認済み");
  });

  test("「この行を選んで修正」で、その行が文章欄で選択される", async ({ page }) => {
    await show(page);
    await page.click('#review [data-action="select-line"]');
    const selected = await page.$eval("#result", (t) => t.value.slice(t.selectionStart, t.selectionEnd));
    expect(selected).toBe("ウ．水は100℃で凍る");
  });

  test("自信度の情報がないときは、その旨を表示する（要確認を作らない）", async ({ page }) => {
    await show(page, { hasConfidence: false, uncertain: [] });
    await expect(page.locator("#review")).toContainText("自信度の情報が得られませんでした");
    await expect(page.locator("#review .review-row")).toHaveCount(0);
  });
});

test.describe("解説用の質問文（確認が必須・送信しない）", () => {
  test("確認前はコピーできない", async ({ page }) => {
    await show(page);
    await page.click("#copy-explain");
    await expect(page.locator("#explain-status")).toContainText("先に「② この内容で合っています」を押してください");
    await expect(page.locator("#explain-prompt")).toHaveValue("");
  });

  test("確認後にコピーでき、選択肢の順番と【要確認】が入る", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:8765" });
    await show(page);
    page.once("dialog", (d) => d.accept()); // 要確認が残っているときの確認
    await page.click("#confirm-text");
    await expect(page.locator("#confirm-state")).toContainText("確認済み");
    await page.click("#copy-explain");
    await expect(page.locator("#explain-status")).toContainText("コピーしました");
    const prompt = await page.inputValue("#explain-prompt");
    expect(prompt).toContain("7. 間違えやすいポイントを示す");
    expect(prompt).toContain("ウ．水は100℃で凍る 【要確認】");
    expect(prompt.indexOf("ア．光は直進する")).toBeLessThan(prompt.indexOf("イ．音は真空中を伝わる"));
    expect(prompt).toContain("回答の提出や送信はしません");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(prompt);
  });

  test("要確認が残っているときの確認は、キャンセルすると確認済みにならない", async ({ page }) => {
    await show(page);
    page.once("dialog", (d) => d.dismiss());
    await page.click("#confirm-text");
    await expect(page.locator("#confirm-state")).not.toContainText("確認済み");
  });

  test("確認後に文章を直すと、確認が取り消される", async ({ page }) => {
    await show(page, { uncertain: [] });
    await page.click("#confirm-text");
    await expect(page.locator("#confirm-state")).toContainText("確認済み");
    await page.fill("#result", TEXT + "\nオ．なし");
    await expect(page.locator("#confirm-state")).not.toContainText("確認済み");
  });
});

test.describe("プライバシー", () => {
  test("「すべて消去」で、文章・カード・質問文・要確認が消える", async ({ page }) => {
    await show(page);
    await page.click("#analyze");
    await expect(page.locator("#tasks .task").first()).toBeVisible();
    page.once("dialog", (d) => d.accept());
    await page.click("#clear-all");
    await expect(page.locator("#result")).toHaveValue("");
    await expect(page.locator("#prompt")).toHaveValue("");
    await expect(page.locator("#tasks .task")).toHaveCount(0);
    await expect(page.locator("#review .review-row")).toHaveCount(0);
    await expect(page.locator("#ex-question-body")).toContainText("まだ読み取った問題がありません");
    await expect(page.locator("#status")).toHaveText("消去しました");
  });

  test("消去をキャンセルしたら何も消えない", async ({ page }) => {
    await show(page);
    page.once("dialog", (d) => d.dismiss());
    await page.click("#clear-all");
    await expect(page.locator("#result")).toHaveValue(TEXT);
  });

  test("端末への保存がなく、パスワード欄もない", async ({ page }) => {
    await show(page);
    expect(await page.locator('input[type="password"], form').count()).toBe(0);
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie])).toEqual([0, 0, ""]);
  });
});
