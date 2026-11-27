# Feature Map（browser-translator）

対象: 基準ページでの置き換え翻訳（オン・オフ・ホバー）、llama-server に接続できないときの表示、設定画面（URL・モデル・送り方・用語集）とその反映。
対象外（まだ手順がない）: React のページでの置き換え・対訳表示と SPA での継続、対訳表示、MutationObserver、直列と並列の訳語統一の比較、用語集の語形の違い。訳文の品質の定量評価、Chrome 以外のブラウザ。

この Map は手順と期待結果だけを持つ。各回の観測結果は `.pi/verification-evidence/<run>/run.md` に書く。

## 置き換え翻訳（基準ページ）

- **到達方法**: 一時プロファイルの Chrome に `dist/` を読み込み、https://huggingface.co/blog/ibm-research/an-indic-voice-agent-with-cuga を開いて、ツールバーのボタン（`chrome.action.onClicked`）を押す。もう一度押すとオフ。
- **前提**: 自分のポート（例 127.0.0.1:18080）で自分が起動した llama-server（router モード）が使用可能（[SKILL.md](../SKILL.md) の手順 1〜3）。
- **操作**: `node scripts/verify-translate.ts translate <evidenceDir> --server=http://127.0.0.1:18080`（設定画面で URL を保存してから、ボタンを CDP の `Extensions.triggerAction` で押す）。
- **期待と観測**（`translate.json` の `checks` と `observed`）:
  - `optionsSaved`（`--server` のとき）: 設定画面で保存した URL が `chrome.storage.local` に入った。
  - `badgeOn`: オンでバッジが `ON`。
  - `articleJapanese`: `.blog-content` の本文の段落（`p`・`li`・見出し。中に段落を持つ `li` を除く）が、訳されたか目印付き（`.blog-content` の外の目印は数えない）で、訳された段落はすべて日本語を含む。
  - `preUnchanged`: `pre` の中身が翻訳前と同じで、日本語も拡張の目印もない。
  - `knowledgeEngine` / `guardrails`: 「The knowledge engine.」「Keep guardrails cheap.」の段落で `code` が `agent.knowledge.search()` / `OFF_TOPIC` のまま 1 つ残り、`strong` が 1 つ残る。自然な位置かは `observed.*.html` とスクリーンショットで目で確かめる。
  - `cugaLink`: 「CUGA (ConfigUrable …」の段落に `href="https://cuga.dev"` の `a`（中身 CUGA）が残る。
  - `noLeftoverTags`: 訳された段落に `<a1>` などのタグ文字列が残っていない（タグの抜け・重複がある訳は採用されないため、目印のない段落は抜け・重複がない）。`observed.failed` に訳せなかった段落（原文のまま ⚠ の目印）があれば一覧される。
  - `hoverShowsOriginal`: 訳した段落の `title` が原文（マウスを乗せるとツールチップで原文が出る）。
  - `offRestoresDom` / `offBadgeCleared`: オフ後、対象の全段落と `pre` の `textContent` と `outerHTML`（要素自身の `title` 属性を含む）が翻訳前と一致し、拡張の目印（`data-browser-translator`）が 0、バッジが空。
- **証拠**: `translate.json`、`translate-options.png`（`--server` のとき）、`translate-0-before.png`、`translate-1-top.png`、`translate-2-{cuga,knowledge,guardrails}.png`、`translate-3-off.png`。
- **注意**: 訳文はモデルの出力なので、run ごとに文言は変わる。中に段落を持つ `li`（目次など）の直下の文字は訳さない（content.ts の shortcut）。ホバーはブラウザのツールチップのため、スクリーンショットには写らない（`title` 属性で確認する）。

## 接続エラー

- **到達方法**: 設定の URL に何も listen していない状態で、基準ページでボタンを押す。
- **前提**: 自分の llama-server を PID で止め、`lsof -iTCP:18080 -sTCP:LISTEN` が空。
- **操作**: `node scripts/verify-translate.ts unreachable <evidenceDir> --server=http://127.0.0.1:18080`。
- **期待と観測**（`unreachable.json`）: `optionsSaved`、`noticeShown`（ページ右上に「llama-server に接続できません」と設定の URL を含む通知）、`badgeError`（バッジが `ERR`）。`options.modelsStatus` は設定画面での一覧の取得失敗の表示（「モデルの一覧を取得できません（…）」）。
- **証拠**: `unreachable.json`、`unreachable-options.png`（一覧の取得失敗の表示）、`unreachable-0-before.png`、`unreachable-1-on.png`。

## 設定画面・URL・モデル・直列・用語集

- **到達方法**: `chrome-extension://<id>/options.html`（`chrome://extensions` の「拡張機能のオプション」と同じページ。製品では `chrome://extensions` の上のダイアログで開くが、helper はこのページをタブで直接開く）を開き、URL を入れて「モデルの一覧を取り直す」、モデルを選び、送り方を選び、用語集を書いて「保存」。その後、基準ページでボタンを押す。
- **前提**: 自分のポート（例 127.0.0.1:18080）で llama-server（router モード、`/v1/models` に 2 つ以上）が使用可能。
- **操作**: `node scripts/verify-settings.ts <evidenceDir> http://127.0.0.1:18080`。送信内容は service worker のセッションの `Network.requestWillBeSent` / `loadingFinished`（URL・時刻・本文）と `Network.getResponseBody`（訳文）で観測する。製品コードに観測用の分岐はない。
- **期待と観測**（`settings.json` の `checks`。`phase1`〜`phase3` に送信数・送信先・モデル・同時送信数・context／履歴の有無）:
  - `optionsListModels`: 設定画面の select に `/v1/models` の全モデルが並ぶ（加えて「先頭のモデルを使う」）。
  - `optionsSaved`: 「保存しました」と表示され、`chrome.storage.local` に URL（入力の末尾 `/` を除いたもの）・選んだモデル・並列・用語集 2 語が入る。
  - `urlUsed`: (1) の翻訳の送信がすべて設定の URL。
  - `modelUsed`: (1) の `/v1/completions` の `model` がすべて選んだ 2 番目のモデル。`serialFirstModel`: 「先頭のモデルを使う」に戻すと `/v1/models` の先頭。
  - `parallelTranslated` / `parallelAgain`: 並列は同時送信が 2 以上、context に `Previous/Next paragraph` があり、履歴がない。直列から戻しても同じ。
  - `serialOneAtATime`: 直列は送信の重なりがない（同時 1）。`serialNoNeighbours`: context に前後の段落がない（ページの説明だけ）。
  - `serialHistory`: 最初の段落は履歴なし、2 件目以降は直前に送った段落の入力と、モデルが返した訳文（タグ付きのまま）の 1 組が `input`/`output` として入る（履歴が始まって以降のすべての送信で直前の送信と一致すること。`phase2.historyFromPrevious` が一致した数）。
  - `glossaryOnlyWhereMatched`: `harness` を語として含む段落のプロンプトだけに `glossary`（`harness`）があり、`pi` はどのプロンプトにも入らない（基準ページに単語の pi はない）。
  - `piNotInApi`: `API` を含む段落（「…speech APIs…」）のプロンプトに `pi` の glossary がない。
  - `glossaryApplied`: `harness` を含む段落の訳文がすべて訳語「実行基盤」を含む（`phase1.harnessTranslations`）。
  - `allRequestsToServerOrDefaultModels`: run 中の送信はすべて設定の URL か、設定画面を最初に開いたときの既定 URL の `/v1/models`（何もいないので失敗）だけ（`allRequests`）。
- **証拠**: `settings.json`、`settings-options-{1,2,3}.png`（保存後の設定画面）、`settings-1-parallel-model-glossary.png`、`settings-2-serial.png`、`settings-3-parallel-again.png`。
- **注意**: 訳文はモデルの出力なので、`glossaryApplied` は run によって変わりうる（2B で確認。0.8B では glossary を送っても従わない段落があった）。`pi` が `api` に当たらないことの網羅は `test/glossary.test.ts`。直列の訳語統一が並列より良いかは対象外。

## ツールバーのボタンの実クリック（手動）

- **到達方法**: ヘッドありの Chrome（一時プロファイル）で `dist/` を読み込み、基準ページでツールバーの拡張のボタン（パズルのアイコンから固定してもよい）を押す。
- **期待**: バッジが `ON` になり本文が日本語になる。もう一度押すと原文に戻り、バッジが消える。
- **証拠**: 確認した人・日時・結果を `run.md` に書く。CDP の `Extensions.triggerAction` は同じ `chrome.action.onClicked` を発火するが、画面上のクリックそのものではない。

## 通信先（静的な確認）

- `src/manifest.json` の `host_permissions` が `http://localhost/*` と `http://127.0.0.1/*` だけ。
- `grep -n "fetch(" src/*.ts dist/*.js` が `background` の `/v1/models` と `/v1/completions`（設定の URL 経由）だけ。設定画面のモデル一覧も `chrome.runtime.sendMessage({ type: "models" })` で background が取る（`options.js` に `fetch(` がない）。
