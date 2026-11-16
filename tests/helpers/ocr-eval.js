// OCRの評価：正解データと比べて文字誤り率（CER）を求める
// - 日本語の項目は空白を無視、英語の項目は連続する空白を1つにして比べる
// - 全角・半角（NFKC）と、読点の「、」「，」「,」の違いは同じものとして扱う（画面は「，」、正解データは「、」のため）
// - 空欄の括弧（ ）は中の空白の数を問わない
// - 出力の中から正解に最も近い部分を探して比べる（不要なUIの文字が混ざっていても項目ごとに公平に比較できる）

function norm(s, kind) {
  let t = (s || "").normalize("NFKC").replace(/[、，]/g, ",").replace(/\(\s*\)/g, "()");
  t = kind === "ja" ? t.replace(/\s+/g, "") : t.replace(/\s+/g, " ").trim();
  return t.replace(/\(\s*\)/g, "()");
}

function levenshtein(a, b) {
  const A = [...a], B = [...b];
  let prev = Array.from({ length: B.length + 1 }, (_, j) => j);
  for (let i = 1; i <= A.length; i++) {
    const cur = [i];
    for (let j = 1; j <= B.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[B.length];
}

/** 文字列 text の中で、pattern に最も近い部分との編集距離（部分一致の編集距離） */
function substringDistance(pattern, text) {
  const P = [...pattern], T = [...text];
  let prev = new Array(T.length + 1).fill(0); // 開始位置は自由
  for (let i = 1; i <= P.length; i++) {
    const cur = [i];
    for (let j = 1; j <= T.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (P[i - 1] === T[j - 1] ? 0 : 1));
    prev = cur;
  }
  return Math.min(...prev); // 終了位置も自由
}

/** 正解の文字列 expected が OCR結果 text の中でどれだけ正しく読めているか（文字誤り率 0〜1。1行ずつ探す） */
function fieldCer(expected, text, kind) {
  const e = norm(expected, kind);
  if (!e.length) return 0;
  let best = Infinity;
  for (const line of text.split("\n")) best = Math.min(best, substringDistance(e, norm(line, kind)));
  return Math.min(1, best / [...e].length);
}

const FIELDS = [
  ["title", "ja"], ["instruction", "ja"], ["subInstruction", "ja"], ["english", "en"], ["direction", "ja"], ["rewrite", "en"],
];

/** 正解データの各項目について文字誤り率を求める */
function evaluate(expected, text) {
  const result = {};
  for (const [key, kind] of FIELDS) result[key] = fieldCer(expected[key], text, kind);
  result.subNumber = fieldCer("小問" + expected.subNumber, text, "ja");
  expected.choices.forEach((c, i) => { result["choice" + c.label] = fieldCer(c.text, text, "en"); });
  const vals = Object.values(result);
  result.average = vals.reduce((a, b) => a + b, 0) / vals.length;
  return result;
}

/** 選択肢のラベルの順番（行の順）を調べる。各行の先頭のラベルを順に返す */
function choiceOrder(text, labels = ["ア", "イ", "ウ", "エ"]) {
  return text.split("\n").map((l) => l.trim()).filter((l) => labels.some((x) => l.startsWith(x + " ") || l.startsWith(x + "\t"))).map((l) => [...l][0]);
}

/** 全体の文字誤り率（正解の全文と比べる） */
function totalCer(expectedText, text) {
  const e = norm(expectedText, "ja"), t = norm(text, "ja");
  return levenshtein(t, e) / [...e].length;
}

/** 正解データを、改善版OCRの出力と同じ形の全文にする */
function expectedText(expected) {
  return [
    expected.title, expected.instruction, "小問" + expected.subNumber, expected.subInstruction,
    expected.english + " " + expected.direction, "⇒" + expected.rewrite, "選択肢",
    ...expected.choices.map((c) => `${c.label} ${c.text}`),
  ].join("\n");
}

module.exports = { norm, levenshtein, substringDistance, fieldCer, evaluate, choiceOrder, totalCer, expectedText };
