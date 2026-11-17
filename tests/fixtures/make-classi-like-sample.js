// OCR精度テスト用の「架空の問題画面」の画像（tests/fixtures/classi-like-q01.png）を作る。
//
// - 問題文・選択肢・画面の部品は、すべてこのファイルで作ったオリジナル（実在の教材・サービスの画面ではない）
// - OCRの改善処理（ocr-pipeline.js）が扱う画面の特徴（上の青い帯・動画の帯・灰色の回答欄・ボタン・下の青い帯）を、
//   iPad Air の横向きスクリーンショットと同じ大きさ（2360×1640）で再現する
// - 実行：node tests/fixtures/make-classi-like-sample.js（Playwright の Chromium と日本語フォントが必要）
// - 正解データは tests/fixtures/classi-like-q01.expected.json
const path = require("path");
const { chromium } = require("@playwright/test");

const HTML = `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { width: 1180px; height: 820px; background: #fff; font-family: "Noto Sans CJK JP", "Hiragino Sans", sans-serif; color: #333; position: relative; overflow: hidden; }
.top { position: absolute; left: 0; top: 0; width: 1180px; height: 82px; background: #1a9be0; color: #fff; }
.status { position: absolute; top: 6px; left: 16px; font-size: 13px; font-weight: 600; }
.status-r { position: absolute; top: 6px; right: 18px; font-size: 13px; font-weight: 600; }
.back { position: absolute; top: 40px; left: 34px; font-size: 26px; line-height: 1; }
.close { position: absolute; top: 40px; right: 34px; font-size: 26px; line-height: 1; }
.video { position: absolute; left: 270px; top: 82px; width: 640px; height: 50px; background: linear-gradient(90deg, #d9dbe6, #8f93a6); }
.video .bar { position: absolute; left: 8px; right: 8px; top: 10px; height: 32px; background: #1c1d22; border-radius: 4px; }
.video .seek { position: absolute; left: 14px; right: 130px; top: 15px; height: 3px; background: #555; }
.video .time { position: absolute; left: 6px; top: -2px; background: #fff; color: #111; font-size: 9px; padding: 0 4px; border-radius: 3px; }
.video .ico { position: absolute; top: 7px; width: 14px; height: 14px; border-radius: 50%; background: #eee; }
.c { position: absolute; left: 270px; }
.title { top: 152px; font-size: 18px; font-weight: 700; }
.inst { top: 190px; font-size: 16px; }
.pill { top: 237px; font-size: 13px; font-weight: 700; color: #666; background: #ececec; border-radius: 14px; padding: 4px 10px; }
.sub { top: 274px; font-size: 16px; }
.en { top: 328px; font-size: 16px; line-height: 22px; font-family: "Liberation Sans", Arial, sans-serif; }
.dir { top: 328px; left: 600px; font-size: 16px; line-height: 22px; }
.arrow { font-family: "Noto Sans CJK JP", sans-serif; }
.rw { top: 358px; font-size: 16px; line-height: 22px; font-family: "Liberation Sans", Arial, sans-serif; }
.label { top: 394px; font-size: 13px; color: #999; }
.ch { font-size: 16px; }
.ch b { display: inline-block; width: 36px; font-weight: 700; font-family: "Noto Sans CJK JP", sans-serif; }
.ch span { font-family: "Liberation Sans", Arial, sans-serif; }
.ans { position: absolute; left: 0; top: 579px; width: 1180px; height: 104px; background: #f0f0f0; border-top: 1px solid #ddd; }
.chev { position: absolute; left: 584px; top: 8px; width: 10px; height: 10px; border-right: 2px solid #888; border-bottom: 2px solid #888; transform: rotate(45deg); }
.line { position: absolute; left: 0; right: 0; top: 30px; border-top: 1px solid #d0d0d0; }
.radio { position: absolute; top: 56px; font-size: 15px; }
.radio i { display: inline-block; width: 18px; height: 18px; border: 1px solid #999; border-radius: 50%; background: #fff; vertical-align: -4px; margin-right: 10px; }
.btns { position: absolute; left: 0; top: 683px; width: 1180px; height: 67px; background: #fff; }
.memo { position: absolute; left: 282px; top: 11px; width: 84px; height: 44px; border: 1px solid #aaa; border-radius: 6px; font-size: 10px; text-align: center; padding-top: 22px; color: #555; }
.go { position: absolute; left: 394px; top: 11px; width: 512px; height: 44px; background: #2a84f0; color: #fff; border-radius: 22px; font-size: 16px; font-weight: 700; text-align: center; line-height: 44px; }
.bottom { position: absolute; left: 0; top: 750px; width: 1180px; height: 70px; background: #1a9be0; }
.bottom i { position: absolute; top: 20px; width: 20px; height: 20px; border: 2px solid #fff; border-radius: 50%; }
</style></head><body>
<div class="top"><div class="status">9:41　11月17日(火)</div><div class="status-r">58%</div><div class="back">‹</div><div class="close">×</div></div>
<div class="video"><div class="bar"><div class="time">03:28</div><div class="seek"></div><div class="ico" style="right:96px"></div><div class="ico" style="right:72px"></div><div class="ico" style="right:48px"></div><div class="ico" style="right:24px"></div></div></div>
<div class="c title">練習問題_関係代名詞と前置詞02</div>
<div class="c inst">次の問いに答えなさい。</div>
<div class="c pill">小問01</div>
<div class="c sub">次の英文を指示にしたがって書きかえるとき，（　　）に入るものを選びなさい。</div>
<div class="c en">This is the park. I played in it last week.</div>
<div class="c dir">（一つの文に）</div>
<div class="c rw"><span class="arrow">⇒</span>This is the park (&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;) last week.</div>
<div class="c label">選択肢</div>
<div class="c ch" style="top:424px"><b>ア</b><span>in I played which</span></div>
<div class="c ch" style="top:464px"><b>イ</b><span>which in I played</span></div>
<div class="c ch" style="top:503px"><b>ウ</b><span>in which I played</span></div>
<div class="c ch" style="top:543px"><b>エ</b><span>I played which</span></div>
<div class="ans"><div class="chev"></div><div class="line"></div>
  <div class="radio" style="left:270px"><i></i>ア</div><div class="radio" style="left:352px"><i></i>イ</div>
  <div class="radio" style="left:434px"><i></i>ウ</div><div class="radio" style="left:516px"><i></i>エ</div></div>
<div class="btns"><div class="memo">メモ</div><div class="go">答え合わせ</div></div>
<div class="bottom"><i style="right:120px"></i><i style="right:52px"></i></div>
</body></html>`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 });
  await page.setContent(HTML);
  await page.screenshot({ path: path.join(__dirname, "classi-like-q01.png") });
  await browser.close();
  console.log("作成しました：tests/fixtures/classi-like-q01.png");
})();
