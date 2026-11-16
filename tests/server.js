// テスト用の静的ファイルサーバー（依存パッケージなし・127.0.0.1のみで待ち受け）
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 8765);
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
}).listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}/`));
