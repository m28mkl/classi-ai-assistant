// 料金表（pricing.json）の読み込みと、トークン使用量からの料金計算。
// 料金はコードに書かず、pricing.json（または環境変数 PRICING_FILE で指定したファイル）から読む。
// 単価は「100万トークンあたりの米ドル」。ドル→円は pricing.json の usd_jpy を使う。
const fs = require("fs");

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isNum(v) { return typeof v === "number" && Number.isFinite(v); }

function loadPricing(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("料金表（pricing.json）を読み込めません");
  }
  if (!isNum(data.usd_jpy) || data.usd_jpy <= 0) throw new Error("料金表の usd_jpy（為替）が正しくありません");
  if (!data.models || typeof data.models !== "object") throw new Error("料金表に models がありません");
  if (Number.isNaN(Date.parse(data.updated_at))) throw new Error("料金表の updated_at（更新日）が正しくありません");
  for (const [name, p] of Object.entries(data.models)) {
    if (!isNum(p.input_per_1m_usd) || p.input_per_1m_usd < 0 || !isNum(p.output_per_1m_usd) || p.output_per_1m_usd < 0) {
      throw new Error(`料金表の ${name} の単価が正しくありません`);
    }
    if (p.cached_input_per_1m_usd === undefined) p.cached_input_per_1m_usd = p.input_per_1m_usd;
    if (!isNum(p.cached_input_per_1m_usd) || p.cached_input_per_1m_usd < 0) throw new Error(`料金表の ${name} のキャッシュ入力単価が正しくありません`);
  }
  return data;
}

/** モデルの単価を返す。料金表にないモデルは使えない（金額を推定できないため） */
function getModelPrice(pricing, model) {
  const p = pricing.models[model];
  if (!p) throw new Error(`料金表に ${model} がありません。pricing.json に単価を追加してください`);
  return p;
}

/** API の usage を { input, cached, output } に整える。おかしな値なら null（＝金額が不確か） */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  if (![input, output, cached].every((v) => Number.isInteger(v) && v >= 0)) return null;
  if (cached > input) return null;
  return { input, cached, output };
}

/** 実際の使用量からの料金（米ドル）。出力トークンには考えるためのトークンも含まれている */
function usageCostUsd(price, usage) {
  const uncached = usage.input - usage.cached;
  return (uncached * price.input_per_1m_usd + usage.cached * price.cached_input_per_1m_usd + usage.output * price.output_per_1m_usd) / 1e6;
}

function usageCostJpy(pricing, model, usage) {
  return usageCostUsd(getModelPrice(pricing, model), usage) * pricing.usd_jpy;
}

/** 最悪の場合の料金（円）：入力はすべて通常単価、出力は上限いっぱい */
function worstCaseJpy(pricing, model, inputTokens, maxOutputTokens) {
  const p = getModelPrice(pricing, model);
  const inRate = Math.max(p.input_per_1m_usd, p.cached_input_per_1m_usd);
  return ((inputTokens * inRate + maxOutputTokens * p.output_per_1m_usd) / 1e6) * pricing.usd_jpy;
}

function pricingAgeDays(pricing, now = new Date()) {
  return Math.floor((now.getTime() - Date.parse(pricing.updated_at)) / MS_PER_DAY);
}

function isPricingStale(pricing, now = new Date()) {
  const limit = isNum(pricing.stale_after_days) ? pricing.stale_after_days : 60;
  return pricingAgeDays(pricing, now) > limit;
}

module.exports = { loadPricing, getModelPrice, normalizeUsage, usageCostUsd, usageCostJpy, worstCaseJpy, pricingAgeDays, isPricingStale };
