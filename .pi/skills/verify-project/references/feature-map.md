# Feature Map（browser-translator）

対象: 基準ページでの置き換え翻訳（オン・オフ・ホバー）と対訳表示、React のページ（react.dev）での置き換え・対訳、あとから追加された段落（MutationObserver）、SPA の URL 変更での継続、リロードでの終了、llama-server に接続できないときの表示、設定画面（URL・モデル・送り方・表示方法・用語集）とその反映。
対象外（まだ手順がない）: 直列と並列の訳語統一の比較、用語集の語形の違い、react.dev 以外の React のページ、ページが訳文の段落を書き換えたときの訳し直し（react.dev では起きなかった）。訳文の品質の定量評価、Chrome 以外のブラウザ。

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
  - `noLeftoverTags`: 訳された段落の `code` の外に、送ったタグの文字列（`<a>`・`<code id="2">`・`</strong>` など）が残っていない（`code` の中の `<h1>` などは原文の文字なので数えない。タグの抜け・重複がある訳は採用されないため、目印のない段落は抜け・重複がない）。`observed.failed` に訳せなかった段落（原文のまま ⚠ の目印）があれば一覧される。
  - `hoverShowsOriginal`: 訳した段落の `title` が原文（マウスを乗せるとツールチップで原文が出る）。
  - `offRestoresDom` / `offBadgeCleared`: オフ後、対象の全段落と `pre` の `textContent` と `outerHTML`（要素自身の `title` 属性を含む）が翻訳前と一致し、拡張の目印（`data-browser-translator`）が 0、バッジが空。
- **証拠**: `translate.json`、`translate-options.png`（`--server` のとき）、`translate-0-before.png`、`translate-1-top.png`、`translate-2-{cuga,knowledge,guardrails}.png`、`translate-3-off.png`。
- **注意**: 訳文はモデルの出力なので、run ごとに文言は変わる。中に段落を持つ `li`（目次など）の直下の文字は訳さない（content.ts の shortcut）。ホバーはブラウザのツールチップのため、スクリーンショットには写らない（`title` 属性で確認する）。

## 対訳表示（基準ページ）

- **到達方法**: 設定画面の「表示方法」で「対訳」を選んで保存し、基準ページでボタンを押す。もう一度押すとオフ。
- **前提**: 「置き換え翻訳」と同じ。
- **操作**: `node scripts/verify-translate.ts bilingual <evidenceDir> --server=http://127.0.0.1:18080`。
- **期待と観測**（`bilingual.json` の `checks`）:
  - `optionsSaved`: `chrome.storage.local` に URL と `display: "bilingual"`。
  - `badgeOn`・`articleJapanese`・`preUnchanged`・`noLeftoverTags`: 置き換え翻訳と同じ（訳文は差し込んだ要素の中）。
  - `knowledgeEngine` / `guardrails` / `cugaLink`: 差し込んだ訳文に `code`・`strong`・リンクが保たれる。
  - `bilingualBelow`: 置き換えた段落が 0、訳文はすべて段落の最後の子で `display:block`（原文の下）。3 つの段落では訳文の上端が段落の上端より下。
  - `bilingualOriginalKept`: 差し込んだ要素を除くと、全段落と `pre` の `outerHTML` が翻訳前と一致する（原文の DOM に手を入れない）。
  - `offRestoresDom` / `offBadgeCleared`: オフで差し込みが消え、DOM が翻訳前と一致し、目印 0、バッジが空。
- **証拠**: `bilingual.json`、`bilingual-options.png`、`bilingual-0-before.png`、`bilingual-1-top.png`、`bilingual-2-{cuga,knowledge,guardrails}.png`、`bilingual-3-off.png`。

## React のページ・あとから追加された段落・SPA・リロード

- **到達方法**: 設定画面で表示方法を選んで保存し、https://react.dev/learn でボタンを押す。ページ内のリンク（左のメニューや本文の `/learn/describing-the-ui`）を押して移動する。リロードする。
- **前提**: 「置き換え翻訳」と同じ。外部サイト react.dev にアクセスできること。
- **操作**: `node scripts/verify-react.ts replace <evidenceDir> --server=http://127.0.0.1:18080` と `node scripts/verify-react.ts bilingual <evidenceDir> --server=http://127.0.0.1:18080`。送信は service worker のセッションの Network で数える。リンクは CDP の `Input.dispatchMouseEvent` で押す。
- **期待と観測**（`react-<display>.json` の `checks`）:
  - `optionsSaved`・`badgeOn`: 設定が入り、オンでバッジ `ON`。
  - `translated`: `article` の段落（content.ts と同じ規則）がすべて訳されたか ⚠。`codeWithLtTranslated`: `code` の中に `<` を含む段落（例 `<MyButton />`）が 1 つ以上あり、すべて ⚠ ではなく訳された（`translated.codeWithLt`）。`noNestedInserted`: 差し込み要素の中に差し込み要素がない。`bilingualBelow`（対訳のとき）: 置き換えた段落 0、訳文はすべて段落の最後の `display:block` の子。
  - `stillTranslatedAfterIdle`: 5 秒待ち、最後までスクロールし、リンクにマウスを乗せ、さらに 5 秒待った後も訳されたまま。
  - `addedTranslated` / `addedNoLoop`: ページ側で `article` に足した英語の段落が日本語になり、そのための送信が 1〜2 回（訳し直しを含む）で止まる。
  - `redrawnTranslated` / `redrawnNoLoop`: ページがその段落を自分の子の複製で描き直す（差し込み要素は落ちる）と、日本語の表示が戻る。対訳では消えた訳文を訳し直す送信が 1〜2 回で止まり、置き換えでは本文が訳文のままなので送信 0。
  - `spaSameDocument`: リンクを押すと `location.pathname` が変わり、document の移動（`Page.frameNavigated`）がなく、`window` に置いた目印が残る。
  - `spaBadgeOn`: 移動の直後と訳し終わった後もバッジ `ON`。`spaTranslated`: 新しいページの `article` の段落がすべて訳されたか ⚠ で、送信がある。
  - `quietNoRequests`: その後 8 秒、送信が 0（訳文や差し込み要素を訳し直さない）。
  - `offNoMarkers` / `offBadgeCleared`: オフで目印 0、バッジが空。
  - `reloadEndsMode`: オンにした後リロードすると、目印 0、`window` の目印が消え（新しい document）、バッジが空。
  - `backEndsMode`: オンにして目印が付いた後、同じタブで通常の移動（`/blog` へ `Page.navigate`）をして履歴で戻る（`Page.navigateToHistoryEntry`）と、目印 0、バッジが空で、ボタンを押すとバッジ `ON`（オンになる）。`back.restoredFromCache`（`window` の目印が残った＝ bfcache から戻った）と `back.bfcacheNotUsed`（`Page.backForwardCacheNotUsed` の理由）を記録する。
  - `allRequestsToServer`: 送信は設定の URL か、設定画面を開いたときの既定 URL の `/v1/models` だけ。
- **記録値**（checks ではない。`run.md` に書く）: `translated.failedParagraphs` / `spa.failedParagraphs`（⚠ の段落と目印の `title`）と `retried`（訳し直した段落の送った入力と、最初と訳し直しの応答。⚠ の原因がモデルの出力か送り方の誤りかを見分ける）、`idleRequests`（待つ・スクロール・ホバーの間の翻訳の送信数。ページが訳文を原文に戻すと content.ts が目印を外して訳し直すため、戻しはここに出る）と `shownBeforeIdle` / `shownAfterIdle`（置き換えた段落と差し込んだ訳文の数。戻しが残れば減る）、`pageErrors` / `errorsAfterTranslation`（ページの例外と `console.error`。ハイドレーションエラーなど）、`translated.horizontalOverflow` / `scrollHeight`（崩れの目安）、`spaRequests`、`navigations`。崩れの有無はスクリーンショットを目で確かめる。崩れや戻しがあった場合は、対訳で読めるかを `react-bilingual-*` で確かめる。
- **証拠**: `react-<display>.json`、`react-<display>-options.png`、`react-<display>-{0-before,1-translated,2-after-idle,3-added,4-spa,5-off,6-reload,7-back}.png`。
- **注意**: react.dev の内容が変わると候補の段落数やリンクが変わる。リンクが無くなったら `--link=<path>` で別のページ内リンクを渡す。バッジは Chrome がタブごとに持ち、document の移動（リロード・通常の移動・bfcache からの戻り）で消える。SPA の移動では消えない。

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
  - `serialHistory`: 最初の段落は履歴なし、2 件目以降は、それより前の送信のうち採用された（応答が切れておらず、`src/text.ts` の `restoreTags` で送ったタグに対して復元できる）最新の送信の入力と、モデルが返した訳文（タグ付きのまま）の 1 組だけが `input`/`output` として入る。採用されなかった応答（訳し直しの対象や ⚠ になった応答）は履歴に一度も現れない（`phase2.historyFromPrevious` が一致した数、`phase2.rejected` が採用されなかった送信の数）。
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
