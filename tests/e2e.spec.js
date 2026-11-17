// iPad Air（縦 820×1180／横 1180×820）での画面テスト
// - 「今日」は 2026-11-16 10:00（日本時間）に固定
// - OCRライブラリ（tesseract.js 5.1.1）は本物を読み込み（SRIの確認も本番どおり）、window.Tesseract だけを
//   認識結果が固定の偽物に差し替える。実際の文字認識は tests/ocr.spec.js でテストする
// - 全テスト共通で「JavaScriptエラーがないこと」「外部への通信がOCR関連の固定URLの取得だけであること」を確認する
const { test, expect } = require("@playwright/test");
const { OCR_URLS, isAllowedOcrUrl, fulfillLocal } = require("./helpers/ocr-assets");
const { installFakeTesseract, TINY_PNG } = require("./helpers/fake-tesseract");

const NOW = new Date("2026-11-16T10:00:00+09:00");
const OCR_LIB = OCR_URLS.library;
const FAKE_IMAGE = TINY_PNG;

const OCR_TEXT = `Classi お知らせ
【重要】明日の時間割変更について
数学 課題プリント3
提出期限：2026年11月20日 17:00
英語 宿題 ワーク p.10-15
期限 11/18
国語 感想文
保護者会のご案内 12月5日
体育祭 雨天延期のお知らせ
理科 レポート`;

let jsErrors;
let externalRequests;
let ocrAvailable;

test.beforeEach(async ({ page }) => {
  jsErrors = [];
  externalRequests = [];
  ocrAvailable = true;
  page.on("pageerror", (e) => jsErrors.push(e.message));
  page.on("console", (m) => {
    // 外部通信を遮断したときのネットワークエラー表示は除外
    if (m.type() === "error" && !/ERR_FAILED|Failed to load resource/.test(m.text())) jsErrors.push(m.text());
  });
  await page.clock.install({ time: NOW });
  await installFakeTesseract(page, { text: OCR_TEXT });
  // blob: や data: のURL（端末内のデータ）は外部通信ではないので、http(s) だけを対象にする
  await page.route(/^https?:\/\//, (route) => {
    const url = route.request().url();
    if (url.startsWith("http://127.0.0.1")) return route.continue();
    externalRequests.push({ url, method: route.request().method(), body: route.request().postData() });
    if (url === OCR_LIB && ocrAvailable) return fulfillLocal(route, url);
    return route.abort();
  });
  await page.goto("/index.html");
});

test.afterEach(async () => {
  expect(jsErrors, "JavaScriptエラーが発生していない").toEqual([]);
  for (const r of externalRequests) {
    expect(isAllowedOcrUrl(r.url), `外部への通信はOCR関連の固定URLの取得だけ: ${r.url}`).toBe(true);
    expect(r.method).toBe("GET");
    expect(r.body).toBeNull();
  }
});

/** 画像を選んで読み取り、情報を整理するところまで進める */
async function readAndAnalyze(page) {
  await page.setInputFiles("#image", FAKE_IMAGE);
  await page.click("#read");
  await expect(page.locator("#status")).toHaveText("読み取り完了！");
  await page.click("#analyze");
}

const cards = (page) => page.locator("#tasks .task");
const card = (page, text) => page.locator("#tasks .task", { hasText: text });

async function cardSummaries(page) {
  return cards(page).evaluateAll((els) => els.map((e) => ({
    title: e.querySelector(".task-title").textContent,
    due: e.querySelector(".task-due").textContent,
    badges: [...e.querySelectorAll(".badge")].map((b) => b.textContent),
  })));
}

test.describe("既存機能", () => {
  test("操作の順番が違うときのメッセージ", async ({ page }) => {
    await page.click("#analyze");
    await expect(page.locator("#summary")).toContainText("先に画像を読み取ってください");
    await page.click("#copy");
    await expect(page.locator("#status")).toHaveText("先に情報を整理してください");
    await page.click("#read");
    await expect(page.locator("#status")).toHaveText("画像を選択してください");
  });

  test("画像の読み取り → 結果欄 → 整理 → AIへの質問文", async ({ page }) => {
    await readAndAnalyze(page);
    await expect(page.locator("#result")).toHaveValue(OCR_TEXT);
    const prompt = await page.inputValue("#prompt");
    expect(prompt).toContain("あなたはClassiの学習支援アシスタントです。");
    expect(prompt).toContain("提出や送信などの操作は勝手に実行せず");
    expect(prompt).toContain("【Classiの画面情報】\n" + OCR_TEXT);
  });

  test("AIへの質問をコピーする（ボタンを押したときだけ）", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:8765" });
    await readAndAnalyze(page);
    await page.click("#copy");
    await expect(page.locator("#status")).toHaveText("AIへの質問をコピーしました！");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await page.inputValue("#prompt"));
  });

  test("OCRライブラリを読み込めなくても、エラー表示して他の機能は使える", async ({ page }) => {
    ocrAvailable = false;
    await page.setInputFiles("#image", FAKE_IMAGE);
    await page.click("#read");
    await expect(page.locator("#status")).toContainText("読み取りエラー");
    await expect(page.locator("#read")).toBeEnabled();
    await page.fill("#result", "数学 課題 11/30");
    await page.click("#analyze");
    await expect(page.locator("#tasks")).toContainText("2026年11月30日");
  });
});

test.describe("カード表示・期限順・期限不明・分類", () => {
  test("読み取った課題がカードで表示される", async ({ page }) => {
    await readAndAnalyze(page);
    await expect(cards(page)).toHaveCount(8);
    const pr = card(page, "数学 課題プリント3");
    await expect(pr.locator(".badge").first()).toHaveText("課題");
    await expect(pr.locator(".task-due")).toContainText("2026年11月20日（金） 17:00");
    await expect(pr.locator(".task-due")).toContainText("あと4日");
  });

  test("期限の日付順に並び、期限不明は最後に「不明」と表示される", async ({ page }) => {
    await readAndAnalyze(page);
    const list = await cardSummaries(page);
    const firstUnknown = list.findIndex((c) => c.due.includes("不明"));
    expect(firstUnknown).toBe(3);
    expect(list.slice(firstUnknown).every((c) => c.due === "期限：不明")).toBe(true);
    expect(list.slice(0, firstUnknown).map((c) => c.title)).toEqual([
      "英語 宿題 ワーク p.10-15", "数学 課題プリント3", "保護者会のご案内 12月5日",
    ]);
    await expect(page.locator("#summary")).toContainText("期限不明 5件");
  });

  test("お知らせが分類され、絞り込みできる", async ({ page }) => {
    await readAndAnalyze(page);
    await expect(card(page, "時間割変更").locator(".badge")).toHaveText(["お知らせ", "重要"]);
    await expect(card(page, "保護者会").locator(".badge")).toHaveText(["お知らせ", "行事・予定"]);
    await expect(card(page, "体育祭").locator(".badge")).toHaveText(["お知らせ", "重要"]);

    await page.click('[data-filter="important"]');
    await expect(cards(page)).toHaveCount(2);
    await page.click('[data-filter="task"]');
    await expect(cards(page)).toHaveCount(4);
    await page.click('[data-filter="notice"]');
    await expect(cards(page)).toHaveCount(4);
    await page.click('[data-filter="all"]');
    await expect(cards(page)).toHaveCount(8);
  });
});

test.describe("カードの追加・編集・削除", () => {
  test("編集すると並び順と質問文に反映され、「修正済み」と表示される", async ({ page }) => {
    await readAndAnalyze(page);
    await card(page, "感想文").locator('[data-action="edit"]').click();
    const ed = page.locator("#tasks .editing");
    await ed.locator("textarea[name=title]").fill("国語 読書感想文");
    await ed.locator("input[name=due]").fill("2026-11-17");
    await ed.locator("select[name=category]").selectOption("重要");
    await ed.locator('[data-action="save"]').click();

    const first = cards(page).first();
    await expect(first.locator(".task-title")).toHaveText("国語 読書感想文");
    await expect(first.locator(".badge")).toHaveText(["課題", "重要", "修正済み"]);
    expect(await page.inputValue("#prompt")).toContain("国語 読書感想文 / 期限：2026年11月17日");
  });

  test("「期限は不明」にすると不明に戻る", async ({ page }) => {
    await readAndAnalyze(page);
    await card(page, "数学 課題プリント3").locator('[data-action="edit"]').click();
    await page.locator("#tasks .editing input[name=unknown]").check();
    await expect(page.locator("#tasks .editing input[name=due]")).toHaveValue("");
    await page.locator('#tasks .editing [data-action="save"]').click();
    await expect(card(page, "数学 課題プリント3").locator(".task-due")).toHaveText("期限：不明");
    // 期限ありのカード（3件→2件）より後ろ、期限不明のグループに移る
    const titles = await cards(page).locator(".task-title").allTextContents();
    expect(titles.indexOf("数学 課題プリント3")).toBeGreaterThan(titles.indexOf("保護者会のご案内 12月5日"));
  });

  test("手動で追加して保存できる（期限超過も表示）", async ({ page }) => {
    await readAndAnalyze(page);
    await page.click("#add-item");
    const ed = page.locator("#tasks .editing");
    await ed.locator("textarea[name=title]").fill("社会 新聞スクラップ");
    await ed.locator("input[name=due]").fill("2026-11-10");
    await ed.locator('[data-action="save"]').click();
    const added = card(page, "新聞スクラップ");
    await expect(added).toHaveClass(/overdue/);
    await expect(added.locator(".task-due")).toContainText("6日超過");
    await expect(page.locator("#summary")).toContainText("期限超過 1件");
    await expect(cards(page)).toHaveCount(9);
  });

  test("手動追加をキャンセルすると空のカードは残らない", async ({ page }) => {
    await readAndAnalyze(page);
    await page.click("#add-item");
    await page.locator("#tasks .editing button", { hasText: "キャンセル" }).click();
    await expect(cards(page)).toHaveCount(8);
  });

  test("内容が空では保存できず、編集中のカード内にエラーが出る", async ({ page }) => {
    await readAndAnalyze(page);
    await card(page, "理科").locator('[data-action="edit"]').click();
    const ed = page.locator("#tasks .editing");
    await ed.locator("textarea[name=title]").fill("   ");
    await ed.locator('[data-action="save"]').click();
    await expect(ed.locator(".edit-error")).toHaveText("内容を入力してください");
    await expect(page.locator("#status")).not.toContainText("内容を入力");
    await ed.locator("button", { hasText: "キャンセル" }).click();
    await expect(card(page, "理科 レポート")).toHaveCount(1);
  });

  test("削除できる（確認ダイアログあり）", async ({ page }) => {
    await readAndAnalyze(page);
    page.once("dialog", (d) => d.accept());
    await card(page, "理科").locator('[data-action="edit"]').click();
    await page.locator('#tasks .editing [data-action="delete"]').click();
    await expect(cards(page)).toHaveCount(7);
    await expect(card(page, "理科")).toHaveCount(0);
  });

  test("修正後に再整理するときは確認し、キャンセルなら修正を残す", async ({ page }) => {
    await readAndAnalyze(page);
    await card(page, "理科").locator('[data-action="edit"]').click();
    await page.locator("#tasks .editing textarea[name=title]").fill("理科 実験レポート");
    await page.locator('#tasks .editing [data-action="save"]').click();
    let message = "";
    page.once("dialog", (d) => { message = d.message(); d.dismiss(); });
    await page.click("#analyze");
    expect(message).toContain("破棄");
    await expect(card(page, "理科 実験レポート")).toHaveCount(1);
  });
});

test.describe("操作履歴", () => {
  test("操作が時刻つきで記録され、クリアできる", async ({ page }) => {
    await readAndAnalyze(page);
    await card(page, "理科").locator('[data-action="edit"]').click();
    await page.locator("#tasks .editing textarea[name=title]").fill("理科 実験レポート");
    await page.locator('#tasks .editing [data-action="save"]').click();
    const history = page.locator("#history li");
    await expect(history.first()).toContainText("「理科 実験レポート」を修正");
    await expect(page.locator("#history")).toContainText("情報を整理（課題4件・お知らせ4件・重要2件）");
    await expect(page.locator("#history")).toContainText("画像の読み取り完了（10行）");
    await expect(history.first().locator("time")).toHaveText("10:00:00");
    await page.click("#clear-history");
    await expect(history).toHaveText(["まだ操作はありません"]);
  });
});

test.describe("安全性", () => {
  test("読み取った文字はHTMLとして実行されない", async ({ page }) => {
    await page.fill("#result", '<img src=x onerror="window.__pwned=1"> 課題 11/30');
    await page.click("#analyze");
    await expect(page.locator("#tasks")).toContainText("<img src=x");
    expect(await page.evaluate(() => !!window.__pwned || !!document.querySelector("#tasks img"))).toBe(false);
  });

  test("AIへの送信は確認したときだけ・Classiは操作しないことが画面に明記されている", async ({ page }) => {
    const scope = page.locator("#scope");
    await expect(scope).toBeVisible();
    await expect(scope).toContainText("AIへの送信は、あなたが確認して「送る」を押したときだけです");
    await expect(scope).toContainText("AIが未接続のときは何も送りません");
    await expect(scope).toContainText("Classiを操作しません");
  });

  test("パスワード入力欄・フォーム・端末への保存がない", async ({ page }) => {
    await readAndAnalyze(page);
    expect(await page.locator('input[type="password"], form').count()).toBe(0);
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie])).toEqual([0, 0, ""]);
  });
});

test.describe("iPad Airでの画面", () => {
  test("横スクロールが出ず、タップしやすい大きさになっている", async ({ page }, testInfo) => {
    await readAndAnalyze(page);
    const width = page.viewportSize().width;
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const small = await page.$$eval("button, input, select, textarea", (els) =>
      els.filter((e) => e.offsetParent && e.getBoundingClientRect().height < 40).map((e) => e.outerHTML.slice(0, 80)));
    expect(small).toEqual([]);
    await testInfo.attach("画面", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  });

  test("編集画面も横スクロールが出ない", async ({ page }, testInfo) => {
    await readAndAnalyze(page);
    await cards(page).first().locator('[data-action="edit"]').click();
    const width = page.viewportSize().width;
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const box = await page.locator("#tasks .editing").boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await page.locator("#tasks .editing").scrollIntoViewIfNeeded();
    await testInfo.attach("編集画面", { body: await page.screenshot(), contentType: "image/png" });
  });

  test("横向きは2列、縦向きはカードが2列になる", async ({ page }) => {
    await readAndAnalyze(page);
    const width = page.viewportSize().width;
    const side = await page.locator(".col-side").boundingBox();
    const main = await page.locator(".col-main").boundingBox();
    if (width >= 1000) {
      expect(main.x).toBeGreaterThan(side.x + side.width - 1); // 左右に並ぶ
    } else {
      expect(main.y).toBeGreaterThan(side.y); // 縦に並ぶ
      const [a, b] = await Promise.all([cards(page).nth(0).boundingBox(), cards(page).nth(1).boundingBox()]);
      expect(Math.abs(a.y - b.y)).toBeLessThan(2); // カードが横に2つ並ぶ
    }
  });
});
