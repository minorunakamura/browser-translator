# Feature Map（browser-translator）

初期対象: 基準ページでの置き換え翻訳（オン・オフ・ホバー）と、llama-server に接続できないときの表示。
対象外（まだ手順がない）: React のページでの置き換え・対訳表示と SPA での継続（Work Item 3）、設定画面、直列モード、用語集、対訳表示、MutationObserver。訳文の品質の定量評価、Chrome 以外のブラウザ。

この Map は手順と期待結果だけを持つ。各回の観測結果は `.pi/verification-evidence/<run>/run.md` に書く。

## 置き換え翻訳（基準ページ）

- **到達方法**: 一時プロファイルの Chrome に `dist/` を読み込み、https://huggingface.co/blog/ibm-research/an-indic-voice-agent-with-cuga を開いて、ツールバーのボタン（`chrome.action.onClicked`）を押す。もう一度押すとオフ。
- **前提**: 127.0.0.1:8080 で自分が起動した llama-server（router モード）が使用可能（[SKILL.md](../SKILL.md) の手順 1〜3）。
- **操作**: `node scripts/verify-translate.ts translate <evidenceDir>`（ボタンは CDP の `Extensions.triggerAction` で押す）。
- **期待と観測**（`translate.json` の `checks` と `observed`）:
  - `badgeOn`: オンでバッジが `ON`。
  - `articleJapanese`: `.blog-content` の本文の段落（`p`・`li`・見出し。中に段落を持つ `li` を除く）が、訳されたか目印付き（`.blog-content` の外の目印は数えない）で、訳された段落はすべて日本語を含む。
  - `preUnchanged`: `pre` の中身が翻訳前と同じで、日本語も拡張の目印もない。
  - `knowledgeEngine` / `guardrails`: 「The knowledge engine.」「Keep guardrails cheap.」の段落で `code` が `agent.knowledge.search()` / `OFF_TOPIC` のまま 1 つ残り、`strong` が 1 つ残る。自然な位置かは `observed.*.html` とスクリーンショットで目で確かめる。
  - `cugaLink`: 「CUGA (ConfigUrable …」の段落に `href="https://cuga.dev"` の `a`（中身 CUGA）が残る。
  - `noLeftoverTags`: 訳された段落に `<a1>` などのタグ文字列が残っていない（タグの抜け・重複がある訳は採用されないため、目印のない段落は抜け・重複がない）。`observed.failed` に訳せなかった段落（原文のまま ⚠ の目印）があれば一覧される。
  - `hoverShowsOriginal`: 訳した段落の `title` が原文（マウスを乗せるとツールチップで原文が出る）。
  - `offRestoresDom` / `offBadgeCleared`: オフ後、対象の全段落と `pre` の `textContent` と `outerHTML`（要素自身の `title` 属性を含む）が翻訳前と一致し、拡張の目印（`data-browser-translator`）が 0、バッジが空。
- **証拠**: `translate.json`、`translate-0-before.png`、`translate-1-top.png`、`translate-2-{cuga,knowledge,guardrails}.png`、`translate-3-off.png`。
- **注意**: 訳文はモデルの出力なので、run ごとに文言は変わる。中に段落を持つ `li`（目次など）の直下の文字は訳さない（content.ts の shortcut）。ホバーはブラウザのツールチップのため、スクリーンショットには写らない（`title` 属性で確認する）。

## 接続エラー

- **到達方法**: 127.0.0.1:8080 に何も listen していない状態で、基準ページでボタンを押す。
- **前提**: 自分の llama-server を PID で止め、`lsof -iTCP:8080 -sTCP:LISTEN` が空。利用者のサーバーが 8080 にいる場合はこの確認をしない。
- **操作**: `node scripts/verify-translate.ts unreachable <evidenceDir>`。
- **期待と観測**（`unreachable.json`）: `noticeShown`（ページ右上に「llama-server に接続できません」の通知）、`badgeError`（バッジが `ERR`）。
- **証拠**: `unreachable.json`、`unreachable-0-before.png`、`unreachable-1-on.png`。

## ツールバーのボタンの実クリック（手動）

- **到達方法**: ヘッドありの Chrome（一時プロファイル）で `dist/` を読み込み、基準ページでツールバーの拡張のボタン（パズルのアイコンから固定してもよい）を押す。
- **期待**: バッジが `ON` になり本文が日本語になる。もう一度押すと原文に戻り、バッジが消える。
- **証拠**: 確認した人・日時・結果を `run.md` に書く。CDP の `Extensions.triggerAction` は同じ `chrome.action.onClicked` を発火するが、画面上のクリックそのものではない。

## 通信先（静的な確認）

- `src/manifest.json` の `host_permissions` が `http://localhost/*` と `http://127.0.0.1/*` だけ。
- `grep -n "fetch(" src/*.ts dist/*.js` が `background` の `/v1/models` と `/v1/completions`（`DEFAULT_BASE_URL` 経由）だけ。
