/*
 * ai-assist.js — AIとのやりとりを担当する部品（APIを使わなくても動く）
 *
 * このファイルがすること
 *   1. 問題文から、AIに渡す「質問文」を作る（buildPrompt）
 *   2. AIの回答（Claudeアプリなどからの貼り付け）を、項目ごとに分ける（parseAnswer）
 *   3. 回答の下書きを作る（buildDraft）
 *   4. テスト・練習用の「模擬データ」の回答を作る（mockAnswer）
 *
 * AIの切り替え（プロバイダー）
 *   どのAIを使っても「質問文 → 回答の文章 → parseAnswer で項目に分ける」という同じ流れにしてある。
 *   - manual：質問文をコピーして、Claudeアプリなどに自分で貼り付ける（無料）
 *   - mock  ：模擬データ（通信しない。テスト・練習用）
 *   将来APIを使うときは、registerProvider({ id, label, mode: "auto", cost: "paid", ask(prompt) }) を追加するだけでよい。
 *   ask は「回答の文章」を返す関数（Promise）。画面側は、mode が "auto" のものだけ ask を呼ぶ。
 *
 * 安全のため
 *   - このファイルは外部と通信しない（fetch などを使わない）
 *   - 回答の提出・Classiの操作はしない。下書きは本人が確認して使う
 */
(function (root) {
  "use strict";

  /** 回答の項目（画面の表示順） */
  const SECTIONS = [
    { key: "meaning", label: "問題の意味", list: false },
    { key: "method", label: "解き方・考え方", list: false },
    { key: "points", label: "重要ポイント", list: true },
    { key: "candidates", label: "回答候補", list: true },
    { key: "reason", label: "回答の理由", list: false },
    { key: "pitfalls", label: "間違えやすいポイント", list: false },
    { key: "draft", label: "回答の下書き", list: false },
  ];

  /** 見出しの言いかえ（AIによって書き方が違うため）。長いものから順に調べる */
  const ALIASES = [
    ["meaning", ["問題の意味", "問題の説明", "問題の内容", "何を聞かれているか", "問われていること", "問題の要点", "設問の意味"]],
    ["method", ["解き方・考え方", "解き方と考え方", "解き方", "考え方", "解法", "解説", "手順", "ステップ"]],
    ["points", ["重要ポイント", "大切なポイント", "重要な点", "ポイント", "押さえるべき点", "覚えておくこと"]],
    ["candidates", ["回答候補", "解答候補", "答えの候補", "正解の候補", "正解", "答え", "解答", "回答"]],
    ["reason", ["回答の理由", "解答の理由", "答えの理由", "正解の理由", "理由", "根拠"]],
    ["pitfalls", ["間違えやすいポイント", "間違えやすい点", "よくある間違い", "注意点", "注意するポイント", "ひっかけ"]],
    ["draft", ["回答の下書き", "解答の下書き", "下書き", "回答例", "解答例", "記述例"]],
  ];
  const ALIAS_LIST = [];
  for (const [key, names] of ALIASES) for (const n of names) ALIAS_LIST.push([n, key]);
  ALIAS_LIST.sort((a, b) => b[0].length - a[0].length);

  const MAX_ANSWER_CHARS = 20000;

  /* ---------------- AIの切り替え ---------------- */
  const providers = new Map();

  function registerProvider(p) {
    if (!p || !p.id || !p.label) throw new Error("プロバイダーには id と label が必要です");
    if (p.mode === "auto" && typeof p.ask !== "function") throw new Error("自動のプロバイダーには ask が必要です");
    providers.set(p.id, Object.freeze({ mode: "manual", cost: "free", ...p }));
  }
  function getProvider(id) { return providers.get(id) || providers.get("claude"); }
  function listProviders() { return [...providers.values()]; }

  registerProvider({ id: "claude", label: "Claude（アプリ・Web）", mode: "manual", cost: "free" });
  registerProvider({ id: "chatgpt", label: "ChatGPT（アプリ・Web）", mode: "manual", cost: "free" });
  registerProvider({ id: "gemini", label: "Gemini（アプリ・Web）", mode: "manual", cost: "free" });
  registerProvider({ id: "other", label: "その他のAI", mode: "manual", cost: "free" });
  registerProvider({ id: "mock", label: "模擬データ（テスト・練習用）", mode: "auto", cost: "free", ask: (prompt, question) => Promise.resolve(mockAnswer(question)) });

  /* ---------------- 質問文 ---------------- */
  /** 回答の形式の指定（貼り付けたあと、項目に分けやすくするため） */
  function answerFormatText() {
    return [
      "【回答の形式】",
      "次の見出しを、この順番で、そのまま使って書いてください（見出しは【】で囲みます）。",
      ...SECTIONS.map((s) => `【${s.label}】`),
      "- 【重要ポイント】と【回答候補】は、1行に1つずつ「・」で始めて書いてください",
      "- 【回答候補】には、選択問題なら選択肢の記号（例：ア）を書いてください。決められないときは「決められない」と書いてください",
      "- 【回答の下書き】には、私が自分で確認してから使うための、短い下書きを書いてください",
    ].join("\n");
  }

  /**
   * 質問文を作る
   * @param {{stem?:string, choices?:Array<{marker:string,text:string}>, afterLines?:string[], type?:string}} q
   */
  function buildPrompt(q = {}) {
    const stem = (q.stem || "").trim() || "（なし）";
    const sep = (m) => (/[.．)）:：、]$/.test(m) ? "" : " ");
    const choices = (q.choices || []).length ? q.choices.map((c) => `${c.marker}${sep(c.marker)}${c.text}`).join("\n") : "（なし）";
    const after = (q.afterLines || []).length ? `\n\n【選択肢のあとの行】\n${q.afterLines.join("\n")}` : "";
    const type = q.type && q.type !== "不明" ? `\n\n【問題の種類（自動判定・参考）】\n${q.type}` : "";
    return `あなたは学習支援の先生です。次の問題について、答えだけでなく、考え方が分かるように解説してください。

【注意】
- 文字は画像から機械で読み取っています。【要確認】の行は読み取りに自信がないので、推測で進めず、確認が必要だと伝えてください
- 選択肢の順番と記号は、元のまま扱ってください
- 回答の提出や送信はしません。最後は私が自分で判断します

${answerFormatText()}

【問題文】
${stem}

【選択肢】
${choices}${after}${type}`;
  }

  /* ---------------- 回答の整理 ---------------- */
  /**
   * 1行が見出しなら、その項目の key と、見出しのあとに続く文字を返す
   * @param {boolean} loose 段落の始まり（前の行が空）なら、飾りのない「理由：…」も見出しとみなす
   */
  function matchHeading(line, loose = false) {
    const original = line.trim();
    if (!original) return null;
    // 飾りを外す：#、**、__、番号（1. 1） ① (1)）
    // 「答え：ア」のような本文の行を見出しと間違えないよう、飾りのない「〇〇：」は正式な見出し名のときだけ見出しにする
    let s = original.replace(/^#{1,6}\s*/, "");
    s = s.replace(/^(?:\d{1,2}[.．)）]|[①-⑩]|[（(]\d{1,2}[)）])\s*/, "");
    const boldMatch = s.match(/^(\*\*|__)(.+?)\1(.*)$/);
    const decorated = s !== original || !!boldMatch;
    if (boldMatch) s = boldMatch[2] + boldMatch[3];
    let rest = null;
    let name = null;
    const bracket = s.match(/^[【\[［]\s*([^】\]］]{1,20}?)\s*[】\]］]\s*[:：]?\s*(.*)$/);
    if (bracket) { name = bracket[1]; rest = bracket[2]; }
    else {
      const colon = s.match(/^([^:：。、]{1,16}?)\s*(?:\*\*)?\s*[:：]\s*(.*)$/);
      if (colon) { name = colon[1]; rest = colon[2]; }
      else if (s.length <= 16) { name = s.replace(/\*\*$/, ""); rest = ""; }
    }
    if (name === null) return null;
    name = name.replace(/\*\*/g, "").replace(/\s+/g, "").trim();
    if (!bracket && !decorated && !loose && !SECTIONS.some((x) => x.label === name)) return null;
    for (const [alias, key] of ALIAS_LIST) {
      if (name === alias) return { key, rest: (rest || "").replace(/^\*\*\s*/, "").trim() };
    }
    return null;
  }

  /** 箇条書きの行を、1つずつの項目にする */
  function toList(text) {
    const out = [];
    for (const raw of String(text || "").split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const item = line.replace(/^(?:[-*・●■◆]|\d{1,2}[.．)）]|[①-⑩])\s*/, "").trim();
      if (item) out.push(item);
    }
    return out;
  }

  function cleanText(s) {
    return String(s || "")
      .replace(/\r\n?/g, "\n")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      .replace(/^```[a-z]*\n?|```$/gim, "")
      .trim();
  }

  /**
   * AIの回答を項目に分ける
   * @returns {{explanation:object, found:string[], missing:string[], ok:boolean, truncated:boolean, preface:string}}
   *   ok … 見出しが1つ以上見つかった。false のときは、全文を「解き方・考え方」に入れる
   */
  function parseAnswer(text) {
    let src = cleanText(text);
    const truncated = src.length > MAX_ANSWER_CHARS;
    if (truncated) src = src.slice(0, MAX_ANSWER_CHARS);
    const buckets = {};
    const preface = [];
    let current = null;
    let prevBlank = true;
    for (const line of src.split("\n")) {
      // 下書きの中の「答え：ア」などは見出しにしない
      const h = matchHeading(line, prevBlank && current !== "draft");
      prevBlank = !line.trim();
      if (h) {
        current = h.key;
        if (!buckets[current]) buckets[current] = [];
        if (h.rest) buckets[current].push(h.rest);
        continue;
      }
      if (current) buckets[current].push(line);
      else preface.push(line);
    }
    const explanation = {};
    const found = [];
    for (const s of SECTIONS) {
      const body = (buckets[s.key] || []).join("\n").replace(/\n{3,}/g, "\n\n").trim();
      if (body) found.push(s.key);
      explanation[s.key] = s.list ? toList(body) : body;
    }
    const ok = found.length > 0;
    if (!ok) explanation.method = src;
    return {
      explanation,
      found,
      missing: SECTIONS.filter((s) => !found.includes(s.key)).map((s) => s.key),
      ok,
      truncated,
      preface: preface.join("\n").trim(),
    };
  }

  /* ---------------- 回答の下書き ---------------- */
  /**
   * 下書きを作る。AIが【回答の下書き】を書いていればそれを使い、なければ回答候補と理由から作る。
   * 選択問題の候補は、選択肢の記号と内容をそろえて書く（選択肢にない記号はそのまま）。
   */
  function buildDraft(explanation = {}, q = {}) {
    if (explanation.draft && String(explanation.draft).trim()) return String(explanation.draft).trim();
    const cands = explanation.candidates || [];
    if (!cands.length) return "";
    const choices = q.choices || [];
    const norm = (m) => String(m).replace(/[.．)）(（\s]/g, "");
    const lines = cands.map((c) => {
      const hit = choices.find((ch) => norm(c).startsWith(norm(ch.marker)) && norm(ch.marker));
      return hit && norm(c) === norm(hit.marker) ? `${hit.marker}${hit.text}` : c;
    });
    let out = `答え：${lines.join("、")}`;
    const reason = String(explanation.reason || "").trim();
    if (reason) out += `\n理由：${reason}`;
    return out;
  }

  /* ---------------- 模擬データ ---------------- */
  /**
   * 模擬データの回答（通信しない）。AIの回答のふりをしないよう、必ず「模擬データ」と書く。
   * 選択問題なら最初の選択肢を候補にするが、正解とは限らない。
   */
  function mockAnswer(q = {}) {
    const first = (q.choices || [])[0];
    const cand = first ? first.marker.replace(/[.．)）\s]/g, "") : "決められない";
    return [
      "※これは画面の動きを確かめるための【模擬データ】です。AIの回答ではなく、正解とは限りません。",
      "",
      "【問題の意味】",
      `（模擬）${(q.stem || "この問題").split("\n")[0].slice(0, 60)} について問う問題です。`,
      "",
      "【解き方・考え方】",
      "（模擬）1. 問題文の条件を確かめます。",
      "2. 選択肢を1つずつ見比べます。",
      "",
      "【重要ポイント】",
      "・（模擬）問題文のキーワードに注目する",
      "・（模擬）選択肢を最後まで読む",
      "",
      "【回答候補】",
      `・${cand}`,
      "",
      "【回答の理由】",
      "（模擬）これは見本の理由です。実際の理由は、AIの回答や教科書で確かめてください。",
      "",
      "【間違えやすいポイント】",
      "（模擬）似ている選択肢に注意します。",
      "",
      "【回答の下書き】",
      `（模擬）答え：${cand}`,
    ].join("\n");
  }

  const api = Object.freeze({
    SECTIONS, registerProvider, getProvider, listProviders,
    answerFormatText, buildPrompt, parseAnswer, matchHeading, buildDraft, mockAnswer,
  });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ClassiAI = api;
})(typeof window !== "undefined" ? window : globalThis);
