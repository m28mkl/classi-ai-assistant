// OCRで使うCDNの固定URLと、npmから取得した同じファイル（node_modules）との対応表。
// テストでは cdn.jsdelivr.net へ実際には通信せず、npm公式レジストリから取得した
// tesseract.js@5.1.1 などの本物のファイルを返す。これにより「本物のOCR」をオフラインで動かせる。
const fs = require("fs");
const path = require("path");

const NODE_MODULES = path.join(__dirname, "..", "..", "node_modules");
const CDN = "https://cdn.jsdelivr.net/npm/";

const OCR_URLS = {
  library: `${CDN}tesseract.js@5.1.1/dist/tesseract.min.js`,
  worker: `${CDN}tesseract.js@5.1.1/dist/worker.min.js`,
  coreDir: `${CDN}tesseract.js-core@5.1.1/`,
  jpn: `${CDN}@tesseract.js-data/jpn/4.0.0_best_int/jpn.traineddata.gz`,
  eng: `${CDN}@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz`,
};

const RULES = [
  [/^tesseract\.js@5\.1\.1\/dist\/(tesseract\.min\.js|worker\.min\.js)$/, (m) => `tesseract.js/dist/${m[1]}`, "text/javascript"],
  [/^tesseract\.js-core@5\.1\.1\/(tesseract-core(?:-simd)?(?:-lstm)?\.wasm\.js)$/, (m) => `tesseract.js-core/${m[1]}`, "text/javascript"],
  [/^@tesseract\.js-data\/(jpn|eng)\/4\.0\.0_best_int\/((?:jpn|eng)\.traineddata\.gz)$/, (m) => `@tesseract.js-data/${m[1]}/4.0.0_best_int/${m[2]}`, "application/gzip"],
];

/** アプリが取得してよいOCR関連のURLか（固定バージョンのものだけ） */
function isAllowedOcrUrl(url) {
  return localAsset(url) !== null;
}

/** CDNのURLに対応する node_modules 内のファイル（なければ null） */
function localAsset(url) {
  if (!url.startsWith(CDN)) return null;
  const rest = url.slice(CDN.length).split(/[?#]/)[0];
  for (const [re, toPath, contentType] of RULES) {
    const m = rest.match(re);
    if (m) return { file: path.join(NODE_MODULES, toPath(m)), contentType };
  }
  return null;
}

/** route.fulfill 用：CORSヘッダー付きで本物のファイルを返す */
function fulfillLocal(route, url) {
  const asset = localAsset(url);
  return route.fulfill({
    status: 200,
    contentType: asset.contentType,
    headers: { "Access-Control-Allow-Origin": "*" },
    body: fs.readFileSync(asset.file),
  });
}

module.exports = { OCR_URLS, CDN, isAllowedOcrUrl, localAsset, fulfillLocal };
