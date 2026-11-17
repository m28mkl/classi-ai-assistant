// 設定の読み込み。秘密（APIキー・利用コード）は環境変数からだけ読み、コードやファイルには書かない。
const path = require("path");
const { loadPricing, getModelPrice } = require("./pricing");

function intEnv(env, name, def, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`環境変数 ${name} が正しくありません`);
  return n;
}

function numEnv(env, name, def, { min = 0 } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) throw new Error(`環境変数 ${name} が正しくありません`);
  return n;
}

const EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"];

function loadConfig(env = process.env) {
  const apiKey = (env.OPENAI_API_KEY || "").trim();
  if (!apiKey) throw new Error("環境変数 OPENAI_API_KEY が設定されていません");

  const accessCode = env.ACCESS_CODE || "";
  if (!accessCode && env.ALLOW_NO_ACCESS_CODE !== "1") {
    throw new Error("環境変数 ACCESS_CODE（利用コード）が設定されていません。手元の試験だけなら ALLOW_NO_ACCESS_CODE=1 を指定できます");
  }

  const model = env.OPENAI_MODEL || "gpt-6-luna";
  const reasoningEffort = env.OPENAI_REASONING_EFFORT || "low";
  if (!EFFORTS.includes(reasoningEffort)) throw new Error("環境変数 OPENAI_REASONING_EFFORT が正しくありません");

  const dataDir = env.DATA_DIR || path.join(__dirname, "data");
  const pricingFile = env.PRICING_FILE || path.join(__dirname, "pricing.json");
  const pricing = loadPricing(pricingFile);
  getModelPrice(pricing, model); // 料金表にないモデルは起動しない

  return {
    port: intEnv(env, "PORT", 8787, { min: 0, max: 65535 }),
    host: env.HOST || "127.0.0.1",
    allowedOrigins: (env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean),
    accessCode,
    serveStatic: env.SERVE_STATIC === "1",
    openai: {
      apiKey,
      baseUrl: (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
      model,
      reasoningEffort,
      timeoutMs: intEnv(env, "OPENAI_TIMEOUT_MS", 30000, { min: 100 }),
    },
    limits: {
      maxInputTokens: intEnv(env, "MAX_INPUT_TOKENS", 4000),
      maxOutputTokens: intEnv(env, "MAX_OUTPUT_TOKENS", 800),
      dailyMaxCalls: intEnv(env, "DAILY_MAX_CALLS", 50),
      // アプリ側の停止ライン（推定額）。OpenAIの請求を止める上限ではない
      monthlyStopJpy: numEnv(env, "MONTHLY_STOP_JPY", 300, { min: 0 }),
    },
    breaker: {
      failureThreshold: intEnv(env, "BREAKER_FAILURES", 3),
      cooldownMs: intEnv(env, "BREAKER_COOLDOWN_MS", 10 * 60 * 1000),
      authCooldownMs: intEnv(env, "BREAKER_AUTH_COOLDOWN_MS", 60 * 60 * 1000),
    },
    pricingFile,
    pricing,
    ledgerFile: path.join(dataDir, "ledger.json"),
  };
}

module.exports = { loadConfig };
