// OpenAI Responses API の呼び出し。再試行はしない（再試行すると、記録されない料金が増えるため）。
// 失敗したとき、請求されたかどうかを charged で示す：
//   "no"      … APIが4xxで拒否した（処理されていない）
//   "unknown" … 通信エラー・時間切れ・5xx・読めない応答（請求された可能性がある）
class UpstreamError extends Error {
  constructor(kind, { status = null, code = null, charged = "unknown" } = {}) {
    super(`upstream ${kind}`);
    this.name = "UpstreamError";
    this.kind = kind; // http | timeout | network | invalid
    this.status = status;
    this.code = code;
    this.charged = charged;
  }
}

async function post(config, pathname, body, fetchImpl = globalThis.fetch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.openai.timeoutMs);
  try {
    let res;
    let text;
    try {
      res = await fetchImpl(`${config.openai.baseUrl}${pathname}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.openai.apiKey}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      text = await res.text();
    } catch (e) {
      throw new UpstreamError(e && e.name === "AbortError" ? "timeout" : "network");
    }
    let json = null;
    try { json = JSON.parse(text); } catch { /* 下で処理 */ }
    if (!res.ok) {
      const code = json && json.error && (json.error.code || json.error.type);
      throw new UpstreamError("http", { status: res.status, code: typeof code === "string" ? code : null, charged: res.status >= 500 ? "unknown" : "no" });
    }
    if (json === null || typeof json !== "object") throw new UpstreamError("invalid");
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/** 送る前に、入力が何トークンになるかを OpenAI の公式の数え方で調べる */
async function countInputTokens(config, body, fetchImpl) {
  const json = await post(config, "/responses/input_tokens", body, fetchImpl);
  if (!Number.isInteger(json.input_tokens) || json.input_tokens < 0) throw new UpstreamError("invalid");
  return json.input_tokens;
}

async function createResponse(config, body, fetchImpl) {
  return post(config, "/responses", body, fetchImpl);
}

/** 応答から文章と拒否を取り出す（output_text は SDK の便利機能なので、生の応答の output から集める） */
function extractOutput(json) {
  let text = "";
  let refusal = false;
  for (const item of Array.isArray(json.output) ? json.output : []) {
    if (item && item.type === "message" && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c.type === "output_text" && typeof c.text === "string") text += c.text;
        if (c.type === "refusal") refusal = true;
      }
    }
  }
  return { text, refusal };
}

module.exports = { UpstreamError, countInputTokens, createResponse, extractOutput };
