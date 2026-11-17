// OCRの改善（「エ」と「工」・次の問題が混ざる・要確認の直しやすさ）の画面テスト（iPad Air 縦・横）
// iPad の実機テスト（架空の問題画像）で起きた読み取り結果を再現して確かめる。OCRライブラリは使わない。
const { test, expect } = require("@playwright/test");

const REAL_CASE = [
  "2（　）に入る適切な語を、ア〜エから1つ選びなさい。",
  "This is the book (     ) I bought yesterday.",
  "ア who イ which ウ where 工 when",
  "3 次の英文が正しければ〇、誤っていれば X を（ ）に書きなさい。",
  "(1) He don’t like tomatoes. (     )",
  "(2) She plays the piano very well. (     )",
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

const show = (page, text = REAL_CASE, uncertain = []) =>
  page.evaluate(([t, u]) => window.__classiAssistant.showReading({ text: t, uncertain: u }), [text, uncertain]);

test.describe("解説画面と質問文", () => {
  test("選択肢が4つに分かれ、「工」は「エ」として要確認つきで表示される", async ({ page }) => {
    await show(page);
    await expect(page.locator("#ex-question-body .q-choices .marker")).toHaveText(["ア", "イ", "ウ", "エ"]);
    await expect(page.locator("#ex-question-body .q-choices .text")).toHaveText(["who", "which", "where", "when"]);
    const last = page.locator("#ex-question-body .q-choices li").nth(3);
    await expect(last.locator(".badge")).toHaveText("要確認");
    await expect(last).toContainText("記号「工」を「エ」と判断");
    await expect(page.locator("#ex-question-body .q-choices .badge")).toHaveCount(1);
  });

  test("次の問題は「別の問題と思われる部分」に分かれて表示される", async ({ page }) => {
    await show(page);
    const other = page.locator("#ex-other");
    await expect(other).toContainText("別の問題と思われる部分（解説用の質問文には入れません）");
    await expect(other).toContainText("3 次の英文が正しければ");
    await expect(page.locator("#ex-question-body .q-choices")).not.toContainText("次の英文");
  });

  test("質問文に次の問題が入らず、「エ when」は要確認つきで入る", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:8765" });
    await show(page);
    await page.click("#confirm-text");
    await page.click("#copy-explain");
    await expect(page.locator("#explain-status")).toContainText("別の問題と思われる部分は、質問文に入れていません");
    const prompt = await page.inputValue("#explain-prompt");
    expect(prompt).toContain("【選択肢】\nア who\nイ which\nウ where\nエ when 【要確認】");
    expect(prompt).not.toContain("次の英文が正しければ");
    expect(prompt).not.toContain("tomatoes");
    expect(prompt).not.toContain("工 when");
  });

  test("問題の種類は「選択問題（記号で答える）」と判定される", async ({ page }) => {
    await show(page);
    await expect(page.locator("#ex-type-body .q-type")).toHaveText("選択問題（記号で答える）");
  });
});

test.describe("要確認：推測した記号をワンタップで直す", () => {
  test("「工」→「エ」の推測が要確認の一覧に出て、「「エ」に直す」で文章が直る", async ({ page }) => {
    await show(page);
    const item = page.locator("#review-guess li.text-guess");
    await expect(item).toHaveCount(1);
    await expect(item).toContainText("選択肢の記号「工」は、順番から「エ」と考えられます");
    await page.click('#review-guess [data-action="fix-label"]');
    await expect(page.locator("#result")).toHaveValue(/ア who イ which ウ where エ when/);
    await expect(page.locator("#review-guess")).toHaveCount(0);
    await expect(page.locator("#ex-question-body .q-choices .badge")).toHaveCount(0);
    await expect(page.locator("#history")).toContainText("選択肢の記号「工」を「エ」に修正");
  });

  test("直したあとは確認がやり直しになる（確認済みのままにしない）", async ({ page }) => {
    await show(page);
    await page.click("#confirm-text");
    await expect(page.locator("#confirm-state")).toContainText("確認済み");
    await page.click('#review-guess [data-action="fix-label"]');
    await expect(page.locator("#confirm-state")).not.toContainText("確認済み");
  });
});

test.describe("要確認：その行をその場で直す", () => {
  const TEXT = "問1 正しいものを選びなさい。\nア．光は直進する\nイ．音は真空中を伝わる\nウ．水は100℃で凍る\nエ．氷は水に浮く";
  const UNCERTAIN = [{ text: "ウ．水は100℃で凍る", confidence: 52, words: [{ text: "100℃", confidence: 31 }] }];

  test("「ここで直す」で入力欄が開き、「直す」で文章に反映されて「修正済み」になる", async ({ page }) => {
    await show(page, TEXT, UNCERTAIN);
    await expect(page.locator("#review h3").first()).toHaveText("要確認 残り1件（全1件）");
    await page.click('#review [data-action="edit-line"]');
    const input = page.locator('#review [data-role="line-edit"]');
    await expect(input).toHaveValue("ウ．水は100℃で凍る");
    await expect(input).toBeFocused();
    await input.fill("ウ．水は0℃で凍る");
    await page.click('#review [data-action="apply-edit"]');
    await expect(page.locator("#result")).toHaveValue(TEXT.replace("100℃", "0℃"));
    await expect(page.locator("#review .review-row .badge")).toHaveText("修正済み");
    await expect(page.locator("#review h3").first()).toHaveText("要確認 残り0件（全1件）");
  });

  test("Enter キーでも直せる。「やめる」なら文章は変わらない", async ({ page }) => {
    await show(page, TEXT, UNCERTAIN);
    await page.click('#review [data-action="edit-line"]');
    await page.fill('#review [data-role="line-edit"]', "書きかけ");
    await page.click('#review [data-action="cancel-edit"]');
    await expect(page.locator("#result")).toHaveValue(TEXT);
    await expect(page.locator('#review [data-role="line-edit"]')).toHaveCount(0);
    await page.click('#review [data-action="edit-line"]');
    await page.fill('#review [data-role="line-edit"]', "ウ．水は0℃で凍る");
    await page.press('#review [data-role="line-edit"]', "Enter");
    await expect(page.locator("#review .review-row .badge")).toHaveText("修正済み");
  });

  test("ボタンは押しやすい大きさで、横スクロールが出ない", async ({ page }) => {
    await show(page, TEXT, UNCERTAIN);
    for (const sel of ['[data-action="edit-line"]', '[data-action="mark-ok"]', '[data-action="select-line"]']) {
      expect((await page.locator(`#review ${sel}`).boundingBox()).height).toBeGreaterThanOrEqual(40);
    }
    await page.click('#review [data-action="edit-line"]');
    expect((await page.locator('#review [data-role="line-edit"]').boundingBox()).height).toBeGreaterThanOrEqual(40);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });
});

test.describe("最終レビューの修正：iPadの自動修正・解説が消えたときの案内・日本語の選択肢", () => {
  test("OCR結果欄・ここで直す欄・下書き欄・貼り付け欄で、自動大文字化と自動修正が無効", async ({ page }) => {
    const TEXT = "問1 選びなさい。\nア．one\nイ．two";
    await show(page, TEXT, [{ text: "イ．two", confidence: 40, words: [] }]);
    for (const sel of ["#result", "#draft-text", "#ai-paste"]) {
      const el = page.locator(sel);
      await expect(el, sel).toHaveAttribute("autocapitalize", "off");
      await expect(el, sel).toHaveAttribute("autocorrect", "off");
      await expect(el, sel).toHaveAttribute("spellcheck", "false");
    }
    await page.click('#review [data-action="edit-line"]');
    const input = page.locator('#review [data-role="line-edit"]');
    await expect(input).toHaveAttribute("autocapitalize", "off");
    await expect(input).toHaveAttribute("autocorrect", "off");
    await expect(input).toHaveAttribute("spellcheck", "false");
  });

  test("問題文を直して解説が消えたら、もう一度整理するよう案内し、整理し直すと案内が消える", async ({ page }) => {
    await show(page);
    await page.click("#ai-paste-mock");
    await expect(page.locator("#draft-box")).toBeVisible();
    await page.fill("#result", REAL_CASE.replace("yesterday", "last week"));
    const st = page.locator("#ai-paste-status");
    await expect(st).toContainText("問題文が変わったため、前の解説と下書きを消しました");
    await expect(st).toContainText("「回答を整理する」をもう一度押してください");
    await expect(st).toHaveAttribute("data-notice", "answer-reset");
    await expect(page.locator("#draft-box")).toBeHidden();
    await page.click("#ai-paste-apply");
    await expect(st).not.toContainText("問題文が変わった");
    await expect(st).not.toHaveAttribute("data-notice", "answer-reset");
    await expect(page.locator("#draft-box")).toBeVisible();
  });

  test("解説がないときに問題文を直しても、案内は出ない", async ({ page }) => {
    await show(page);
    await page.fill("#result", REAL_CASE + "\n追加");
    await expect(page.locator("#ai-paste-status")).toHaveText("");
  });

  test("「ここで直す」で解説が消えたときも、案内が出る", async ({ page }) => {
    const TEXT = "問1 選びなさい。\nア．one\nイ．two";
    await show(page, TEXT, [{ text: "イ．two", confidence: 40, words: [] }]);
    await page.click("#ai-paste-mock");
    await page.click('#review [data-action="edit-line"]');
    await page.fill('#review [data-role="line-edit"]', "イ．three");
    await page.click('#review [data-action="apply-edit"]');
    await expect(page.locator("#ai-paste-status")).toContainText("前の解説と下書きを消しました");
  });

  test("日本語の選択肢が1行に並んでいても、解説画面で4つに分かれる", async ({ page }) => {
    await show(page, "問1 日本の首都を選びなさい。\nア 東京 イ 大阪 ウ 名古屋 工 福岡");
    await expect(page.locator("#ex-question-body .q-choices .text")).toHaveText(["東京", "大阪", "名古屋", "福岡"]);
    await expect(page.locator("#ex-question-body .q-choices li").nth(3).locator(".badge")).toHaveText("要確認");
  });

  test("「2つ選びなさい」の折り返しがあっても、別の問題として分けない", async ({ page }) => {
    await show(page, "問1 次の中から正しいものを\n2つ選びなさい。\nア．東京\nイ．大阪\nウ．名古屋");
    await expect(page.locator("#ex-other")).toHaveCount(0);
    await expect(page.locator("#ex-question-body .q-stem")).toContainText("2つ選びなさい。");
    await expect(page.locator("#ex-question-body .q-choices li")).toHaveCount(3);
  });
});
