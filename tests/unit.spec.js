// 日付解析・分類・行のまとめ方・並び替え（47件）と、OCR結果の整形・動作チェックの判定の単体テスト
// index.html が公開している window.__classiAssistant の関数をブラウザ内で直接呼び出す。
// 「今日」は 2026-11-16 10:00（日本時間）に固定する。
const { test, expect } = require("@playwright/test");

const NOW = new Date("2026-11-16T10:00:00+09:00");

// このファイルの単体テストは1つのページを共有し、1つのワーカーで順番に実行する
test.describe.configure({ mode: "default" });

/** @type {import('@playwright/test').Page} */
let page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ timezoneId: "Asia/Tokyo", locale: "ja-JP" });
  await page.clock.install({ time: NOW });
  // 外部への通信はすべて遮断する
  await page.route("**/*", (route) =>
    route.request().url().startsWith("http://127.0.0.1") ? route.continue() : route.abort());
  await page.goto("/index.html");
  await page.waitForFunction(() => !!window.__classiAssistant);
});

test.afterAll(async () => { await page.close(); });

const call = (fn, arg) => page.evaluate(([f, a]) => window.__classiAssistant[f](a), [fn, arg]);

/* ---------- 日付解析（20件） ---------- */
const DATE_CASES = [
  ["2026年11月20日", { date: "2026-11-20", time: "" }],
  ["提出期限：2026年11月20日（金）17：00", { date: "2026-11-20", time: "17:00" }],
  ["２０２６／１１／２０", { date: "2026-11-20", time: "" }],
  ["2026-11-20", { date: "2026-11-20", time: "" }],
  ["2026.11.20", { date: "2026-11-20", time: "" }],
  ["11/20(金) 17:00", { date: "2026-11-20", time: "17:00" }],
  ["期限 11月20日 23:59", { date: "2026-11-20", time: "23:59" }],
  ["１２月５日", { date: "2026-12-05", time: "" }],
  ["1/8 提出", { date: "2027-01-08", time: "" }], // 半年以上前になるので翌年とみなす
  ["11/1 提出", { date: "2026-11-01", time: "" }], // 少し前なら今年（期限超過）
  ["明日まで", { date: "2026-11-17", time: "" }],
  ["今日中に提出 期限 本日", { date: "2026-11-16", time: "" }],
  ["明後日まで", { date: "2026-11-18", time: "" }],
  ["【重要】明日の時間割変更について", null], // 期限を表す言葉がない相対日付は推測しない
  ["2026年2月30日", null], // 存在しない日付
  ["13/40", null],
  ["英語 ワーク p.10-15", null], // ページ番号を日付と誤認しない
  ["10:00 集合", null], // 時刻だけでは期限にしない
  ["11/20 25:00", { date: "2026-11-20", time: "" }], // 不正な時刻は無視
  ["", null],
];

test.describe("日付解析 parseDue", () => {
  for (const [input, expected] of DATE_CASES) {
    test(`「${input || "(空文字)"}」→ ${expected ? expected.date + (expected.time ? " " + expected.time : "") : "期限なし"}`, async () => {
      expect(await call("parseDue", input)).toEqual(expected);
    });
  }
});

/* ---------- 分類（10文 × 種類・分類 = 20件） ---------- */
const CLASSIFY_CASES = [
  ["数学 課題プリント3", "task", "一般"],
  ["英語 宿題 ワーク p.10-15", "task", "一般"],
  ["進路希望調査票 提出", "task", "手続き"],
  ["理科 レポート", "task", "一般"],
  ["【重要】時間割変更について", "notice", "重要"],
  ["台風による臨時休校のお知らせ", "notice", "重要"],
  ["保護者会のご案内", "notice", "行事・予定"],
  ["期末考査の範囲について", "notice", "行事・予定"],
  ["アンケート回答のお願い", "notice", "手続き"],
  ["図書室だより", "notice", "一般"],
];

test.describe("課題とお知らせの分類", () => {
  for (const [input, kind, category] of CLASSIFY_CASES) {
    test(`種類：「${input}」→ ${kind === "task" ? "課題" : "お知らせ"}`, async () => {
      expect(await call("classifyKind", input)).toBe(kind);
    });
    test(`分類：「${input}」→ ${category}`, async () => {
      expect(await call("classifyCategory", input)).toBe(category);
    });
  }
});

/* ---------- 行のまとめ方（5件） ---------- */
test.describe("読み取り結果からカードを作る extractItems", () => {
  const OCR = "数学 課題プリント\n提出期限：11/20 17:00\n図書だより\n国語 宿題\n英語 宿題 11/18";

  test("関係のある行だけがカードになる", async () => {
    expect((await call("extractItems", OCR)).length).toBe(3);
  });

  test("期限だけの行は、すぐ上の課題の期限になる", async () => {
    const [first] = await call("extractItems", OCR);
    expect([first.title, first.due, first.time, first.kind]).toEqual(["数学 課題プリント", "2026-11-20", "17:00", "task"]);
  });

  test("期限が書かれていない課題は期限が空（＝不明）", async () => {
    const items = await call("extractItems", OCR);
    expect([items[1].title, items[1].due]).toEqual(["国語 宿題", ""]);
  });

  test("同じ行にある期限を読み取る", async () => {
    const items = await call("extractItems", OCR);
    expect(items[2].due).toBe("2026-11-18");
  });

  test("該当する行がなければ、従来どおり全行をカードにする", async () => {
    const items = await call("extractItems", "あいう\nえお");
    expect(items.map((i) => i.title)).toEqual(["あいう", "えお"]);
  });
});

/* ---------- 並び替え（2件） ---------- */
test.describe("期限順ソート sortItems", () => {
  test("日付順・同じ日は時刻順（時刻なしは最後）・同条件は重要が先・期限不明は最後", async () => {
    const mk = (id, due, time = "", category = "一般") => ({ id, due, time, category });
    const sorted = await call("sortItems", [
      mk(1, ""), mk(2, "2026-11-20", "17:00"), mk(3, "2026-11-18"), mk(4, "2026-11-20", "09:00"),
      mk(5, "2026-11-20"), mk(6, "", "", "重要"), mk(7, "2026-11-18", "", "重要"), mk(8, "2025-12-01"),
    ]);
    expect(sorted.map((i) => i.id)).toEqual([8, 7, 3, 4, 2, 5, 6, 1]);
  });

  test("空の一覧でもエラーにならない", async () => {
    expect(await call("sortItems", [])).toEqual([]);
  });
});

/* ---------- OCR結果の整形 cleanupOcrText ---------- */
test.describe("OCR結果の整形 cleanupOcrText", () => {
  const clean = (text) => page.evaluate((t) => window.__classiAssistant.ocr.cleanupOcrText(t), text);

  test("OCR特有の「1文字ずつ空白が入った行」は日本語の空白を取り除く", async () => {
    expect(await clean("【 重 要 】 保 護 者 会 の お 知ら せ")).toBe("【重要】保護者会のお知らせ");
    expect(await clean("お 知ら せ ・ 課 題 一 覧")).toBe("お知らせ・課題一覧");
  });

  test("元からある単語の区切り（空白が少ない行）は残す", async () => {
    expect(await clean("数学 課題プリント3")).toBe("数学 課題プリント3");
    expect(await clean("英語 宿題 ワーク p.10-15")).toBe("英語 宿題 ワーク p.10-15");
  });

  test("数字と年・月・日の間の空白を取り除き、日付として読めるようにする", async () => {
    const text = await clean("提出 期限 : 2026 年 11 月 20 日 17:00");
    expect(text).toBe("提出 期限 : 2026年11月20日 17:00");
    expect(await call("parseDue", text)).toEqual({ date: "2026-11-20", time: "17:00" });
  });

  test("英単語の空白と改行は残し、3行以上の空行は1行にまとめる", async () => {
    expect(await clean("English Homework p.10\r\n\n\n\n数学 課題")).toBe("English Homework p.10\n\n数学 課題");
  });

  test("実際のOCR結果を整形すると、課題と期限が正しく分類される", async () => {
    const raw = "お 知ら せ ・ 課 題 一 覧\n\n数 学 課題 プリ ント 3\n\n提出 期限 : 2026 年 11 月 20 日 17:00\n【 重 要 】 保 護 者 会 の お 知ら せ\nEnglish Homework p.10";
    const items = await call("extractItems", await clean(raw));
    const task = items.find((i) => i.title.includes("課題プリント"));
    expect([task.kind, task.due, task.time]).toEqual(["task", "2026-11-20", "17:00"]);
    const notice = items.find((i) => i.title.includes("保護者会"));
    expect([notice.kind, notice.category]).toEqual(["notice", "重要"]);
  });
});

/* ---------- 動作チェックの判定 judgeSelftest ---------- */
test.describe("動作チェックの判定 judgeSelftest", () => {
  const judge = (text) => page.evaluate((t) => window.__classiAssistant.ocr.judgeSelftest(t).ok, text);

  test("日本語・数字・英語がすべて読めていれば成功", async () => {
    expect(await judge("数 学 課題 プリ ント\n提出 期限 11 月 20 日\nEnglish Homework")).toBe(true);
  });

  test("英語が読めていなければ失敗（日本語だけのOCRになっていないかを確認）", async () => {
    expect(await judge("数学 課題プリント\n提出期限 11月20日")).toBe(false);
  });

  test("日本語が読めていなければ失敗（英語だけのOCRになっていないかを確認）", async () => {
    expect(await judge("English Homework 11 20")).toBe(false);
  });
});

/* ======================= OCR精度改善（ocr-pipeline.js）の単体テスト ======================= */
const O = (fn, ...args) => page.evaluate(([f, a]) => window.ClassiOcr[f](...a), [fn, args]);

test.describe("英語の後処理 fixEnglish（I・1・l の取り違え、空白、句読点）", () => {
  test("英単語に挟まれた単独の「|」「l」は代名詞の I にし、直した箇所を記録する", async () => {
    const r = await O("fixEnglish", "to | spoke whom");
    expect(r.text).toBe("to I spoke whom");
    expect(r.changes[0]).toMatchObject({ from: "|", to: "I" });
    expect((await O("fixEnglish", "whom l spoke to")).text).toBe("whom I spoke to");
  });

  test("「1」は、代名詞の I が来る位置（文頭・to/that/whom などの後）でだけ I にする", async () => {
    expect((await O("fixEnglish", "1 spoke to him yesterday.")).text).toBe("I spoke to him yesterday.");
    expect((await O("fixEnglish", "He is the man. 1 spoke to him.")).text).toBe("He is the man. I spoke to him.");
    expect((await O("fixEnglish", "to 1 spoke whom")).text).toBe("to I spoke whom");
  });

  test("「1」を無条件に I にしない（数字として正しい可能性がある所は直さずに「要確認」として記録）", async () => {
    const r = await O("fixEnglish", "Read page 1 of the book.");
    expect(r.text).toBe("Read page 1 of the book.");
    expect(r.changes.some((c) => c.uncertain && c.from === "1" && c.to === "1")).toBe(true);
    expect((await O("fixEnglish", "Question 1 2 3")).text).toBe("Question 1 2 3");
    expect((await O("fixEnglish", "p.10 and 01")).text).toBe("p.10 and 01");
  });

  test("I が次の語とくっついた「lspoke」「1spoke」は、Tesseract の辞書にない語のときだけ分ける（要確認）", async () => {
    const r = await O("fixEnglish", "whom lspoke to", [{ text: "lspoke", in_dictionary: false }]);
    expect(r.text).toBe("whom I spoke to");
    expect(r.changes[0].uncertain).toBe(true);
    // 辞書にある語（late など）や、辞書の情報がない場合は分けない
    expect((await O("fixEnglish", "I was late", [{ text: "late", in_dictionary: true }])).text).toBe("I was late");
    expect((await O("fixEnglish", "whom lspoke to")).text).toBe("whom lspoke to");
  });

  test("単語の途中の大文字 I は、辞書にない語のときだけ小文字の l にする", async () => {
    expect((await O("fixEnglish", "heIlo world", [{ text: "heIlo", in_dictionary: false }])).text).toBe("hello world");
    expect((await O("fixEnglish", "iPhone", [{ text: "iPhone", in_dictionary: false }])).text).toBe("iPhone");
  });

  test("句読点の前の空白を消し、文末の句読点の後に空白を入れ、連続する空白を1つにする", async () => {
    expect((await O("fixEnglish", "He is the man .I spoke  to him yesterday .")).text).toBe("He is the man. I spoke to him yesterday.");
    expect((await O("fixEnglish", "He is the man ( _ ) yesterday.")).text).toBe("He is the man (     ) yesterday.");
  });

  test("選択肢の英文の語順・文法は変えない（OCRの評価用の文をそのまま保つ）", async () => {
    for (const t of ["to I spoke whom", "to I spoke", "whom I spoke to", "I spoke to whom"]) {
      expect((await O("fixEnglish", t)).text).toBe(t);
    }
  });
});

test.describe("日本語の後処理 fixJapanese", () => {
  test("日本語の文字の間の空白を取り除き、半角の括弧・読点を全角にそろえる", async () => {
    expect(await O("fixJapanese", "次 の 英文 を 書きかえる とき , ( _ ) に 適する")).toBe("次の英文を書きかえるとき，（ ）に適する");
    expect(await O("fixJapanese", "(一 つ の 文 に )")).toBe("（一つの文に）");
    expect(await O("fixJapanese", "小 問 01")).toBe("小問01");
  });

  test("日付と時刻の間の空白は残す", async () => {
    expect(await O("fixJapanese", "2026 年 11 月 20 日 17:00")).toBe("2026年11月20日 17:00");
  });
});

test.describe("文字種の判定と、行の分割 splitLineChunks", () => {
  test("日本語・英語・記号を判定する", async () => {
    expect(await O("scriptClass", "次の問い")).toBe("ja");
    expect(await O("scriptClass", "spoke")).toBe("latin");
    expect(await O("scriptClass", "(01)")).toBe("neutral");
  });

  test("英文の後ろの日本語の（ ）書きは、別の部分（日本語）として分け、順番を保つ", async () => {
    const w = (text, x0, x1) => ({ text, bbox: { x0, x1, y0: 0, y1: 30 } });
    const [line] = await O("splitLineChunks", [{ bbox: { x0: 0, x1: 900, y0: 0, y1: 30 }, words: [w("He", 0, 30), w("is", 40, 60), w("yesterday.", 70, 200), w("(一つの文に)", 260, 420)] }]);
    expect(line.chunks.map((c) => [c.cls, c.text])).toEqual([["latin", "He is yesterday."], ["ja", "(一つの文に)"]]);
  });

  test("行頭で大きく離れた1文字は、選択肢の記号の候補として独立させる（「エ」が英字の I と読まれても英文に混ぜない）", async () => {
    const w = (text, x0, x1) => ({ text, bbox: { x0, x1, y0: 0, y1: 30 } });
    const [line] = await O("splitLineChunks", [{ bbox: { x0: 0, x1: 400, y0: 0, y1: 30 }, words: [w("I", 0, 20), w("I", 60, 66), w("spoke", 76, 150)] }]);
    expect(line.chunks.map((c) => [c.cls, c.text])).toEqual([["ja", "I"], ["latin", "I spoke"]]);
    // 普通の英文の「I spoke」（語の間隔が小さい）は分けない
    const [line2] = await O("splitLineChunks", [{ bbox: { x0: 0, x1: 400, y0: 0, y1: 30 }, words: [w("I", 0, 8), w("spoke", 18, 90)] }]);
    expect(line2.chunks.map((c) => c.text)).toEqual(["I spoke"]);
  });
});

test.describe("問題の構造 parseQuestion（問題文・英文・選択肢）", () => {
  const LINES = [
    "練習問題_関係代名詞と前置詞01", "次の問いに答えなさい。", "小問01",
    "次の英文を指示にしたがって書きかえるとき，（ ）に適するものを選びなさい。",
    "He is the man. I spoke to him yesterday. （一つの文に）", "=He is the man (     ) yesterday.", "選択肢",
    "ア to I spoke whom", "イ to I spoke", "ウ whom I spoke to", "工 I spoke to whom",
  ].map((text) => ({ text }));

  test("タイトル・問題文・小問・英文・指示・書き換え・選択肢に分ける", async () => {
    const q = await O("parseQuestion", LINES);
    expect(q.title).toBe("練習問題_関係代名詞と前置詞01");
    expect(q.instruction).toBe("次の問いに答えなさい。");
    expect(q.subNumber).toBe("01");
    expect(q.subInstruction).toBe("次の英文を指示にしたがって書きかえるとき，（ ）に適するものを選びなさい。");
    expect(q.english).toBe("He is the man. I spoke to him yesterday.");
    expect(q.direction).toBe("（一つの文に）");
    expect(q.rewrite).toBe("He is the man (     ) yesterday.");
  });

  test("選択肢はア・イ・ウ・エの順番のまま、文章も変えずに保つ", async () => {
    const q = await O("parseQuestion", LINES);
    expect(q.choices.map((c) => [c.label, c.text])).toEqual([
      ["ア", "to I spoke whom"], ["イ", "to I spoke"], ["ウ", "whom I spoke to"], ["エ", "I spoke to whom"],
    ]);
  });

  test("取り違えやすい記号（工→エ）や行頭の「=」（→⇒）は、判断した内容を「要確認」として記録する", async () => {
    const q = await O("parseQuestion", LINES);
    expect(q.choices[3]).toMatchObject({ label: "エ", labelRead: "工", labelUncertain: true });
    expect(q.notes.some((n) => n.uncertain && n.from === "=" && n.to === "⇒")).toBe(true);
  });

  test("問題文と選択肢を混同しない（英文・問題文に選択肢が入らず、選択肢に問題文が入らない）", async () => {
    const q = await O("parseQuestion", LINES);
    for (const c of q.choices) {
      expect(q.english).not.toContain(c.text);
      expect(q.instruction + q.subInstruction).not.toContain(c.text);
      expect(c.text).not.toMatch(/[\p{Script=Han}\p{Script=Hiragana}]/u);
    }
    expect(q.other).toEqual([]);
  });

  test("選択肢の記号の順番が想定と違っても並べ替えず、そのまま「要確認」にする", async () => {
    const q = await O("parseQuestion", ["選択肢", "ア one", "ウ three", "イ two"].map((text) => ({ text })));
    expect(q.choices.map((c) => c.label)).toEqual(["ア", "ウ", "イ"]);
    expect(q.notes.filter((n) => n.uncertain).length).toBe(2);
  });

  test("構造から読み取り結果の文章に戻すと、元の順番になる", async () => {
    const q = await O("parseQuestion", LINES);
    expect(await O("formatQuestion", q)).toBe([
      "練習問題_関係代名詞と前置詞01", "次の問いに答えなさい。", "小問01",
      "次の英文を指示にしたがって書きかえるとき，（ ）に適するものを選びなさい。",
      "He is the man. I spoke to him yesterday. （一つの文に）", "⇒He is the man (     ) yesterday.", "選択肢",
      "ア to I spoke whom", "イ to I spoke", "ウ whom I spoke to", "エ I spoke to whom",
    ].join("\n"));
  });

  test("英文の途中の不自然な改行をつなげる（文末記号で終わらず、次の行が小文字で始まる場合だけ）", async () => {
    expect(await O("joinEnglishLines", ["He is the man", "who spoke to me.", "I know him."])).toBe("He is the man who spoke to me.\nI know him.");
  });
});

test.describe("画面構造の解析 analyzeLayout（固定座標に頼らない）", () => {
  /** Classi に似た画面を指定した大きさで描き、解析結果を返す */
  const layoutOf = (w, h) => page.evaluate(([w, h]) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const x = c.getContext("2d");
    const u = h / 100; // 画面の高さに対する割合で描く
    x.fillStyle = "#fff"; x.fillRect(0, 0, w, h);
    x.fillStyle = "#00a0e9"; x.fillRect(0, 0, w, 9 * u);                 // 上部のバー
    x.fillStyle = "#111"; x.fillRect(w * 0.2, 9 * u, w * 0.6, 6 * u);     // 動画プレイヤー
    x.fillStyle = "#333"; x.font = `${Math.round(2.4 * u)}px sans-serif`;
    for (let i = 0; i < 6; i++) x.fillText("Text line " + i + " 本文", w * 0.2, 22 * u + i * 6 * u);
    x.fillStyle = "#f0f0f0"; x.fillRect(0, 70 * u, w, 13 * u);             // 回答欄（グレー）
    x.fillStyle = "#2680f0"; x.fillRect(w * 0.3, 85 * u, w * 0.45, 5 * u); // 答え合わせボタン
    x.fillStyle = "#00a0e9"; x.fillRect(0, 92 * u, w, 8 * u);             // 下部のバー
    const lay = ClassiOcr.analyzeLayout(x.getImageData(0, 0, w, h));
    return { content: lay.content, lines: lay.lines.length, h };
  }, [w, h]);

  for (const [w, h] of [[2360, 1640], [1180, 820], [1640, 2360]]) {
    test(`${w}×${h} の画面でも、バー・動画・回答欄・ボタンを除いた本文の6行だけを検出する`, async () => {
      const r = await layoutOf(w, h);
      expect(r.lines).toBe(6);
      expect(r.content.y).toBeGreaterThanOrEqual(Math.floor(h * 0.15)); // 動画プレイヤーより下
      expect(r.content.y + r.content.h).toBeLessThanOrEqual(Math.ceil(h * 0.70)); // 回答欄（グレー）より上
    });
  }

  test("UIのない普通の画像は、全体を本文として扱う", async () => {
    const r = await page.evaluate(() => {
      const c = document.createElement("canvas"); c.width = 600; c.height = 200;
      const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, 600, 200);
      x.fillStyle = "#000"; x.font = "30px sans-serif"; x.fillText("数学 課題 11/30", 20, 60); x.fillText("English", 20, 140);
      const lay = ClassiOcr.analyzeLayout(x.getImageData(0, 0, 600, 200));
      return { excluded: lay.excluded.length, lines: lay.lines.length };
    });
    expect(r).toEqual({ excluded: 0, lines: 2 });
  });
});

test.describe("下線（_）の検出 findUnderscoreGaps", () => {
  const detect = (draw) => page.evaluate((drawSrc) => {
    const c = document.createElement("canvas"); c.width = 400; c.height = 60;
    const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, 400, 60);
    x.fillStyle = "#000";
    // 2つの「語」（黒い四角）と、その間の描画
    x.fillRect(20, 15, 60, 30); x.fillRect(130, 15, 60, 30);
    new Function("x", drawSrc)(x);
    const words = [{ srcRect: { x: 20, y: 15, w: 60, h: 30 } }, { srcRect: { x: 130, y: 15, w: 60, h: 30 } }];
    return ClassiOcr.findUnderscoreGaps(x.getImageData(0, 0, 400, 60), words, 15, 45, 0, 399);
  }, draw);

  test("語の間の下側の細い横線は下線と判断する", async () => {
    expect(await detect("x.fillRect(88, 44, 34, 1);")).toEqual([0]);
  });
  test("上に文字が続いている線（「し」の下のカーブのような形）や、線がない隙間は下線にしない", async () => {
    expect(await detect("x.fillRect(88, 44, 34, 1); x.fillRect(88, 20, 2, 25);")).toEqual([]);
    expect(await detect("")).toEqual([]);
  });
  test("行の中ほどの横線（漢字の「一」など）は下線にしない", async () => {
    expect(await detect("x.fillRect(88, 29, 34, 2);")).toEqual([]);
  });
});

test.describe("修正前と修正後の比較 diffTokens", () => {
  test("英単語は単語ごと、日本語は1文字ごとに比べ、空白の違いは無視する", async () => {
    const ops = await O("diffTokens", "to | spoke\n次 の 問い", "to I spoke\n次の問い");
    expect(ops.filter((o) => o.op !== "same")).toEqual([{ op: "del", text: "|" }, { op: "add", text: "I" }]);
  });
});
