// @ts-check
const { defineConfig } = require("@playwright/test");

const PORT = 8765;

module.exports = defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    trace: "off",
    browserName: "chromium",
  },
  projects: [
    { name: "syntax", testMatch: /syntax\.spec\.js/ },
    { name: "unit", testMatch: /unit\.spec\.js/ },
    {
      // iPad Air（第5世代以降）縦向き
      name: "ipad-air-portrait",
      testMatch: /e2e\.spec\.js/,
      use: { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    },
    {
      // iPad Air 横向き
      name: "ipad-air-landscape",
      testMatch: /e2e\.spec\.js/,
      use: { viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    },
  ],
  webServer: {
    command: "node tests/server.js",
    url: `http://127.0.0.1:${PORT}/index.html`,
    env: { PORT: String(PORT) },
    reuseExistingServer: !process.env.CI,
  },
});
