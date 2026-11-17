# GitHub Pages で公開する準備

GitHub Pages は、GitHub の公開リポジトリなら**無料**で使えるWebページの公開サービスです。公開すると、iPad の Safari から `https://m28mkl.github.io/classi-ai-assistant/` で開けるようになります。

## 準備（済み）

- アプリのファイルは、すべて相対パス（`ocr-pipeline.js`、`ai-assist.js`、`icons/…`）で読み込むので、Pages のURLの下でもそのまま動きます
- `.nojekyll` を置きました（GitHub が余計な変換をしないようにするため）
- AIのAPIは接続していません（`<meta name="classi-ai-endpoint" content="">` は空のまま）
- https で開くので、iPad でも「コピー」ボタンが使えます

## 公開のしかた（本人の操作。公開する前に確認します）

方法A：main にマージしてから公開（おすすめ）
1. PR #6 と PR #7 を確認して、main にマージする
2. GitHub のリポジトリ画面で「Settings」→ 左のメニューの「Pages」
3. 「Build and deployment」の「Source」を「Deploy from a branch」にする
4. 「Branch」を `main`、フォルダを `/ (root)` にして「Save」
5. 1〜2分待つと、上に公開URLが表示される

方法B：マージせずに試す
- 手順4で、`main` の代わりに `claude/ai-paste-answer` を選ぶと、マージ前の内容を公開できます（あとで `main` に戻します）

## 注意

- リポジトリは公開（public）なので、Pages で公開されるのも、もともと誰でも見られる内容です。個人情報や本物の課題の画像をリポジトリに入れないでください
- 料金はかかりません（公開リポジトリの GitHub Pages は無料）
