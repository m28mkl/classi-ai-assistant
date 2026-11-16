// 画面テスト用の偽Tesseract。
// ライブラリ本体（tesseract.min.js）は本物を読み込ませ（SRIのハッシュ確認も本番どおり行われる）、
// window.Tesseract だけをこの偽物に差し替える。認識結果を固定できるので、画面の動きを確実にテストできる。
//
// mode:
//   "ok"             … 指定した text を返す
//   "no-createWorker"… Tesseract はあるが createWorker がない（今回の不具合と同じ状態）
//   "init-fail"      … Worker の初期化（言語データ読み込みなど）に失敗する
//   "recognize-fail" … 文字の認識で失敗する
//   "init-hang"      … 初期化が終わらない（進み具合の連絡も来ない）
async function installFakeTesseract(page, { text = "", mode = "ok", delayMs = 0 } = {}) {
  await page.addInitScript(({ text, mode, delayMs }) => {
    const calls = { createWorker: [], recognize: 0, terminate: 0 };
    window.__ocrCalls = calls;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const fake = {
      async createWorker(langs, oem, options = {}) {
        calls.createWorker.push({ langs, oem, workerPath: options.workerPath, corePath: options.corePath });
        if (mode === "init-hang") return new Promise(() => {});
        options.logger?.({ status: "loading language traineddata", progress: 0.5 });
        await wait(delayMs);
        if (mode === "init-fail") throw new Error("Network error while fetching jpn.traineddata.gz");
        return {
          async recognize() {
            calls.recognize += 1;
            options.logger?.({ status: "recognizing text", progress: 0.5 });
            await wait(delayMs);
            if (mode === "recognize-fail") throw new Error("recognize failed");
            return { data: { text } };
          },
          async terminate() { calls.terminate += 1; },
        };
      },
    };
    const value = mode === "no-createWorker" ? { version: "5.1.1" } : fake;
    Object.defineProperty(window, "Tesseract", { configurable: true, get: () => value, set: () => {} });
  }, { text, mode, delayMs });
}

/** 1×1 の白いPNG（画像として正しく開ける最小のファイル） */
const TINY_PNG = {
  name: "classi.png",
  mimeType: "image/png",
  buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64"),
};

module.exports = { installFakeTesseract, TINY_PNG };
