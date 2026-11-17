// テスト用の偽のOpenAIサーバー。本物のOpenAIには一切つながない。
// 受け取った要求を requests に記録し、behavior で応答を切り替える。
const http = require("http");

const EXPLANATION = {
  meaning: "光の進み方についての問題です。",
  method: "光の性質を1つずつ確かめます。",
  candidates: ["ア", "エ"],
  reason: "光は直進し、氷は水に浮くからです。",
  pitfalls: "音と光の性質を混ぜないこと。",
};

/** 成功の応答（Responses API の生のJSONの形。output_text は付けない） */
function okResponse({ input = 1000, cached = 0, output = 500, explanation = EXPLANATION, model = "gpt-6-luna-2026-11-01", status = "completed", content } = {}) {
  return {
    id: "resp_test",
    object: "response",
    status,
    model,
    output: [
      { type: "reasoning", id: "rs_1", summary: [] },
      { type: "message", id: "msg_1", role: "assistant", content: content || [{ type: "output_text", text: JSON.stringify(explanation) }] },
    ],
    usage: {
      input_tokens: input,
      input_tokens_details: { cached_tokens: cached },
      output_tokens: output,
      output_tokens_details: { reasoning_tokens: 100 },
      total_tokens: input + output,
    },
  };
}

async function startFakeOpenAI() {
  const fake = {
    requests: [],
    // 各 behavior は { status, json, raw, delayMs, destroy } を返す関数
    count: () => ({ status: 200, json: { object: "response.input_tokens", input_tokens: 500 } }),
    responses: () => ({ status: 200, json: okResponse() }),
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* そのまま */ }
      const record = { path: req.url, method: req.method, headers: req.headers, body };
      fake.requests.push(record);
      const pick = req.url === "/v1/responses/input_tokens" ? fake.count : req.url === "/v1/responses" ? fake.responses : null;
      const r = pick ? pick(body, record) : { status: 404, json: { error: { message: "not found" } } };
      const send = () => {
        if (r.destroy) { req.socket.destroy(); return; }
        res.writeHead(r.status || 200, { "Content-Type": "application/json" });
        res.end(r.raw !== undefined ? r.raw : JSON.stringify(r.json));
      };
      if (r.delayMs) setTimeout(send, r.delayMs); else send();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${server.address().port}/v1`;
  fake.responsesCalls = () => fake.requests.filter((r) => r.path === "/v1/responses");
  fake.close = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
  return fake;
}

module.exports = { startFakeOpenAI, okResponse, EXPLANATION };
