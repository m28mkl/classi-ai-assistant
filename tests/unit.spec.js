// 日付解析・分類・行のまとめ方・並び替えの単体テスト（47件）
// index.html が公開している window.__classiAssistant の関数をブラウザ内で直接呼び出す。
// 「今日」は 2026-11-16 10:00（日本時間）に固定する。
const { test, expect } = require("@playwright/test");

const NOW = new Date("2026-11-16T10:00:00+09:00");

// このファイルの単体テストは1つのページを共有し、1つのワーカーで順番に実行する
test.describe.configure({ mode: "default" });

/** @type {import('@playwright/test').Page} */
let page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ timezoneId: "Asia/Tokyo", locale: "ja-JP" });
  await page.clock.install({ time: NOW });
  // 外部への通信はすべて遮断する
  await page.route("**/*", (route) =>
    route.request().url().startsWith("http://127.0.0.1") ? route.continue() : route.abort());
  await page.goto("/index.html");
  await page.waitForFunction(() => !!window.__classiAssistant);
});

test.afterAll(async () => { await page.close(); });

const call = (fn, arg) => page.evaluate(([f, a]) => window.__classiAssistant[f](a), [fn, arg]);

/* ---------- 日付解析（20件） ---------- */
const DATE_CASES = [
  ["2026年11月20日", { date: "2026-11-20", time: "" }],
  ["提出期限：2026年11月20日（金）17：00", { date: "2026-11-20", time: "17:00" }],
  ["２０２６／１１／２０", { date: "2026-11-20", time: "" }],
  ["2026-11-20", { date: "2026-11-20", time: "" }],
  ["2026.11.20", { date: "2026-11-20", time: "" }],
  ["11/20(金) 17:00", { date: "2026-11-20", time: "17:00" }],
  ["期限 11月20日 23:59", { date: "2026-11-20", time: "23:59" }],
  ["１２月５日", { date: "2026-12-05", time: "" }],
  ["1/8 提出", { date: "2027-01-08", time: "" }], // 半年以上前になるので翌年とみなす
  ["11/1 提出", { date: "2026-11-01", time: "" }], // 少し前なら今年（期限超過）
  ["明日まで", { date: "2026-11-17", time: "" }],
  ["今日中に提出 期限 本日", { date: "2026-11-16", time: "" }],
  ["明後日まで", { date: "2026-11-18", time: "" }],
  ["【重要】明日の時間割変更について", null], // 期限を表す言葉がない相対日付は推測しない
  ["2026年2月30日", null], // 存在しない日付
  ["13/40", null],
  ["英語 ワーク p.10-15", null], // ページ番号を日付と誤認しない
  ["10:00 集合", null], // 時刻だけでは期限にしない
  ["11/20 25:00", { date: "2026-11-20", time: "" }], // 不正な時刻は無視
  ["", null],
];

test.describe("日付解析 parseDue", () => {
  for (const [input, expected] of DATE_CASES) {
    test(`「${input || "(空文字)"}」→ ${expected ? expected.date + (expected.time ? " " + expected.time : "") : "期限なし"}`, async () => {
      expect(await call("parseDue", input)).toEqual(expected);
    });
  }
});

/* ---------- 分類（10文 × 種類・分類 = 20件） ---------- */
const CLASSIFY_CASES = [
  ["数学 課題プリント3", "task", "一般"],
  ["英語 宿題 ワーク p.10-15", "task", "一般"],
  ["進路希望調査票 提出", "task", "手続き"],
  ["理科 レポート", "task", "一般"],
  ["【重要】時間割変更について", "notice", "重要"],
  ["台風による臨時休校のお知らせ", "notice", "重要"],
  ["保護者会のご案内", "notice", "行事・予定"],
  ["期末考査の範囲について", "notice", "行事・予定"],
  ["アンケート回答のお願い", "notice", "手続き"],
  ["図書室だより", "notice", "一般"],
];

test.describe("課題とお知らせの分類", () => {
  for (const [input, kind, category] of CLASSIFY_CASES) {
    test(`種類：「${input}」→ ${kind === "task" ? "課題" : "お知らせ"}`, async () => {
      expect(await call("classifyKind", input)).toBe(kind);
    });
    test(`分類：「${input}」→ ${category}`, async () => {
      expect(await call("classifyCategory", input)).toBe(category);
    });
  }
});

/* ---------- 行のまとめ方（5件） ---------- */
test.describe("読み取り結果からカードを作る extractItems", () => {
  const OCR = "数学 課題プリント\n提出期限：11/20 17:00\n図書だより\n国語 宿題\n英語 宿題 11/18";

  test("関係のある行だけがカードになる", async () => {
    expect((await call("extractItems", OCR)).length).toBe(3);
  });

  test("期限だけの行は、すぐ上の課題の期限になる", async () => {
    const [first] = await call("extractItems", OCR);
    expect([first.title, first.due, first.time, first.kind]).toEqual(["数学 課題プリント", "2026-11-20", "17:00", "task"]);
  });

  test("期限が書かれていない課題は期限が空（＝不明）", async () => {
    const items = await call("extractItems", OCR);
    expect([items[1].title, items[1].due]).toEqual(["国語 宿題", ""]);
  });

  test("同じ行にある期限を読み取る", async () => {
    const items = await call("extractItems", OCR);
    expect(items[2].due).toBe("2026-11-18");
  });

  test("該当する行がなければ、従来どおり全行をカードにする", async () => {
    const items = await call("extractItems", "あいう\nえお");
    expect(items.map((i) => i.title)).toEqual(["あいう", "えお"]);
  });
});

/* ---------- 並び替え（2件） ---------- */
test.describe("期限順ソート sortItems", () => {
  test("日付順・同じ日は時刻順（時刻なしは最後）・同条件は重要が先・期限不明は最後", async () => {
    const mk = (id, due, time = "", category = "一般") => ({ id, due, time, category });
    const sorted = await call("sortItems", [
      mk(1, ""), mk(2, "2026-11-20", "17:00"), mk(3, "2026-11-18"), mk(4, "2026-11-20", "09:00"),
      mk(5, "2026-11-20"), mk(6, "", "", "重要"), mk(7, "2026-11-18", "", "重要"), mk(8, "2025-12-01"),
    ]);
    expect(sorted.map((i) => i.id)).toEqual([8, 7, 3, 4, 2, 5, 6, 1]);
  });

  test("空の一覧でもエラーにならない", async () => {
    expect(await call("sortItems", [])).toEqual([]);
  });
});
