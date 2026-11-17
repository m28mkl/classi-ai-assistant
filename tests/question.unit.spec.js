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

// iPad の実機テスト（架空の問題画像）で起きた読み取り結果を、そのまま再現する
const REAL_CASE = [
  "2（　）に入る適切な語を、ア〜エから1つ選びなさい。",
  "This is the book (     ) I bought yesterday.",
  "ア who イ which ウ where 工 when",
  "3 次の英文が正しければ〇、誤っていれば X を（ ）に書きなさい。",
  "(1) He don’t like tomatoes. (     )",
  "(2) She plays the piano very well. (     )",
  "選択肢",
  "ア who イ which ウ where 工 when",
].join("\n");

test.describe("OCRの改善：「エ」と「工」・1行に並んだ選択肢・次の問題が混ざる問題", () => {
  test("実機テストの再現：選択肢が4つに分かれ、「工」は順番から「エ」と判断し、次の問題は別にする", async () => {
    const r = await parse(REAL_CASE);
    expect(r.stemLines).toEqual(["2（　）に入る適切な語を、ア〜エから1つ選びなさい。", "This is the book (     ) I bought yesterday."]);
    expect(r.choices.map((c) => [c.marker, c.text])).toEqual([["ア", "who"], ["イ", "which"], ["ウ", "where"], ["エ", "when"]]);
    expect(r.choices[3].guess).toMatchObject({ from: "工", to: "エ" });
    expect(r.choices.slice(0, 3).every((c) => !c.guess)).toBe(true);
    expect(r.labelGuesses).toHaveLength(1);
    expect(r.afterLines).toEqual([]);
    expect(r.otherLines[0]).toBe("3 次の英文が正しければ〇、誤っていれば X を（ ）に書きなさい。");
    expect(r.otherLines).toContain("(2) She plays the piano very well. (     )");
    // 次の問題の文章が、選択肢や問題文に入らない
    for (const c of r.choices) expect(c.text).not.toMatch(/次の英文|tomatoes|piano/);
  });

  test("最後の選択肢と同じ行に次の問題が続いていても、そこで切り分ける", async () => {
    const r = await parse("2（　）に入る語を選びなさい。\nア who イ which ウ where 工 when 3 次の英文が正しければ〇を書きなさい。\n(1) He don’t like it.");
    expect(r.choices.map((c) => c.text)).toEqual(["who", "which", "where", "when"]);
    expect(r.otherLines).toEqual(["3 次の英文が正しければ〇を書きなさい。", "(1) He don’t like it."]);
  });

  test("1行ずつの選択肢でも、ウの次の行の「工」は「エ」と判断する（要確認）", async () => {
    const r = await parse("問1 正しいものを選びなさい。\nア．光は直進する\nイ．音は真空中を伝わる\nウ．水は0℃で凍る\n工．氷は水に沈む");
    expect(r.choices.map((c) => c.marker)).toEqual(["ア．", "イ．", "ウ．", "エ．"]);
    expect(r.choices[3]).toMatchObject({ text: "氷は水に沈む", guess: { from: "工", to: "エ" } });
  });

  test("選択肢の位置ではない「工」（工場・工夫など）は読みかえない", async () => {
    const r = await parse("工場の見学について答えなさい。\nア．工夫する\nイ．工作する");
    expect(r.stem).toBe("工場の見学について答えなさい。");
    expect(r.choices.map((c) => c.text)).toEqual(["工夫する", "工作する"]);
    expect(r.labelGuesses).toEqual([]);
  });

  test("文の中の「ア〜エ」や、カタカナで始まる言葉は、選択肢として分けない", async () => {
    const r = await parse("ア〜エから1つ選びなさい。\nアメリカ イギリス フランス");
    expect(r.choices).toEqual([]);
    expect(r.stemLines).toHaveLength(2);
  });

  test("「(1)」「(2)」のような小さな設問の番号では、問題を切り分けない", async () => {
    const r = await parse("3 次の英文が正しければ〇、誤っていれば X を書きなさい。\n(1) He don’t like tomatoes.\n(2) She plays the piano.");
    expect(r.otherLines).toEqual([]);
    expect(r.choices.map((c) => c.marker)).toEqual(["(1)", "(2)"]);
  });

  test("「問3」「【3】」で始まる次の問題も切り分ける", async () => {
    expect((await parse("問2 選びなさい。\nア．あ\nイ．い\n問3 次の文を読みなさい。")).otherLines).toEqual(["問3 次の文を読みなさい。"]);
    expect((await parse("【2】選びなさい。\nア．あ\nイ．い\n【3】次の文を読みなさい。")).otherLines).toEqual(["【3】次の文を読みなさい。"]);
  });

  test("問題番号が1つだけなら切り分けない（今までどおり）", async () => {
    const r = await parse("1. 次の計算をしなさい。\n3+4");
    expect(r.otherLines).toEqual([]);
  });

  test("選択肢の直前の「選択肢」という見出しは、問題文に入れない", async () => {
    const r = await parse("次から選びなさい。\n選択肢\nア．あ\nイ．い");
    expect(r.stemLines).toEqual(["次から選びなさい。"]);
  });
});

const cleanup = (text) => page.evaluate((t) => window.__classiAssistant.ocr.cleanupOcrText(t), text);

test.describe("最終レビューの修正：数字で始まる行・日本語の選択肢", () => {
  test("「2つ選びなさい」のように数字で始まる折り返しの行で、問題を切り分けない", async () => {
    const r = await parse("問1 次の中から正しいものを\n2つ選びなさい。\nア．東京\nイ．大阪\nウ．名古屋");
    expect(r.otherLines).toEqual([]);
    expect(r.stemLines).toEqual(["問1 次の中から正しいものを", "2つ選びなさい。"]);
    expect(r.choices.map((c) => c.text)).toEqual(["東京", "大阪", "名古屋"]);
  });

  test("「3人の意見」「3.5cm」で始まる行も、問題番号とみなさない", async () => {
    expect((await parse("問2 次の文章を読みなさい。\nア．賛成\nイ．反対\n3人の意見を読み、答えなさい。")).otherLines).toEqual([]);
    expect((await parse("問2 長さを答えなさい。\nア．1cm\nイ．2cm\n3.5cmの長さを求めなさい。")).otherLines).toEqual([]);
  });

  test("「3 次の…なさい。」「3．次の…なさい。」は、今までどおり次の問題とみなす", async () => {
    expect((await parse("問2 選びなさい。\nア．あ\nイ．い\n3 次の英文を書きなさい。")).otherLines).toEqual(["3 次の英文を書きなさい。"]);
    expect((await parse("問2 選びなさい。\nア．あ\nイ．い\n3．次の英文を書きなさい。")).otherLines).toEqual(["3．次の英文を書きなさい。"]);
  });

  test("日本語の選択肢が1行に並んでいても、4つに分ける（「工」は「エ」と判断して要確認）", async () => {
    const r = await parse("問1 日本の首都を選びなさい。\nア 東京 イ 大阪 ウ 名古屋 工 福岡");
    expect(r.choices.map((c) => [c.marker, c.text])).toEqual([["ア", "東京"], ["イ", "大阪"], ["ウ", "名古屋"], ["エ", "福岡"]]);
    expect(r.choices[3].guess).toMatchObject({ from: "工", to: "エ" });
  });

  test("記号の後に空白も点もない日本語の選択肢（「ア東京」）も、ア・イ・ウの順に3行以上続けば分ける", async () => {
    const r = await parse("問1 日本の首都を選びなさい。\nア東京\nイ大阪\nウ名古屋\n工福岡");
    expect(r.choices.map((c) => c.text)).toEqual(["東京", "大阪", "名古屋", "福岡"]);
    expect(r.choices[3].guess).toMatchObject({ from: "工", to: "エ" });
    // 2行だけ（「アメリカ」「イギリス」）は、普通の言葉の可能性があるので分けない
    expect((await parse("国の名前\nアメリカ\nイギリス")).choices).toEqual([]);
  });

  test("OCRの空白の整理で、1行に並んだ日本語の選択肢の区切りを消さない", async () => {
    expect(await cleanup("ア 東 京 イ 大 阪 ウ 名 古 屋")).toBe("ア 東京 イ 大阪 ウ 名古屋");
    expect(await cleanup("保 護 者 会 の お 知 ら せ")).toBe("保護者会のお知らせ");
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
