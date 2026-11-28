# Feature Map（browser-translator）

対象: 基準ページでの置き換え翻訳（オン・オフ・原文の吹き出し）と対訳表示、白いページ・暗いページでの吹き出しの色、React のページ（react.dev）での置き換え・対訳、あとから追加された段落（MutationObserver）、SPA の URL 変更での継続、リロードでの終了、llama-server に接続できないときの表示、設定画面（URL・モデル・送り方・表示方法・用語集）とその反映、リーダー表示（翻訳なし）。
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
  - 原文の吹き出し（「Keep guardrails cheap.」の段落。CDP の `Input.dispatchMouseEvent` の `mouseMoved` で乗せる。観測値は `bubble`）:
    - `bubbleShowsOriginal`: 乗せて 0.2 秒では出ておらず、0.7 秒後に吹き出しが 1 つ出る。`<html>` の直下の目印付きの要素の open な Shadow DOM の中身が原文（翻訳前に page の main world の `WeakMap` に控えた段落の文字）、`font-size` が段落の計算済みの値と同じ、幅と左端が段落と同じ（誤差 1px）、`user-select` が `none` でない。段落に `title` 属性がない。
    - `bubblePlacement`: 段落を画面の中央に置くと吹き出しは段落の下、画面の下端に置く（下に入らない）と段落の上。どちらも「下に入れば下、入らず上に入れば上」の期待どおり。
    - `bubbleColors`: 吹き出しの中の `div` の計算済みの `background-color` / `border-top-color` / `color` が `rgb(255, 246, 204)` / `rgb(184, 146, 26)` / `rgb(31, 31, 31)`（`#fff6cc`・`#b8921a`・`#1f1f1f`。元のページは固定の薄い黄）。観測値は `bubble.colors`。
    - `bubbleStaysOnHover`: マウスを吹き出しの中央へ動かして 1 秒後も残る。`bubbleHidesOnLeave`: 段落と吹き出しの外（左の余白）へ動かして 1 秒後に消える。
  - `offRestoresDom` / `offBadgeCleared`: オフ後、対象の全段落と `pre` の `textContent` と `outerHTML` が翻訳前と一致し（拡張は段落の `title` 属性に触れない）、吹き出しを含む拡張の目印（`data-browser-translator`）が 0、バッジが空。
- **証拠**: `translate.json`、`translate-options.png`（`--server` のとき）、`translate-0-before.png`、`translate-1-top.png`、`translate-2-{cuga,knowledge,guardrails}.png`、`translate-4-bubble.png`（段落の下の吹き出し）、`translate-5-bubble-above.png`（段落の上の吹き出し）、`translate-3-off.png`。
- **注意**: 訳文はモデルの出力なので、run ごとに文言は変わる。中に段落を持つ `li`（目次など）の直下の文字は訳さない（content.ts の shortcut）。吹き出しの見た目（薄い黄 `#fff6cc`・枠 `#b8921a`・文字 `#1f1f1f`・影）は `translate-4-bubble.png` / `translate-5-bubble-above.png` で目で確かめる。白いページと暗いページで本文と区別できるかは下の「吹き出しの色（白いページ・暗いページ）」で見る。吹き出しの文字の選択とコピーそのものは CDP では見ない（手動の節）。対訳表示では吹き出しを出さない。

## 吹き出しの色（白いページ・暗いページ）

- **到達方法**: 設定画面で表示方法「置き換え」を保存し、https://react.dev/learn を `prefers-color-scheme: light`（白い背景）と `dark`（暗い背景）で開いてボタンを押し、訳した段落にマウスを乗せる。
- **前提**: 「置き換え翻訳」と同じ。外部サイト react.dev にアクセスできること。
- **操作**: `node scripts/verify-bubble-colors.ts <evidenceDir> --server=http://127.0.0.1:18080`。配色は CDP の `Emulation.setEmulatedMedia`（`features: [{ name: "prefers-color-scheme", value }]`）で切り替え、各配色でページを開き直す。マウスは `Input.dispatchMouseEvent` の `mouseMoved` で、`article` の 2 行以上の最初の訳した段落に乗せて 0.9 秒後に撮る。
- **期待と観測**（`bubble-colors.json`）:
  - `optionsSaved`: URL と `display: "replace"` が入った。
  - `lightBubbleColors` / `darkBubbleColors`: 吹き出しが 1 つ出て、色が `bubbleColors` と同じ固定の値（ページの明暗で変わらない）。`light.bodyBackground` / `dark.bodyBackground` に body の背景色を残す（react.dev では白 `rgb(255, 255, 255)` と暗い `rgb(35, 39, 47)` の見込み）。
  - 目視: `bubble-colors-light.png`・`bubble-colors-dark.png` で、吹き出しが本文（背景と下の段落）と区別できる。
- **証拠**: `bubble-colors.json`、`bubble-colors-options.png`、`bubble-colors-light.png`、`bubble-colors-dark.png`。
- **注意**: 区別できるかの判断は目視（checks は色の値だけ）。react.dev の配色が変われば `bodyBackground` も変わる。

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

## リーダー表示

- **到達方法**: ツールバーの拡張のボタンかページを右クリックして「リーダー表示」、またはショートカット `Alt+Shift+R`（Mac は Option+Shift+R）。同じ操作でもう一度押すと閉じる。✕・Esc でも閉じる。
- **前提**: 外部サイト（基準ページ、https://react.dev/learn 、https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/table ）にアクセスできること。llama-server は不要（リーダーの中はまだ翻訳しない）。
- **操作**: `timeout 400 node scripts/verify-reader.ts <evidenceDir>`。各ページの最初の開閉は CDP のキー入力でショートカットを押し、以降は service worker の `toggleReaderTab(tabId)` を呼ぶ。バー・リンクは `Input.dispatchMouseEvent`、Esc は `Input.dispatchKeyEvent`。
- **期待と観測**（`reader.json` の `checks` と `observed`）:
  - `commandAssigned`: `chrome.commands.getAll()` に `toggle-reader` があり、ショートカットが割り当てられている（Mac では `⌥⇧R`）。
  - `shortcutOpens` / `reactRendered`: ショートカットで `<html>` 直下の目印付きの `position:fixed` の要素（open な Shadow DOM）が 1 つでき、見出し・段落・`pre` が描かれる。
  - `firstOpenBlack` / `defaultLook`: 保存値なし（一時プロファイル）で初めて開くと背景 `rgb(30, 30, 30)`・文字 `rgb(212, 212, 212)`、ゴシック・18px・40em（720px）。`translateButtonInert`: バーの翻訳ボタンは押せない（#14 では動かさない）。
  - `reactPreSame`: react.dev/learn のリーダーの `pre` の数が元のページと同じで、中に `p`・`div` がなく、各 `pre` の行数・各行の字下げと文字が元のページ（`.cm-line` ごと）と一致する。行の間が空いていないかは `reader-react-2-code.png` を目で確かめる。
  - `onlyReaderScrolls`: ホイールでリーダーの中がスクロールし、ページの `scrollY` は変わらない。
  - `barTheme` / `barFont` / `barSize` / `barWidth`: セピア・白の背景色と文字色、明朝（`pre` は等幅のまま）、文字 20px、行幅 45em（900px）が計算済みスタイルに出る。`lookStored`: `chrome.storage.local` の `reader` に入る。`reopenSameLook`: ✕ で閉じて開き直すと同じ値。`observed.fonts`: ゴシック・明朝それぞれの `CSS.getPlatformFontsForNode`（実際のフォント名）。
  - `closeButtonCloses` / `closeKeepsScroll` / `toggleCloses`: ✕ でも、同じ切り替えでも閉じ、ページの `scrollY` は開く前と同じ。
  - `escCloses` / `escNotPassed` / `escKeyupNotPassed` / `escKeepsScroll`: リーダーの文字を選んだ状態で Esc を押すと閉じ、helper がページに置いた `keydown` の目印（document の capture・bubble、window）も `keyup` の目印（document の capture、window の bubble）も Esc を受け取っていない。`observed.escapeAfterClose` に、閉じた後の Esc は `keydown`・`keyup` ともページに届くことを残す。ページが拡張より先に window の capture に置いた listener には届く（README の制限）。
  - `shiftTabEscKeepsScroll` / `shiftTabCloseButtonKeepsScroll`: ページを `scrollY` 400 にして開き、CDP のキー入力で Shift+Tab を 3 回送ってフォーカスを背後のページの要素へ移す（`observed.shiftTab.*.whileOpen` にそのときのページの `scrollY` とフォーカス先）。Esc・✕ で閉じると、ページの `scrollY` が開く前と同じ。
  - `hashLinkClosesAndMoves` / `linkClosesAndMoves`: リーダーの `#…` のリンクと別ページのリンクを押すと、リーダーが閉じて元のページ（同じタブ）がそこへ移る。
  - `bfcacheCloses`: リーダーを開いたまま移動して履歴で戻ると（bfcache。`observed.bfcache.restoredFromCache`）、リーダーは閉じている。
  - `hfRendered` / `mdnRendered`（と `*Closed`）: 基準ページと MDN の `table` のページでも開いて描かれ（MDN は表あり）、閉じると 0。`observed.{react,hf,mdn}` に元のページの本文の範囲とリーダーの見出し・見出しのアンカー・表・画像・`pre` の数（記録値）。
  - `emptyNotOpened` / `emptyNoticeGoes`: 本文のないページ（既定は Google のロゴ画像の URL。`--empty=` で変えられる）では開かず、右上に「このページはリーダー表示にできません」の通知が出て、数秒後に目印 0。
- **証拠**: `reader.json`、`reader-react-{1-open,2-code,3-white-mincho,4-link}.png`、`reader-hf-{1-open,2-code}.png`、`reader-mdn-{1-open,2-table}.png`、`reader-empty-notice.png`。
- **注意**: 右クリックメニューを CDP から押す手段はない（手動の節）。ショートカットは CDP のキー入力で発火するが、物理キーではない。Readability の抽出結果はページの変更で変わる。リーダーの中の翻訳・吹き出しは #15。

## ツールバーのボタンの実クリック（手動）

- **到達方法**: ヘッドありの Chrome（一時プロファイル）で `dist/` を読み込み、基準ページでツールバーの拡張のボタン（パズルのアイコンから固定してもよい）を押す。
- **期待**: バッジが `ON` になり本文が日本語になる。もう一度押すと原文に戻り、バッジが消える。
- **証拠**: 確認した人・日時・結果を `run.md` に書く。CDP の `Extensions.triggerAction` は同じ `chrome.action.onClicked` を発火するが、画面上のクリックそのものではない。

## リーダー表示の右クリックメニューとショートカット（手動）

- **到達方法**: ヘッドありの Chrome（一時プロファイル）で `dist/` を読み込み、基準ページを開く。
- **期待**: ツールバーの拡張のボタンを右クリックすると「リーダー表示」が出て、選ぶとリーダーが開く。もう一度選ぶと閉じる。ページの右クリックでも同じ。Option+Shift+R（Mac）でも開閉できる。
- **証拠**: 確認した人・日時・結果を `run.md` に書く。

## 原文の吹き出しからのコピー（手動）

- **到達方法**: ヘッドありの Chrome（一時プロファイル）で `dist/` を読み込み、基準ページを置き換え表示で訳して、訳した段落にマウスを乗せる。
- **期待**: 吹き出しの文字をドラッグで選んで ⌘C でコピーでき、貼り付けると原文になる。吹き出しの外までドラッグして選択しても吹き出しが消えないことも見る（ヘッドありの Chrome、人が 1 回）。
- **証拠**: 確認した人・日時・結果を `run.md` に書く。

## 通信先（静的な確認）

- `src/manifest.json` の `host_permissions` が `http://localhost/*` と `http://127.0.0.1/*` だけ。
- `grep -n "fetch(" src/*.ts dist/*.js` が `background` の `/v1/models` と `/v1/completions`（設定の URL 経由）だけ。設定画面のモデル一覧も `chrome.runtime.sendMessage({ type: "models" })` で background が取る（`options.js` に `fetch(` がない）。
