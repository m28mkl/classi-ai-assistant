// 問題文と選択肢の分け方・問題の種類・OCRの自信度（要確認）・画像補正・解説用の質問文の単体テスト
// index.html が公開している window.__classiAssistant の関数をブラウザ内で直接呼び出す。
const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "default" });

/** @type {import('@playwright/test').Page} */
let page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ timezoneId: "Asia/Tokyo", locale: "ja-JP" });
  await page.route("**/*", (route) =>
    route.request().url().startsWith("http://127.0.0.1") ? route.continue() : route.abort());
  await page.goto("/index.html");
  await page.waitForFunction(() => !!window.__classiAssistant);
});
test.afterAll(async () => { await page.close(); });

const parse = (text) => page.evaluate((t) => window.__classiAssistant.parseQuestion(t), text);
const typeOf = (text) => page.evaluate((t) => window.__classiAssistant.detectQuestionType(t), text);

test.describe("問題文と選択肢の分け方 parseQuestion", () => {
  test("ア・イ・ウ・エの選択肢を、順番も記号もそのままで分ける", async () => {
    const r = await parse("次のうち正しいものを選べ。\nア．光は直進する\nイ．音は真空中を伝わる\nウ．水は100℃で凍る\nエ．氷は水に浮く");
    expect(r.stem).toBe("次のうち正しいものを選べ。");
    expect(r.choices.map((c) => c.marker)).toEqual(["ア．", "イ．", "ウ．", "エ．"]);
    expect(r.choices.map((c) => c.text)).toEqual(["光は直進する", "音は真空中を伝わる", "水は100℃で凍る", "氷は水に浮く"]);
  });

  test("順番が入れ替わった記号も、読み取った順番のまま並べる", async () => {
    const r = await parse("問\n③ さん\n① いち\n② に");
    expect(r.choices.map((c) => c.marker)).toEqual(["③", "①", "②"]);
  });

  test("丸数字・(1)・A. の選択肢", async () => {
    expect((await parse("問\n① あ\n② い")).choices).toHaveLength(2);
    expect((await parse("問\n(1) あ\n(2) い\n(3) う")).choices).toHaveLength(3);
    expect((await parse("Choose.\nA. cat\nB. dog\nC. bird")).choices.map((c) => c.marker)).toEqual(["A.", "B.", "C."]);
  });

  test("選択肢の途中で行が折り返されたら、前の選択肢に続ける", async () => {
    const r = await parse("問\nア．とても長い\n選択肢の続き\nイ．短い");
    expect(r.choices).toHaveLength(2);
    expect(r.choices[0].text).toBe("とても長い 選択肢の続き");
    expect(r.choices[0].raws).toEqual(["ア．とても長い", "選択肢の続き"]);
  });

  test("選択肢のあとの行は、選択肢に混ぜずに別にする", async () => {
    const r = await parse("問\nア．あ\nイ．い\n次へ");
    expect(r.choices).toHaveLength(2);
    expect(r.afterLines).toEqual(["次へ"]);
  });

  test("記号が1つだけなら選択肢にしない（問題番号など）", async () => {
    const r = await parse("1. 次の計算をしなさい。\n3+4");
    expect(r.choices).toEqual([]);
    expect(r.stemLines).toHaveLength(2);
  });

  test("長い文が並ぶ「1. 2.」は選択肢にしない", async () => {
    const long = "これはとても長い問題文で、三十文字を超えるように書いています。さらに続けます。";
    const r = await parse(`1. ${long}\n2. ${long}`);
    expect(r.choices).toEqual([]);
  });

  test("空の文章でもエラーにならない", async () => {
    const r = await parse("");
    expect(r.choices).toEqual([]);
    expect(r.stem).toBe("");
  });
});

test.describe("問題の種類 detectQuestionType", () => {
  const CASES = [
    ["次のうち正しいものを選べ。\nア．あ\nイ．い", "選択問題（記号で答える）"],
    ["好きな色は？\nア．赤\nイ．青", "選択問題"],
    ["次の（　）に入る語を答えなさい。", "穴埋め問題"],
    ["次の英文を和訳しなさい。\nI like apples very much and play tennis every day.", "英語の問題"],
    ["次の方程式を解きなさい。2x+3=7", "計算・数式の問題"],
    ["次の漢字の読み方を書きなさい。", "漢字・語句の問題"],
    ["理由を100字以内で説明しなさい。", "記述問題"],
    ["きょうの天気", "不明"],
    ["", "不明"],
  ];
  for (const [text, expected] of CASES) {
    test(`${JSON.stringify(text.slice(0, 18))} → ${expected}`, async () => {
      expect(await typeOf(text)).toBe(expected);
    });
  }
});

test.describe("OCRの自信度 collectUncertain", () => {
  const collect = (data) => page.evaluate((d) => window.__classiAssistant.ocr.collectUncertain(d), data);

  test("自信度が低い行と単語を「要確認」にする", async () => {
    const r = await collect({ lines: [
      { text: "数学 課題\n", confidence: 92, words: [{ text: "数学", confidence: 95 }, { text: "課題", confidence: 90 }] },
      { text: "提出期限 11月2O日\n", confidence: 55, words: [{ text: "11月2O日", confidence: 30 }] },
    ] });
    expect(r.hasConfidence).toBe(true);
    expect(r.uncertain).toHaveLength(1);
    expect(r.uncertain[0].text).toBe("提出期限 11月2O日");
    expect(r.uncertain[0].words).toEqual([{ text: "11月2O日", confidence: 30 }]);
  });

  test("行の自信度が高くても、極端に低い単語があれば要確認", async () => {
    const r = await collect({ lines: [{ text: "あいう", confidence: 90, words: [{ text: "う", confidence: 20 }] }] });
    expect(r.uncertain).toHaveLength(1);
  });

  test("blocks の入れ子の形でも読める", async () => {
    const r = await collect({ blocks: [{ paragraphs: [{ lines: [{ text: "あ", confidence: 40, words: [] }] }] }] });
    expect(r.hasConfidence).toBe(true);
    expect(r.uncertain).toHaveLength(1);
  });

  test("自信度の情報がなければ hasConfidence は false（推測で要確認を作らない）", async () => {
    expect(await collect({ text: "あ" })).toEqual({ hasConfidence: false, uncertain: [] });
  });

  test("OCR結果の整形後の行と一致する（空白だらけの行）", async () => {
    const r = await collect({ lines: [{ text: "保 護 者 会 の 案 内\n", confidence: 40, words: [] }] });
    expect(r.uncertain[0].text).toBe("保護者会の案内");
  });
});

test.describe("画像の補正 enhanceImageData", () => {
  test("薄い文字の画像は、明るさの幅が広がる（グレースケール化）", async () => {
    const r = await page.evaluate(() => {
      const img = new ImageData(10, 10);
      for (let i = 0; i < 100; i++) {
        const v = i < 5 ? 120 : 200; // 薄い文字(120)と明るい背景(200)
        img.data.set([v, v, v, 255], i * 4);
      }
      const info = window.__classiAssistant.ocr.enhanceImageData(img);
      return { info, dark: img.data[0], light: img.data[99 * 4], g: img.data[1] === img.data[0] && img.data[2] === img.data[0] };
    });
    expect(r.info.stretched).toBe(true);
    expect(r.dark).toBeLessThan(10);
    expect(r.light).toBeGreaterThan(245);
    expect(r.g).toBe(true);
  });

  test("ほぼ単色の画像は、ノイズを強めない", async () => {
    const r = await page.evaluate(() => {
      const img = new ImageData(4, 4);
      for (let i = 0; i < 16; i++) img.data.set([200, 200, 200, 255], i * 4);
      return window.__classiAssistant.ocr.enhanceImageData(img).stretched;
    });
    expect(r).toBe(false);
  });
});
