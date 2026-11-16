// index.html の JavaScript に構文エラーがないことを確認する
const { test, expect } = require("@playwright/test");
const { execFileSync } = require("child_process");
const path = require("path");

test("index.html の JavaScript に構文エラーがない", () => {
  const out = execFileSync(process.execPath, [path.join(__dirname, "check-syntax.js")], { encoding: "utf8" });
  expect(out).toContain("構文チェックOK");
});
