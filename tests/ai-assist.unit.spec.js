// ai-assist.js（質問文・回答の整理・下書き・模擬データ・AIの切り替え）の単体テスト。
// ブラウザを使わず、Node.js で直接読み込んで確かめる（通信はしない）。
const { test, expect } = require("@playwright/test");
const AI = require("../ai-assist.js");

const Q = {
  stem: "次のうち、正しいものを選びなさい。",
  choices: [
    { marker: "ア．", text: "光は直進する" },
    { marker: "イ．", text: "音は真空中を伝わる" },
    { marker: "ウ．", text: "水は100℃で凍る 【要確認】" },
  ],
  afterLines: [],
  type: "選択問題（記号で答える）",
};

test.describe("質問文", () => {
  test("問題文・選択肢（順番どおり）・回答の形式・注意が入る", () => {
    const p = AI.buildPrompt(Q);
    expect(p).toContain("【問題文】\n次のうち、正しいものを選びなさい。");
    expect(p.indexOf("ア．光は直進する")).toBeLessThan(p.indexOf("イ．音は真空中を伝わる"));
    expect(p).toContain("ウ．水は100℃で凍る 【要確認】");
    for (const s of AI.SECTIONS) expect(p).toContain(`【${s.label}】`);
    expect(p).toContain("回答の提出や送信はしません");
    expect(p).toContain("選択問題（記号で答える）");
  });

  test("問題文や選択肢がないときは（なし）と書く", () => {
    const p = AI.buildPrompt({});
    expect(p).toContain("【問題文】\n（なし）");
    expect(p).toContain("【選択肢】\n（なし）");
  });
});

test.describe("回答の整理（いろいろな書き方）", () => {
  test("指定どおりの【】見出しを、すべての項目に分ける", () => {
    const r = AI.parseAnswer(AI.mockAnswer(Q));
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.explanation.points).toHaveLength(2);
    expect(r.explanation.candidates).toEqual(["ア"]);
    expect(r.explanation.draft).toContain("答え：ア");
  });

  test("Markdown の見出し・太字・番号つきの見出しも分けられる", () => {
    const text = [
      "はい、解説します。",
      "",
      "## 1. 問題の意味",
      "光と音の性質についての問題です。",
      "",
      "**解き方：** 選択肢を1つずつ確かめます。",
      "",
      "### 重要ポイント",
      "- 光は同じ物質の中を直進する",
      "- 音は真空中を伝わらない",
      "",
      "**答え**",
      "ア",
      "",
      "理由：光は同じ物質の中では直進するからです。",
      "",
      "## よくある間違い",
      "イを選んでしまう。",
    ].join("\n");
    const r = AI.parseAnswer(text);
    expect(r.preface).toBe("はい、解説します。");
    expect(r.explanation.meaning).toBe("光と音の性質についての問題です。");
    expect(r.explanation.method).toBe("選択肢を1つずつ確かめます。");
    expect(r.explanation.points).toEqual(["光は同じ物質の中を直進する", "音は真空中を伝わらない"]);
    expect(r.explanation.candidates).toEqual(["ア"]);
    expect(r.explanation.reason).toBe("光は同じ物質の中では直進するからです。");
    expect(r.explanation.pitfalls).toBe("イを選んでしまう。");
    expect(r.missing).toEqual(["draft"]);
  });

  test("下書きの中の「答え：ア」は見出しにしない", () => {
    const r = AI.parseAnswer("【回答候補】\n・ア\n\n【回答の下書き】\n答え：ア\n理由：光は直進するから");
    expect(r.explanation.candidates).toEqual(["ア"]);
    expect(r.explanation.draft).toBe("答え：ア\n理由：光は直進するから");
  });

  test("本文の途中の「答え：ア」は見出しにしない", () => {
    const r = AI.parseAnswer("【解き方・考え方】\n順に確かめると、\n答え：ア になります。");
    expect(r.explanation.method).toContain("答え：ア になります。");
    expect(r.explanation.candidates).toEqual([]);
  });

  test("見出しがない回答は、全文を「解き方・考え方」に入れる", () => {
    const r = AI.parseAnswer("この問題はアが正しいです。光は直進するからです。");
    expect(r.ok).toBe(false);
    expect(r.explanation.method).toBe("この問題はアが正しいです。光は直進するからです。");
  });

  test("空の回答・コードブロック・制御文字・長すぎる回答を安全に扱う", () => {
    expect(AI.parseAnswer("").ok).toBe(false);
    const r = AI.parseAnswer("```\n【問題の意味】\nテスト\u0007です\n```");
    expect(r.explanation.meaning).toBe("テストです");
    const long = AI.parseAnswer("【解き方・考え方】\n" + "あ".repeat(30000));
    expect(long.truncated).toBe(true);
    expect(long.explanation.method.length).toBeLessThanOrEqual(20000);
  });

  test("箇条書きの記号（・ - 1. ①）を外して1つずつにする", () => {
    const r = AI.parseAnswer("【重要ポイント】\n・一つ目\n- 二つ目\n1. 三つ目\n② 四つ目");
    expect(r.explanation.points).toEqual(["一つ目", "二つ目", "三つ目", "四つ目"]);
  });
});

test.describe("回答の下書き", () => {
  test("AIの下書きがあれば、それを使う", () => {
    expect(AI.buildDraft({ draft: "答え：イ", candidates: ["ア"] }, Q)).toBe("答え：イ");
  });
  test("なければ、回答候補（選択肢の内容つき）と理由から作る", () => {
    expect(AI.buildDraft({ candidates: ["ア"], reason: "光は直進するから" }, Q)).toBe("答え：ア．光は直進する\n理由：光は直進するから");
  });
  test("選択肢にない候補は、そのまま使う", () => {
    expect(AI.buildDraft({ candidates: ["3cm"] }, Q)).toBe("答え：3cm");
  });
  test("回答候補もなければ、空", () => {
    expect(AI.buildDraft({}, Q)).toBe("");
  });
});

test.describe("AIの切り替え（プロバイダー）", () => {
  test("無料の手動プロバイダーと模擬データが用意されている", () => {
    const ids = AI.listProviders().map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["claude", "chatgpt", "gemini", "other", "mock"]));
    for (const p of AI.listProviders()) expect(p.cost).toBe("free");
  });

  test("模擬データは「模擬データ」と明記し、通信せずに回答を返す", async () => {
    const text = await AI.getProvider("mock").ask(AI.buildPrompt(Q), Q);
    expect(text).toContain("模擬データ");
    expect(text).toContain("正解とは限りません");
  });

  test("将来のAPIは registerProvider で追加でき、同じ整理の流れで使える", async () => {
    AI.registerProvider({
      id: "test-api", label: "テスト用API", mode: "auto", cost: "paid",
      ask: async (prompt) => `【回答候補】\n・イ\n（受け取った質問文：${prompt.length}文字）`,
    });
    const p = AI.getProvider("test-api");
    expect(p.mode).toBe("auto");
    const r = AI.parseAnswer(await p.ask(AI.buildPrompt(Q), Q));
    expect(r.explanation.candidates[0]).toBe("イ");
    expect(() => AI.registerProvider({ id: "bad", label: "x", mode: "auto" })).toThrow();
  });

  test("知らない id は Claude（手動）として扱う", () => {
    expect(AI.getProvider("unknown").id).toBe("claude");
  });

  test("このファイルは通信する関数を使っていない", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "ai-assist.js"), "utf8");
    expect(src).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|localStorage|indexedDB/);
  });
});
