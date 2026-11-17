// AI解説のサーバー（追加パッケージなし）。APIキー・利用コードは環境変数だけで管理する。
//   GET  /api/status   … 利用回数・推定利用額・停止状態（内容や秘密は含まない）
//   POST /api/explain  … 確認済みの問題文を送って解説を受け取る
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { loadConfig } = require("./config");
const { Budget } = require("./budget");
const { explain, publicStatus, fail } = require("./explain");

const MAX_BODY_BYTES = 32 * 1024;

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function createServer(config, { fetchImpl, now } = {}) {
  const budget = new Budget({
    file: config.ledgerFile,
    monthlyStopJpy: config.limits.monthlyStopJpy,
    dailyMaxCalls: config.limits.dailyMaxCalls,
    breaker: config.breaker,
    now,
  });

  function corsHeaders(req) {
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.includes(origin)) {
      return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Headers": "Content-Type, X-Access-Code",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      };
    }
    return { Vary: "Origin" };
  }

  function send(req, res, status, body) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...corsHeaders(req),
    });
    res.end(JSON.stringify(body));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) { reject(new Error("too large")); req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders(req));
        return res.end();
      }
      if (req.method === "GET" && url.pathname === "/api/status") {
        return send(req, res, 200, { ok: true, ai: publicStatus(config, budget) });
      }
      if (req.method === "POST" && url.pathname === "/api/explain") {
        if (config.accessCode && !safeEqual(req.headers["x-access-code"] || "", config.accessCode)) {
          const f = fail("bad_access_code", config, budget);
          return send(req, res, f.httpStatus, f.body);
        }
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          const f = fail("invalid_request", config, budget);
          return send(req, res, f.httpStatus, f.body);
        }
        const out = await explain(body, { config, budget, fetchImpl });
        return send(req, res, out.httpStatus, out.body);
      }
      if (config.serveStatic && req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        // 同じサーバーから画面を配るときは、AIの接続先を「/api」にする
        const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8")
          .replace(/(<meta name="classi-ai-endpoint" content=")(")/, "$1/api$2");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff" });
        return res.end(html);
      }
      if (config.serveStatic && req.method === "GET" && (url.pathname === "/ocr-pipeline.js" || url.pathname === "/ai-assist.js")) {
        // OCRの改善処理・AIの部品（画面と一緒に配る。決まった2つのファイルだけ）
        const js = fs.readFileSync(path.join(__dirname, "..", url.pathname.slice(1)), "utf8");
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "X-Content-Type-Options": "nosniff" });
        return res.end(js);
      }
      send(req, res, 404, { ok: false, code: "not_found" });
    } catch {
      // 内容はログに出さない（問題文や秘密が入る可能性があるため）
      if (!res.headersSent) send(req, res, 500, { ok: false, code: "server_error", message: "サーバーでエラーが発生しました。" });
      else res.end();
    }
  });
  return { server, budget };
}

if (require.main === module) {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    console.error("起動できません：" + e.message);
    process.exit(1);
  }
  const { server } = createServer(config);
  server.listen(config.port, config.host, () => {
    console.log(`AI解説サーバー: http://${config.host}:${config.port}/api/status`);
    console.log(`モデル ${config.openai.model} ／ 停止ライン ${config.limits.monthlyStopJpy}円（推定） ／ 1日 ${config.limits.dailyMaxCalls}回`);
  });
}

module.exports = { createServer };
