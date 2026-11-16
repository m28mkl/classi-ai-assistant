// index.html 内の <script type="module"> を取り出し、Node.js で構文チェックする
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const scripts = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (!scripts.length) { console.error("index.html に module script が見つかりません"); process.exit(1); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classi-syntax-"));
scripts.forEach((code, i) => {
  const file = path.join(dir, `script-${i}.mjs`);
  fs.writeFileSync(file, code);
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
});
fs.rmSync(dir, { recursive: true, force: true });
console.log(`構文チェックOK（${scripts.length}個のscript）`);
