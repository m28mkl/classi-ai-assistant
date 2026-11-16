/*
 * Classi AI Assistant — OCR精度改善パイプライン（ブラウザ内だけで動く。外部通信なし）
 *
 * 流れ：
 *  1. 画面構造の解析 analyzeLayout … 青いバー・動画・グレーの回答欄・ボタンなどの「UI部分」を
 *     固定座標ではなく画素の特徴（色・横に長く続く非白色の帯）から見つけて除外し、本文の範囲と行を求める
 *  2. 前処理 renderVariant … 本文を切り出し、文字の高さに合わせて拡大・グレースケール化・コントラスト調整、
 *     必要に応じて二値化（大津の方法）・ノイズ除去。元の画像（canvas）は変更しない
 *  3. 1回目の認識（jpn+eng）で単語の位置と文字種を得て、各行を「日本語の部分」と「英語の部分」に分ける
 *  4. 2回目の認識 … 英語の部分は eng、日本語の部分は jpn で行ごとに読み直す。
 *     前処理の有無（グレー／二値化）を両方試し、確信度の高い方を採用する。混在して判断できない部分は jpn+eng
 *  5. 後処理 … 英語の I/1/l の取り違え・空白・句読点を「前後の文脈」で直す（一括置換はしない）。
 *     直した箇所と確信度の低い箇所は記録し、確認画面で利用者が判断する
 *  6. 問題文・英文・選択肢（ア〜エ）の構造に整理する。選択肢の順番や内容（文法の正誤）は変えない
 *
 * index.html から読み込む（classic script）。window.ClassiOcr に関数を公開する。
 */
(function (global) {
  "use strict";

  /* ======================= 1. 画面構造の解析 ======================= */

  const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

  /**
   * 画面の構造を解析する。
   * @param {ImageData} img
   * @returns {{ content: {x:number,y:number,w:number,h:number}, excluded: Array<{y0:number,y1:number,kind:string}>,
   *            lines: Array<{x0:number,y0:number,x1:number,y1:number}>, textHeight: number, rows: string[] }}
   */
  function analyzeLayout(img) {
    const { width: W, height: H, data } = img;
    const longRun = Math.max(8, Math.round(W * 0.25)); // 横幅の25%以上続く非白色＝UI部品（バー・動画・パネル・ボタン）
    const rowKind = new Array(H);
    const rowInk = new Uint32Array(H);

    for (let y = 0; y < H; y++) {
      let run = 0, maxRun = 0, blue = 0, ink = 0;
      const o = y * W * 4;
      for (let x = 0; x < W; x++) {
        const i = o + x * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const L = lum(r, g, b);
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const isWhite = L > 244 && max - min < 18;
        if (isWhite) { run = 0; } else { run++; if (run > maxRun) maxRun = run; }
        if (b > 170 && b === max && max - min > 90) blue++;
        if (L < 200 && max - min < 60) ink++; // 文字（黒〜灰色、色の薄い彩度）
      }
      rowInk[y] = ink;
      if (blue > W * 0.6) rowKind[y] = "blue";
      else if (maxRun >= longRun) rowKind[y] = "ui";
      else rowKind[y] = ink > 0 ? "text" : "blank";
    }

    // UI行の連続を「除外帯」にまとめる
    const excluded = [];
    for (let y = 0; y < H;) {
      const k = rowKind[y];
      if (k === "blue" || k === "ui") {
        let y1 = y;
        while (y1 + 1 < H && (rowKind[y1 + 1] === "blue" || rowKind[y1 + 1] === "ui")) y1++;
        // 帯の種類（青いバー／動画・パネル・ボタンなど）
        let blueRows = 0;
        for (let t = y; t <= y1; t++) if (rowKind[t] === "blue") blueRows++;
        excluded.push({ y0: y, y1, kind: blueRows > (y1 - y + 1) / 2 ? "bar" : "ui" });
        y = y1 + 1;
      } else y++;
    }

    // UI帯で区切られた「本文の候補」（文字のある行を含む区間）
    const segments = [];
    for (let y = 0; y < H;) {
      if (rowKind[y] === "text" || rowKind[y] === "blank") {
        let y1 = y, ink = 0;
        while (y1 + 1 < H && (rowKind[y1 + 1] === "text" || rowKind[y1 + 1] === "blank")) y1++;
        for (let t = y; t <= y1; t++) ink += rowInk[t];
        segments.push({ y0: y, y1, ink });
        y = y1 + 1;
      } else y++;
    }

    // 各区間の行を求め、文字のある区間だけ残す
    const withLines = segments.map((s) => ({ ...s, lines: findLines(rowInk, s.y0, s.y1) })).filter((s) => s.lines.length);
    let content;
    let keep;
    if (!withLines.length) {
      keep = [];
      content = { x: 0, y: 0, w: W, h: H };
    } else {
      // UI部品に上下をぴったり挟まれた小さな区間（ボタンの中の文字など）は除く。それ以外の文字のある区間は本文
      const isUi = (y) => y >= 0 && y < H && (rowKind[y] === "blue" || rowKind[y] === "ui");
      const near = (y, dir) => { for (let t = 1; t <= 3; t++) if (isUi(y + dir * t)) return true; return false; };
      const main = withLines.reduce((a, b) => (b.ink > a.ink ? b : a));
      keep = withLines.filter((s) => s === main || s.lines.length >= 3 || !(near(s.y0, -1) && near(s.y1, 1)));
      for (const s of withLines) if (!keep.includes(s)) excluded.push({ y0: s.y0, y1: s.y1, kind: "small" });
      const y0 = Math.min(...keep.map((s) => s.y0));
      const y1 = Math.max(...keep.map((s) => s.y1));
      const [x0, x1] = inkColumns(img, keep);
      content = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    }
    excluded.sort((a, b) => a.y0 - b.y0);

    // 行は本文の横幅の範囲内だけで求め直す（右端のスクロールバーなどで行がつながらないように）
    const rowInkIn = rowInkRange(img, content.x, content.x + content.w - 1);
    const lines = [];
    for (const s of keep) {
      for (const l of findLines(rowInkIn, s.y0, s.y1)) {
        const [lx0, lx1] = inkColumns(img, [{ y0: l.y0, y1: l.y1 }], content.x, content.x + content.w - 1);
        if (lx1 >= lx0) lines.push({ x0: lx0, y0: l.y0, x1: lx1, y1: l.y1 });
      }
    }
    const heights = lines.map((l) => l.y1 - l.y0 + 1).sort((a, b) => a - b);
    const textHeight = heights.length ? heights[Math.floor(heights.length / 2)] : 0;
    return { width: W, height: H, content, excluded, lines, textHeight, rows: rowKind };
  }

  /** 指定した横幅の範囲内で、各行の文字の画素数を数える */
  function rowInkRange(img, x0, x1) {
    const { width: W, height: H, data } = img;
    const out = new Uint32Array(H);
    for (let y = 0; y < H; y++) {
      const o = y * W * 4;
      let ink = 0;
      for (let x = x0; x <= x1; x++) {
        const i = o + x * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        if (lum(r, g, b) < 200 && max - min < 60) ink++;
      }
      out[y] = ink;
    }
    return out;
  }

  /** 文字のある行（横方向の投影）を求める */
  function findLines(rowInk, y0, y1) {
    const lines = [];
    let start = -1, gap = 0;
    for (let y = y0; y <= y1 + 1; y++) {
      const has = y <= y1 && rowInk[y] > 0;
      if (has) {
        if (start < 0) start = y;
        gap = 0;
      } else if (start >= 0) {
        gap++;
        if (gap > 2 || y > y1) {
          const end = y - gap;
          if (end - start + 1 >= 6) lines.push({ y0: start, y1: end });
          start = -1; gap = 0;
        }
      }
    }
    return lines;
  }

  /** 文字のある列の範囲。端にある細い孤立部分（スクロールバーなど）は除く */
  function inkColumns(img, bands, xmin = 0, xmax = img.width - 1) {
    const { width: W, data } = img;
    const col = new Uint32Array(W);
    for (const b of bands) {
      for (let y = b.y0; y <= b.y1; y++) {
        const o = y * W * 4;
        for (let x = xmin; x <= xmax; x++) {
          const i = o + x * 4;
          const r = data[i], g = data[i + 1], bb = data[i + 2];
          const max = Math.max(r, g, bb), min = Math.min(r, g, bb);
          if (lum(r, g, bb) < 200 && max - min < 60) col[x]++;
        }
      }
    }
    // 列のかたまり（隙間が幅の3%以上で区切る）
    const gapMax = Math.max(4, Math.round(W * 0.03));
    const clusters = [];
    let cur = null, gap = 0;
    for (let x = xmin; x <= xmax; x++) {
      if (col[x] > 0) {
        if (cur && gap <= gapMax) { cur.x1 = x; cur.ink += col[x]; } else { cur = { x0: x, x1: x, ink: col[x] }; clusters.push(cur); }
        gap = 0;
      } else gap++;
    }
    if (!clusters.length) return [xmin, xmin - 1];
    const maxInk = Math.max(...clusters.map((c) => c.ink));
    const kept = clusters.filter((c) => c.ink >= maxInk * 0.02 && (c.x1 - c.x0 + 1) >= Math.max(3, W * 0.004));
    return [Math.min(...kept.map((c) => c.x0)), Math.max(...kept.map((c) => c.x1))];
  }

  /* ======================= 2. 前処理 ======================= */

  /** 文字の高さから拡大率を決める（行の高さが約56pxになるように。1〜3倍） */
  function chooseScale(textHeight) {
    if (!textHeight) return 1;
    return Math.max(1, Math.min(3, 56 / textHeight));
  }

  /**
   * 元のcanvasの一部を切り出して前処理した新しいcanvasを返す（元のcanvasは変更しない）
   * mode: "raw"（拡大のみ）| "gray"（グレースケール＋コントラスト調整）| "binary"（さらに二値化＋ノイズ除去）
   */
  function renderVariant(source, rect, { scale = 1, mode = "gray", pad = 16 } = {}) {
    const w = Math.max(1, Math.round(rect.w * scale));
    const h = Math.max(1, Math.round(rect.h * scale));
    const p = Math.round(pad);
    const c = document.createElement("canvas");
    c.width = w + p * 2;
    c.height = h + p * 2;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, p, p, w, h);
    if (mode === "raw") return c;

    const im = ctx.getImageData(0, 0, c.width, c.height);
    const d = im.data;
    const n = c.width * c.height;
    const gray = new Uint8ClampedArray(n);
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) {
      const v = Math.round(lum(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]));
      gray[i] = v;
      hist[v]++;
    }
    // コントラスト調整：暗い側1%・明るい側0.5%を基準に0〜255へ引き伸ばす
    const lo = percentile(hist, n, 0.01);
    const hi = Math.max(lo + 1, percentile(hist, n, 0.995));
    for (let i = 0; i < n; i++) gray[i] = ((gray[i] - lo) * 255) / (hi - lo);

    if (mode === "binary") {
      const h2 = new Uint32Array(256);
      for (let i = 0; i < n; i++) h2[gray[i]]++;
      const t = otsu(h2, n);
      for (let i = 0; i < n; i++) gray[i] = gray[i] <= t ? 0 : 255;
      despeckle(gray, c.width, c.height);
    }
    for (let i = 0; i < n; i++) {
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = gray[i];
      d[i * 4 + 3] = 255;
    }
    ctx.putImageData(im, 0, 0);
    return c;
  }

  function percentile(hist, n, q) {
    let acc = 0;
    const target = n * q;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= target) return v;
    }
    return 255;
  }

  /** 大津の方法でしきい値を求める */
  function otsu(hist, n) {
    let sum = 0;
    for (let v = 0; v < 256; v++) sum += v * hist[v];
    let sumB = 0, wB = 0, best = 0, t = 127;
    for (let v = 0; v < 256; v++) {
      wB += hist[v];
      if (!wB) continue;
      const wF = n - wB;
      if (!wF) break;
      sumB += v * hist[v];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; t = v; }
    }
    return t;
  }

  /** 周りに黒い画素がない孤立した黒い点（ノイズ）を白にする */
  function despeckle(g, w, h) {
    const out = g.slice();
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (g[i]) continue;
        let dark = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && !g[i + dy * w + dx]) dark++;
        if (dark === 0) out[i] = 255;
      }
    }
    g.set(out);
  }

  /* ======================= 3. 文字種の判定 ======================= */

  const RE_JA = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々〆、。「」『』【】（）！？：；，．]/u;
  const RE_LATIN = /[A-Za-z]/;

  /** 文字列の文字種：日本語が含まれれば "ja"、英字だけなら "latin"、記号・数字だけなら "neutral" */
  function scriptClass(text) {
    let ja = 0, la = 0;
    for (const ch of text) {
      if (RE_JA.test(ch)) ja++;
      else if (RE_LATIN.test(ch)) la++;
    }
    if (!ja && !la) return "neutral";
    if (ja && la) return ja >= la ? "ja" : "latin";
    return ja ? "ja" : "latin";
  }

  /**
   * 1回目の認識結果（行と単語）から、各行を「日本語の部分」「英語の部分」に分ける。
   * 記号・数字だけの単語は前の部分（なければ次の部分）に含める。文章の順番（左から右）は保つ。
   * @returns {Array<{bbox, chunks: Array<{cls:"ja"|"latin", bbox, text}>}>}
   */
  // 選択肢の記号と、1回目の認識（jpn+eng）で読み間違えやすい形
  const LABEL_CANDIDATES = new Set(["ア", "イ", "ウ", "エ", "オ", "カ", "了", "マ", "ィ", "亻", "ゥ", "工", "ェ", "ォ", "力", "I", "l", "1", "|", "T", "7"]);

  function splitLineChunks(tLines) {
    return tLines.map((line) => {
      const words = (line.words || []).filter((w) => w.text && w.text.trim());
      const chunks = [];
      // 行頭の1文字が次の語から大きく離れている（行の高さの0.6倍以上）場合は、選択肢の記号（ア・イ・ウ・エ）の候補として
      // 独立した日本語の部分にする（「エ」が英字の「I」と読まれて英文の一部になるのを防ぐ）
      const lh = line.bbox.y1 - line.bbox.y0;
      const head = words.length ? words[0].text.trim() : "";
      if (words.length >= 2 && [...head].length === 1 && LABEL_CANDIDATES.has(head) && words[1].bbox.x0 - words[0].bbox.x1 > lh * 0.6) {
        chunks.push({ cls: "ja", words: [words[0]], label: true });
        words.shift();
      }
      for (const w of words) {
        const cls = scriptClass(w.text);
        const last = chunks[chunks.length - 1];
        if (last && !last.label && (cls === "neutral" || cls === last.cls || last.cls === "neutral")) {
          if (last.cls === "neutral") last.cls = cls;
          last.words.push(w);
        } else {
          chunks.push({ cls, words: [w] });
        }
      }
      for (const c of chunks) {
        if (c.cls === "neutral") c.cls = "latin";
        c.bbox = unionBox(c.words.map((w) => w.bbox));
        c.text = c.words.map((w) => w.text).join(" ");
      }
      return { bbox: line.bbox, text: line.text, confidence: line.confidence, chunks };
    });
  }

  function unionBox(boxes) {
    return {
      x0: Math.min(...boxes.map((b) => b.x0)), y0: Math.min(...boxes.map((b) => b.y0)),
      x1: Math.max(...boxes.map((b) => b.x1)), y1: Math.max(...boxes.map((b) => b.y1)),
    };
  }

  /* ======================= 5. 後処理 ======================= */

  // 単独では英単語にならないので、前後が英単語なら代名詞の I と判断してよい形
  const PRONOUN_LOOKALIKE = new Set(["l", "|", "!", "]", "[", "i"]);
  // 「1」は数字として正しい場合があるので、代名詞の I が来る位置（文頭・接続詞や関係詞の後）でだけ I と判断する
  const BEFORE_PRONOUN = new Set(["to", "and", "but", "or", "so", "that", "when", "if", "because", "as", "than", "whom", "who", "which", "where", "why", "how", "what", "while", "until", "before", "after", "since", "though", "although", "think", "know", "said", "say", "hope", "believe"]);
  const isWord = (t) => /^[A-Za-z][A-Za-z'’-]*[.,!?;:]?$/.test(t);

  /**
   * 英語の部分の後処理。前後の単語を見て判断し、直した箇所を changes に記録する。
   * - 単独の「1」「l」「|」などが英単語に挟まれている（または文頭で次が英単語）→ 代名詞の「I」
   * - 「1spoke」「lspoke」のように I が次の単語とくっついていて、Tesseract の辞書にない語 → 「I spoke」（要確認として記録）
   * - 単語の途中の大文字 I（前後が小文字）で辞書にない語 → 小文字の l
   * - 句読点の前の空白を削除、文末の句読点の後に空白、連続する空白を1つに
   * 数字の前後が数字のとき（「p.10」「01」など）は変更しない。
   */
  function fixEnglish(text, words = []) {
    const changes = [];
    const inDict = new Map(words.map((w) => [w.text, !!w.in_dictionary]));
    let tokens = text.replace(/[　\s]+/g, " ").trim().split(" ").filter(Boolean);

    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      let t = tokens[i];
      const prev = out[out.length - 1];
      const next = tokens[i + 1];
      const prevWordish = prev === undefined || isWord(prev) || /[.!?]$/.test(prev) || /^[(（⇒→]/.test(prev);
      // 単独の l / | → I（前後が英単語のときだけ）
      if (PRONOUN_LOOKALIKE.has(t) && next !== undefined && isWord(next) && prevWordish) {
        changes.push({ from: t, to: "I", reason: "英単語に挟まれた「" + t + "」は代名詞の I と判断" });
        out.push("I");
        continue;
      }
      // 単独の 1 → I は、代名詞の I が来る位置で、次が小文字の英単語のときだけ。それ以外は直さずに記録する
      if (t === "1" && next !== undefined && /^[a-z]/.test(next) && isWord(next)) {
        const atStart = prev === undefined || /[.!?]$/.test(prev) || /^[(（⇒→]$/.test(prev);
        if (atStart || (prev && BEFORE_PRONOUN.has(prev.toLowerCase()))) {
          changes.push({ from: t, to: "I", reason: "文頭または「" + (prev || "") + "」の後の「1」は代名詞の I と判断" });
          out.push("I");
        } else {
          changes.push({ from: t, to: t, reason: "「1」は「I」の可能性があります（数字の可能性もあるため直していません）", uncertain: true });
          out.push(t);
        }
        continue;
      }
      // くっついた I：1spoke / lspoke / Ispoke（辞書にない語だけ）
      const glued = t.match(/^([1l|I])([a-z]{2,}[.,!?;:]?)$/);
      if (glued && inDict.get(t) === false && (prev === undefined || isWord(prev) || /[.!?]$/.test(prev))) {
        changes.push({ from: t, to: "I " + glued[2], reason: "辞書にない語「" + t + "」を「I」と次の語に分割（要確認）", uncertain: true });
        out.push("I", glued[2]);
        continue;
      }
      // 「to1spoke」「tolspoke」のように前の語ともくっついている場合
      const glued3 = t.match(/^(to|and|but|so|that|when|if|because|as)([1l|I])([a-z]{2,}[.,!?;:]?)$/);
      if (glued3 && inDict.get(t) === false) {
        changes.push({ from: t, to: glued3[1] + " I " + glued3[3], reason: "辞書にない語「" + t + "」を分割（要確認）", uncertain: true });
        out.push(glued3[1], "I", glued3[3]);
        continue;
      }
      // 単語の途中の大文字 I → l（辞書にない語だけ）
      if (/^[a-z]+I[a-z]+[.,!?;:]?$/.test(t) && inDict.get(t) === false) {
        const fixed = t.replace(/([a-z])I(?=[a-z])/g, "$1l");
        changes.push({ from: t, to: fixed, reason: "単語の途中の「I」を小文字の l と判断" });
        t = fixed;
      }
      out.push(t);
    }
    let s = out.join(" ");
    const before = s;
    s = s
      .replace(/[，]/g, ",").replace(/[．]/g, ".")
      .replace(/\s+([.,!?;:])/g, "$1")          // 句読点の前の空白
      .replace(/([.!?])(?=[A-Z])/g, "$1 ")       // 文末の句読点の後に空白
      .replace(/_+(?=\s*$)/g, "")                // 行末の「_」（下線のノイズ）
      .replace(/\s{2,}/g, " ")
      .replace(/\(\s*[_\s]*\s*\)/g, "(     )")   // 空欄の（ ）は空白5つで表す（連続する空白をまとめた後）
      .trim();
    if (s !== before) changes.push({ from: before, to: s, reason: "空白・句読点を整理" });
    return { text: s, changes };
  }

  /** 日本語の部分の後処理：日本語の文字・数字の間の空白を取り除く */
  function fixJapanese(text) {
    const J = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}ー々〆、。・「」『』【】（）［］！？：；，．_＿";
    // 「20日 17:00」のような日付と時刻の間の空白は残す
    const gap = new RegExp(`([${J}0-9])[ \\t\\u3000]+(?=[${J}0-9])(?!\\d{1,2}:\\d{2})`, "gu");
    // 日本語の部分にある半角の括弧・読点は全角にそろえる
    let s = text.replace(/\(/g, "（").replace(/\)/g, "）").replace(/\s*,\s*/g, "，");
    s = s.replace(gap, "$1").replace(gap, "$1");
    s = s.replace(/（[\s_]*）/g, "（ ）").replace(/\s{2,}/g, " ").trim();
    return s;
  }

  /**
   * 日本語の行の中の下線（_）の形を画素で探し、どの単語の間にあるかを返す。
   * 条件：行の下側1/4にある細い横線（長さが行の高さの0.35〜1.5倍、太さが行の高さの15%以下）で、
   *       その真上（行の上側）に文字がないこと。漢字の「一」は行の中ほどにあるので対象外になる。
   * Tesseract は日本語の間の「_」を落とすことがあるため、形が実際にある場合だけ補う。
   * @returns {number[]} 下線がある位置（i は words[i] と words[i+1] の間）
   */
  function findUnderscoreGaps(img, words, lineY0, lineY1, x0, x1) {
    const { width: W, height: H, data } = img;
    const lh = lineY1 - lineY0;
    if (lh < 8 || words.length < 2) return [];
    const dark = (x, y) => {
      const i = (y * W + x) * 4;
      return lum(data[i], data[i + 1], data[i + 2]) < 140;
    };
    const yStart = Math.round(lineY0 + lh * 0.75), yEnd = Math.min(H - 1, Math.round(lineY1 + lh * 0.15));
    const minLen = lh * 0.35, maxLen = lh * 1.5;
    const found = [];
    for (let y = yStart; y <= yEnd; y++) {
      let run = 0;
      for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(W - 1, Math.ceil(x1)) + 1; x++) {
        const d = x <= x1 && dark(x, y);
        if (d) { run++; continue; }
        if (run >= minLen && run <= maxLen) {
          const rx0 = x - run, rx1 = x - 1;
          // 太さ：上下の行も同じ範囲で黒いか（細い線だけを対象にする）
          let thick = 1;
          for (let t = 1; t <= lh * 0.2 && y - t >= 0; t++) { let n = 0; for (let xx = rx0; xx <= rx1; xx++) if (dark(xx, y - t)) n++; if (n > run * 0.7) thick++; else break; }
          // 真上（行の上端〜線のすぐ上）に文字がないこと。
          // 「し」の下のカーブのように、端が上に曲がって続いている線は対象外になる
          let above = 0;
          for (let yy = Math.round(lineY0); yy <= y - thick; yy++) for (let xx = rx0; xx <= rx1; xx++) if (dark(xx, yy)) above++;
          if (thick <= Math.max(2, lh * 0.15) && above <= run * 0.03) found.push((rx0 + rx1) / 2);
        }
        run = 0;
      }
    }
    // 同じ線を重複して数えないようにまとめ、単語の中心の間のどこにあるかで位置を決める
    const centers = words.map((w) => w.srcRect.x + w.srcRect.w / 2);
    const gaps = new Set();
    for (const cx of found) {
      for (let k = 0; k + 1 < centers.length; k++) if (cx > centers[k] && cx < centers[k + 1]) { gaps.add(k); break; }
    }
    return [...gaps].sort((p, q) => p - q);
  }

  /* ======================= 6. 問題の構造 ======================= */

  const CHOICE_LABELS = ["ア", "イ", "ウ", "エ", "オ", "カ"];
  // OCRで取り違えやすい形（位置と順番からラベルと判断したときだけ使う）
  const LABEL_LOOKALIKE = { "ア": ["ア", "了", "マ"], "イ": ["イ", "ィ", "亻"], "ウ": ["ウ", "ゥ", "宀"], "エ": ["エ", "工", "ェ"], "オ": ["オ", "ォ"], "カ": ["カ", "力"] };

  /**
   * 行のテキストから問題の構造を作る。選択肢の順番・内容は変えない。
   * @param {Array<{text:string, parts?:Array<{cls:string,text:string}>}>} lines
   */
  function parseQuestion(lines) {
    const q = { title: "", instruction: "", subNumber: "", subInstruction: "", english: "", direction: "", rewrite: "", choices: [], other: [], notes: [] };
    let i = 0;
    const L = lines.map((l) => ({ ...l, text: l.text.trim() })).filter((l) => l.text);
    // 「小問」は文字が小さいと「小間」と読まれることがあるので、それも小問の見出しとして扱う（要確認として記録）
    const isSub = (t) => /^小[問間]\s*[0-9０-９]+/.test(t.replace(/\s/g, ""));
    const subIdx = L.findIndex((l) => isSub(l.text));
    const choiceHeader = L.findIndex((l) => /^選択肢$/.test(l.text.replace(/\s/g, "")));

    // 選択肢：行頭の記号（ア・イ・ウ・エ…）で判断し、画面の順番のまま並べる（並べ替えない）。
    // 取り違えやすい形（「工」など）は、次に来るはずの記号と見なすが「要確認」とする
    let expect = 0;
    const choiceLines = new Set();
    const startChoices = choiceHeader >= 0 ? choiceHeader + 1 : (subIdx >= 0 ? subIdx + 1 : 0);
    for (let k = startChoices; k < L.length && expect < CHOICE_LABELS.length; k++) {
      const expected = CHOICE_LABELS[expect];
      const t = L[k].text;
      const head = [...t][0];
      const body = t.slice(head.length).trim();
      if (CHOICE_LABELS.includes(head)) {
        const outOfOrder = head !== expected;
        q.choices.push({ label: head, text: body, labelRead: head, labelUncertain: false, outOfOrder });
        if (outOfOrder) q.notes.push({ from: head, to: head, reason: "選択肢の記号の順番が「" + expected + "」の位置で「" + head + "」になっています（並べ替えていません）", uncertain: true });
        choiceLines.add(k);
        expect = CHOICE_LABELS.indexOf(head) + 1;
      } else if (LABEL_LOOKALIKE[expected].includes(head) && body) {
        q.choices.push({ label: expected, text: body, labelRead: head, labelUncertain: true });
        choiceLines.add(k);
        expect++;
      } else if (q.choices.length) break;
    }

    // タイトル：最初の行（小問・選択肢より前）
    const before = subIdx >= 0 ? subIdx : (choiceHeader >= 0 ? choiceHeader : L.length);
    if (before > 0) {
      q.title = L[0].text;
      q.instruction = L.slice(1, before).map((l) => l.text).join("\n");
    }
    if (subIdx >= 0) {
      const m = L[subIdx].text.replace(/\s/g, "").match(/^小([問間])([0-9０-９]+)(.*)$/);
      if (m[1] === "間") q.notes.push({ from: "小間", to: "小問", reason: "見出しの「小間」を「小問」と判断（要確認）", uncertain: true });
      m.splice(1, 1);
      q.subNumber = m[1];
      const rest = [];
      if (m[2]) rest.push(m[2]);
      const end = choiceHeader >= 0 ? choiceHeader : (choiceLines.size ? Math.min(...choiceLines) : L.length);
      for (let k = subIdx + 1; k < end; k++) rest.push(L[k]);
      const sub = [], eng = [];
      for (const r of rest) {
        const text = typeof r === "string" ? r : r.text;
        const parts = typeof r === "string" ? null : r.parts;
        // 書き換え：⇒ / → / => などで始まる英語の行
        const rw = text.match(/^\s*(?:⇒|→|=>|=|>)\s*(.+)$/);
        if (rw && /[A-Za-z]/.test(rw[1])) {
          q.rewrite = rw[1].trim();
          const arrow = text.trim().match(/^(⇒|→|=>|=|>)/)[1];
          if (arrow !== "⇒") q.notes.push({ from: arrow, to: "⇒", reason: "行頭の記号「" + arrow + "」を書き換えの矢印「⇒」と判断（要確認）", uncertain: true });
          continue;
        }
        if (scriptClass(text) === "latin" || (parts && parts.some((p) => p.cls === "latin") && parts[0].cls === "latin")) {
          // 英文の後ろの（ ）書きの日本語は「指示」
          const dm = text.match(/^(.*?[A-Za-z.?!])\s*([（(][^()（）]*[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}][^()（）]*[)）])\s*$/u);
          if (dm) { eng.push(dm[1].trim()); q.direction = dm[2].replace(/^\(/, "（").replace(/\)$/, "）"); } else eng.push(text);
        } else if (!eng.length) sub.push(text);
        else q.other.push(text);
      }
      q.subInstruction = sub.join("\n");
      q.english = joinEnglishLines(eng);
    }
    for (let k = 0; k < L.length; k++) {
      if (k === 0 || k === subIdx || k === choiceHeader || choiceLines.has(k)) continue;
      if (k < before) continue;
      if (subIdx >= 0 && k > subIdx && (choiceHeader < 0 || k < choiceHeader)) continue;
      if (!q.other.includes(L[k].text)) q.other.push(L[k].text);
    }
    return q;
  }

  /** 英文の途中で不自然に改行されている行をつなげる（文末記号で終わらず、次の行が小文字で始まる） */
  function joinEnglishLines(lines) {
    const out = [];
    for (const l of lines) {
      const prev = out[out.length - 1];
      if (prev !== undefined && !/[.?!:;)]$/.test(prev) && /^[a-z(]/.test(l)) out[out.length - 1] = prev + " " + l;
      else out.push(l);
    }
    return out.join("\n");
  }

  /** 構造を読み取り結果の文章に戻す（元の順番どおり） */
  function formatQuestion(q) {
    const out = [];
    if (q.title) out.push(q.title);
    if (q.instruction) out.push(q.instruction);
    if (q.subNumber) out.push("小問" + q.subNumber);
    if (q.subInstruction) out.push(q.subInstruction);
    if (q.english) out.push(q.english + (q.direction ? " " + q.direction : ""));
    else if (q.direction) out.push(q.direction);
    if (q.rewrite) out.push("⇒" + q.rewrite);
    if (q.choices.length) {
      out.push("選択肢");
      for (const c of q.choices) out.push(`${c.label} ${c.text}`);
    }
    for (const o of q.other) out.push(o);
    return out.join("\n");
  }

  /** 比較用に分割する：英数字のまとまりは1語、日本語・記号は1文字ずつ、改行は「\n」。空白は無視 */
  function tokenize(s) {
    return (s.match(/\n|[A-Za-z0-9'’]+|[^\sA-Za-z0-9'’]/gu) || []);
  }

  /** 修正前と修正後の差分（英単語は単語ごと、日本語は1文字ごと。空白の違いは無視） */
  function diffTokens(a, b) {
    const A = tokenize(a);
    const B = tokenize(b);
    const n = A.length, m = B.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { ops.push({ op: "same", text: A[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ op: "del", text: A[i] }); i++; }
      else { ops.push({ op: "add", text: B[j] }); j++; }
    }
    while (i < n) ops.push({ op: "del", text: A[i++] });
    while (j < m) ops.push({ op: "add", text: B[j++] });
    return ops;
  }

  /* ======================= 4. 認識の実行（全体の流れ） ======================= */

  const UNCERTAIN_CONF = 80; // この確信度未満の単語は「自信がない部分」として表示する

  /**
   * 複数の部分（rect）を縦に並べた1枚の画像を作って一度に認識し、単語を元の部分に振り分ける。
   * 結果は job.result = { text, confidence, words, mode } に入れる。単語には元画像での位置 srcRect を付ける。
   */
  async function recognizeStack(worker, source, list, scale, mode) {
    const pad = 16;
    const parts = list.map((j) => renderVariant(source, j.rect, { scale, mode, pad }));
    const gap = Math.round(Math.max(...parts.map((p) => p.height)) * 0.6);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(...parts.map((p) => p.width));
    canvas.height = parts.reduce((a, p) => a + p.height + gap, 0);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const bands = [];
    let y = 0;
    parts.forEach((p) => {
      ctx.drawImage(p, 0, y);
      bands.push({ y0: y, y1: y + p.height });
      y += p.height + gap;
    });
    const { data } = await worker.recognize(canvas);
    const buckets = list.map(() => []);
    for (const w of data.words || []) {
      if (!w.text || !w.text.trim()) continue;
      const cy = (w.bbox.y0 + w.bbox.y1) / 2;
      const k = bands.findIndex((b) => cy >= b.y0 - gap / 2 && cy < b.y1 + gap / 2);
      if (k < 0) continue;
      const j = list[k];
      const b = w.bbox;
      w.srcRect = { x: j.rect.x + (b.x0 - pad) / scale, y: j.rect.y + (b.y0 - bands[k].y0 - pad) / scale, w: (b.x1 - b.x0) / scale, h: (b.y1 - b.y0) / scale };
      buckets[k].push(w);
    }
    list.forEach((j, k) => {
      const ws = buckets[k].sort((a, b) => a.bbox.x0 - b.bbox.x0);
      if (!ws.length) { j.result = { text: "", confidence: 0, words: [], mode }; return; }
      // 文字数で重み付けした平均確信度
      let sum = 0, n = 0;
      for (const w of ws) { const len = [...w.text].length; sum += w.confidence * len; n += len; }
      j.result = { text: ws.map((w) => w.text).join(" "), confidence: n ? sum / n : 0, words: ws, mode };
    });
  }

  /**
   * 改善版OCRの本体。worker は tesseract.js の Worker（jpn+eng で初期化済み）。
   * worker が単語の位置情報や言語の切り替え（reinitialize）に対応していない場合は、1回目の認識結果をそのまま返す。
   * @returns {Promise<{text:string, raw:string, structured:object|null, lines:Array, uncertain:Array, changes:Array, layout:object, variantsUsed:object}>}
   */
  async function runPipeline(worker, source, { onProgress = () => {}, excludeUi = true, preprocess = true } = {}) {
    const ctx = source.getContext("2d", { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, source.width, source.height);
    const layout = analyzeLayout(img);
    const region = excludeUi ? layout.content : { x: 0, y: 0, w: source.width, h: source.height };
    // 前処理なしの場合は、拡大もしない（元の大きさのまま切り出すだけ）
    const scale = preprocess ? chooseScale(layout.textHeight) : 1;

    // 1回目：本文全体を jpn+eng で（位置と文字種を知るため）
    onProgress({ label: "文字の位置を調べています", progress: 0.1 });
    const pass1Canvas = renderVariant(source, region, { scale, mode: preprocess ? "gray" : "raw", pad: 24 });
    const pass1 = (await worker.recognize(pass1Canvas)).data;
    const raw = pass1.text || "";
    const hasLayout = Array.isArray(pass1.lines) && pass1.lines.length && typeof worker.reinitialize === "function" && typeof worker.setParameters === "function";
    if (!hasLayout) {
      return { text: raw, raw, structured: null, lines: [], uncertain: [], changes: [], layout, variantsUsed: {}, pass1Canvas };
    }

    // 1回目の座標（拡大した切り出し画像の座標）を元画像の座標に戻す
    const pad = 24;
    const toSrc = (b) => ({
      x0: region.x + (b.x0 - pad) / scale, y0: region.y + (b.y0 - pad) / scale,
      x1: region.x + (b.x1 - pad) / scale, y1: region.y + (b.y1 - pad) / scale,
    });
    const toSrcRect = (b) => { const r = toSrc(b); return { x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0 }; };
    const lines = splitLineChunks(pass1.lines).filter((l) => l.chunks.length);
    for (const l of lines) {
      l.src = toSrc(l.bbox);
      for (const c of l.chunks) c.src = toSrc(c.bbox);
    }

    // 2回目：言語ごとに読み直す（eng → jpn）。
    // 1行ずつ認識すると1回ごとの固定時間が大きいため、同じ言語の部分を縦に並べた1枚の画像にしてまとめて認識する。
    // まずグレースケール＋コントラスト調整で読み、確信度が低い部分だけ二値化した画像でも読み、確信度の高い方を採用する。
    const jobs = [];
    for (const l of lines) {
      l.chunks.forEach((c, idx) => {
        const lh = l.src.y1 - l.src.y0;
        const prev = l.chunks[idx - 1], next = l.chunks[idx + 1];
        const left = prev ? (prev.src.x1 + c.src.x0) / 2 : c.src.x0 - lh * 0.4;
        const right = next ? (c.src.x1 + next.src.x0) / 2 : c.src.x1 + lh * 0.4;
        const rect = {
          x: Math.max(0, Math.floor(Math.max(left, c.src.x0 - lh * 0.4))),
          y: Math.max(0, Math.floor(l.src.y0 - lh * 0.25)),
        };
        rect.w = Math.max(1, Math.min(source.width - rect.x, Math.ceil(Math.min(right, c.src.x1 + lh * 0.4)) - rect.x));
        rect.h = Math.max(1, Math.min(source.height - rect.y, Math.ceil(l.src.y1 + lh * 0.25) - rect.y));
        jobs.push({ line: l, chunk: c, rect, lang: c.cls === "latin" ? "eng" : "jpn" });
      });
    }

    const variantsUsed = { gray: 0, binary: 0, raw: 0 };
    const firstMode = preprocess ? "gray" : "raw";
    const RETRY_BELOW = 90;
    let step = 0;
    const totalSteps = 4;
    for (const lang of ["eng", "jpn"]) {
      const list = jobs.filter((j) => j.lang === lang);
      if (!list.length) continue;
      const label = lang === "eng" ? "英語の部分を読み直しています" : "日本語の部分を読み直しています";
      onProgress({ label, progress: 0.2 + 0.7 * (step / totalSteps) });
      await worker.reinitialize(lang);
      await worker.setParameters({ tessedit_pageseg_mode: "6", preserve_interword_spaces: lang === "eng" ? "1" : "0" });
      await recognizeStack(worker, source, list, scale, firstMode);
      step++;
      if (preprocess) {
        const retry = list.filter((j) => !j.result || j.result.confidence < RETRY_BELOW);
        if (retry.length) {
          onProgress({ label, progress: 0.2 + 0.7 * (step / totalSteps) });
          const firsts = new Map(retry.map((j) => [j, j.result]));
          await recognizeStack(worker, source, retry, scale, "binary");
          for (const j of retry) {
            const a = firsts.get(j);
            if (a && (!j.result || a.confidence >= j.result.confidence)) j.result = a;
          }
        }
      }
      step++;
      for (const j of list) if (j.result) variantsUsed[j.result.mode]++;
    }

    // 結果の統合：2回目の結果が空・極端に低い確信度なら1回目の結果を使う
    const uncertain = [];
    const changes = [];
    const outLines = [];
    for (const l of lines) {
      const parts = [];
      for (const c of l.chunks) {
        const job = jobs.find((j) => j.chunk === c);
        const r = job.result;
        let text = r && r.text && r.confidence >= 30 ? r.text : c.text;
        const rawText = text;
        const words = r && r.text && r.confidence >= 30 ? r.words : c.words;
        const source2 = r && r.text && r.confidence >= 30 ? job.lang : "jpn+eng";
        if (c.cls === "latin") {
          const fixed = fixEnglish(text, words);
          for (const ch of fixed.changes) changes.push({ ...ch, line: outLines.length });
          text = fixed.text;
        } else {
          // 単語の間の下線（_）の形を調べて補う
          const ws = (words || []).filter((w) => w.srcRect).sort((a, b) => a.srcRect.x - b.srcRect.x);
          const gaps = ws.length > 1 ? findUnderscoreGaps(img, ws, l.src.y0, l.src.y1, job.rect.x, job.rect.x + job.rect.w - 1) : [];
          if (gaps.length && !/_/.test(text)) {
            const parts2 = ws.map((w) => w.text);
            for (const g of gaps) parts2[g] = parts2[g] + "_";
            const withUs = parts2.join(" ");
            changes.push({ from: text, to: withUs, reason: "単語の間に下線（_）の形があるため「_」を補った", line: outLines.length });
            text = withUs;
          }
          text = fixJapanese(text);
        }
        for (const w of words) {
          if (w.text && w.text.trim() && w.confidence < UNCERTAIN_CONF) {
            uncertain.push({ text: w.text, confidence: Math.round(w.confidence), line: outLines.length, rect: w.srcRect || toSrcRect(w.bbox), lang: source2 });
          }
        }
        parts.push({ cls: c.cls, text, rawText, confidence: r ? Math.round(r.confidence) : Math.round(c.words[0]?.confidence || 0), lang: source2, rect: job.rect });
      }
      const text = parts.map((p) => p.text).filter(Boolean).join(" ");
      outLines.push({ text, rawText: parts.map((p) => p.rawText).filter(Boolean).join(" "), parts, rect: { x: l.src.x0, y: l.src.y0, w: l.src.x1 - l.src.x0, h: l.src.y1 - l.src.y0 } });
    }

    const structured = parseQuestion(outLines);
    const looksLikeQuestion = !!(structured.choices.length || structured.subNumber);
    const text = looksLikeQuestion ? formatQuestion(structured) : outLines.map((l) => l.text).join("\n");
    if (looksLikeQuestion) {
      for (const n of structured.notes) changes.push(n);
      for (const c of structured.choices) if (c.labelUncertain) changes.push({ from: c.labelRead, to: c.label, reason: "選択肢の記号「" + c.labelRead + "」を、順番から「" + c.label + "」と判断（要確認）", uncertain: true });
    }
    // 修正前：言語ごとに読み直した直後の文章（後処理・構造化の前）
    const beforeFix = outLines.map((l) => l.rawText).join("\n");
    return { text, raw, beforeFix, structured: looksLikeQuestion ? structured : null, lines: outLines, uncertain, changes, layout, variantsUsed, pass1Canvas };
  }

  global.ClassiOcr = {
    analyzeLayout, findUnderscoreGaps, chooseScale, renderVariant, otsu, scriptClass, splitLineChunks,
    fixEnglish, fixJapanese, parseQuestion, formatQuestion, joinEnglishLines, diffTokens, runPipeline,
    UNCERTAIN_CONF, CHOICE_LABELS,
  };
})(typeof window !== "undefined" ? window : globalThis);
