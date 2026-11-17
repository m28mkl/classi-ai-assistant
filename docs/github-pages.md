# GitHub Pages で公開する準備

GitHub Pages は、GitHub の公開リポジトリなら**無料**で使えるWebページの公開サービスです。公開すると、iPad の Safari から `https://m28mkl.github.io/classi-ai-assistant/` で開けるようになります。

## 準備（済み）

- アプリのファイルは、すべて相対パス（`ocr-pipeline.js`、`ai-assist.js`、`icons/…`）で読み込むので、Pages のURLの下でもそのまま動きます
- `.nojekyll` を置きました（GitHub が余計な変換をしないようにするため）
- AIのAPIは接続していません（`<meta name="classi-ai-endpoint" content="">` は空のまま）
- https で開くので、iPad でも「コピー」ボタンが使えます

## 公開のしかた（本人の操作。公開する前に確認します）

**今の状態（2026-11-17 調査）**：このリポジトリでは GitHub Pages がすでに有効で、`main` ブランチを公開しています（最後の公開は 2026-11-16）。そのため、今の公開URLでは**古いバージョン**（AI解説・貼り付け・下書きがない版）が表示されます。

方法B（試験公開・おすすめ）：マージせずに、公開するブランチだけを切り替える
1. GitHub のリポジトリ画面で「Settings」→ 左のメニューの「Pages」
2. 「Build and deployment」の「Branch」で、`main` を `claude/ai-paste-answer` に変更（フォルダは `/ (root)` のまま）→「Save」
3. 1〜2分待ち、上部に表示される公開URLを iPad の Safari で開く
4. 元に戻すときは、同じ場所で `main` を選んで「Save」する（何度でも切り替えられる。料金はかからない）

方法A：main にマージしてから公開
- PR #6 と PR #7 を確認して main にマージすると、今の設定（`main` を公開）のまま、新しいバージョンが公開されます

## 注意

- 公開されるのは、選んだブランチの「最新の状態」だけです（過去のコミットの画像などは公開ページには出ません）
- リポジトリは公開（public）なので、Pages で公開されるのも、もともと誰でも見られる内容です。個人情報や本物の課題の画像をリポジトリに入れないでください
- 料金はかかりません（公開リポジトリの GitHub Pages は無料）
