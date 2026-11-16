// テスト用の静的ファイルサーバー（依存パッケージなし）
// 通常は 127.0.0.1（このPCの中）だけで待ち受ける。
// iPad 実機で試すときだけ HOST=0.0.0.0 を指定すると、同じWi-Fiの端末から開ける（README参照）。
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 8765);
const host = process.env.HOST || "127.0.0.1";
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".md": "text/markdown; charset=utf-8" };

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const file = path.resolve(root, "." + (urlPath === "/" ? "/index.html" : urlPath));
  if (!file.startsWith(root + path.sep) || file.includes(`${path.sep}node_modules${path.sep}`) || file.includes(`${path.sep}.git${path.sep}`)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end("Not Found"); return; }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" }).end(data);
  });
}).listen(port, host, () => {
  console.log(`http://127.0.0.1:${port}/`);
  if (host !== "127.0.0.1") {
    const nets = Object.values(require("os").networkInterfaces()).flat();
    for (const n of nets) if (n && n.family === "IPv4" && !n.internal) console.log(`iPad からは http://${n.address}:${port}/ を開いてください`);
    console.log("※ 同じネットワークの端末から開ける状態です。確認が終わったら Ctrl+C で止めてください。");
  }
});
