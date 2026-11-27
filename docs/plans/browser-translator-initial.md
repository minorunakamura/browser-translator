# ブラウザ翻訳拡張（ローカル LLM）初回実装

> 改訂（2026-11-27）: Work Item #1 の Implementation からの REPLAN_REQUIRED による再計画。言語を TypeScript に変え、ビルド（Vite）と開発ツール（biome の formatter、oxlint、vitest）を入れる。変更前の「ビルドなし・素の JavaScript・`node --test`」の方針は、この改訂で置き換えられ、採用しない。変更箇所は「改訂で決めた事項」と、各節の **（改訂）** の印を参照。設計書の振る舞いと通信先は変わらない。

## 目的

基本設計 [docs/designs/browser-translator.md](../designs/browser-translator.md)（以下「設計書」）の目的・範囲・決定事項・対象外を維持し、Chromium 系ブラウザ用の Manifest V3 拡張を初めて実装する。
Chrome 翻訳で崩れていた文中の `code`・リンク・強調を、日本語として自然な位置に保った訳文にする。翻訳には、利用者が常駐させた llama-server（router モード）上の PLaMo 3 Translate を使う。

## 要件・決定事項

### 設計書から引き継ぐもの（変更なし）
設計書の「主要な振る舞い」と「決定と理由」をすべて初回の範囲に含める。仕様の正本は設計書とする。主な項目は次のとおり。
- ツールバーのボタンで、タブごとに翻訳モードを切り替える。オフにすると原文に戻す。
- 見えている段落を先に訳す（`IntersectionObserver`）。追加・変更された段落も訳す（`MutationObserver`）。拡張が差し込んだ要素には目印を付け、監視の対象から外す。
- `p`、`li`、見出しなどを対象にする。`pre` やコードブロックは送らない。文中の要素は番号付きタグに置き換える。タグが合わなければ 1 回だけ訳し直し、それでも合わなければ原文のまま残して目印を付ける。
- 1 段落を 1 リクエストにし、PFML3 で `/v1/completions` に送る。既定は並列で、前後の段落の原文とページの説明を `context` に入れる。直列も選べ、その場合は直前の段落の原文と訳文を翻訳履歴として渡す。`form=polite` を指定する。
- ページの説明は `<title>` と `meta description` から作る。
- 用語集（PLaMo の `glossary`）は設定画面で編集する。既定は空。段落に含まれる語だけを、語の区切りで照合して送る。
- 表示は置き換えが既定で、マウスを乗せると原文を見られる。対訳表示（段落の下に訳文を差し込む）も選べる。
- 設定項目: URL、モデル（`/v1/models` から選ぶ）、送り方、表示方法、用語集。
- 保存するキャッシュは持たない。原文と訳文は、翻訳モードの間だけタブのメモリに持つ。llama-server につながらないときは、その旨を表示する。

### Planning で確定した事項（ユーザー回答）
- **範囲**: 設計書の全機能を初回に入れる。ただし最初の Work Item で「service worker から localhost の llama-server を呼べるか」を確かめ、通らなければ後続を止めて相談する。
- **ページ遷移**: 翻訳モードを続けるのは、SPA の URL 変更（ページを読み込み直さないもの）だけとする。通常のページ遷移やリロードでは翻訳モードを終える。タブの状態は保存しない。
- **リーディングモードのような表示（Plan Review で出た提案）**: 初回には入れず、後の計画に回す。初回は設計書どおり置き換えと対訳の 2 つだけを作る。React のページでの確認結果（完了条件 6）を、入れるかどうかの判断材料にする。
  - 参考（Planning での調査）: Chrome 標準のリーディングモードの中身を拡張から書き換える API はない。実現するなら、拡張が自前の画面に訳文を並べる形になる。ページの DOM を書き換えないので崩れのリスクを避けられる一方、本文の取り出し方法（Readability の同梱か、`article` / `main` だけか）と、画像・表・コードブロックの扱いを決める必要がある。

### 改訂で決めた事項（ユーザーの要望と回答、2026-11-27）
- **言語**: TypeScript。拡張のコード（`src/`）、検証用の helper（`scripts/`）、テスト（`test/`）のすべてを TS にする。
- **ビルド**: Vite（ユーザーの指定）。`src/*.ts` を `dist/` に出力し、`dist/` をパッケージ化されていない拡張として読み込む。型チェックは `tsc --noEmit` で別に行う（Vite は型を検査しないため）。
- **開発ツール**: formatter は biome（formatter だけ。biome の linter と assist は無効にする）、linter は oxlint、テストは vitest（`node --test` を置き換える）。
- **dist/ の構成**: `src/manifest.json` と `src/options.html` をビルドで `dist/` 直下へコピーする。`dist/` は平らな構成（`manifest.json`、`background.js`、`content.js`、`options.html`、`options.js`）。`dist/` と `node_modules/` は `.gitignore` に入れる（既存の `.pi/verification-evidence/` の除外は残す）。
- **Work Item #1**: 新しい Work Item は作らず、#1 の内容を「TS 化とツールチェーンの導入、dist/ からの接続の再確認」に改める。JS で行った接続の確認は、TS 化した後の確認として流用しない。
- **scripts/**: TS にし、Node.js 24 の型の除去（`node scripts/xxx.ts`）でそのまま実行する。tsx などの実行用の依存は入れない。
- **パッケージマネージャ**（Plan Review での要望）: pnpm。npm・yarn は使わない。`package.json` の `packageManager`（と、pnpm が書き込む `devEngines.packageManager`）で版を固定する。Planning の Probe では、手元の pnpm 12.10.1 が `packageManager` に従って pnpm 12.23.0 を取得して使った。lockfile は `pnpm-lock.yaml`。pnpm が作る `pnpm-workspace.yaml`（公開直後の版を除外する `minimumReleaseAgeExclude` などの設定）もコミットする。
- **正式チェック**: `package.json` の scripts で定義し、`pnpm run <名前>` で実行する。
  - `format`: `biome format --write .`
  - `format:check`: `biome format .`
  - `lint`: `oxlint --type-aware --deny-warnings`（警告だけでは exit 0 になるため `--deny-warnings` を付ける）
  - `typecheck`: `tsc --noEmit`
  - `test`: `vitest run`
  - `build`: `node scripts/build.ts`
  - `check`: `format:check` → `lint` → `typecheck` → `test` → `build` を順に実行し、1 つでも失敗すれば失敗する
- **lint の定義**（Plan Review での要望「lint の警告は潰す」と回答）:
  - `.oxlintrc.json` を必ず作ってコミットし、定義を明示する。
    - plugins: `eslint`、`typescript`、`unicorn`、`oxc`、`vitest`
    - categories: `correctness: "error"`、`suspicious: "error"`。`pedantic`、`style`、`perf`、`restriction`、`nursery` は入れない。
  - 型情報を使う規則（`--type-aware`）を有効にする。そのため `oxlint-tsgolint` を devDependencies に入れる。Planning の Probe で、`oxlint-tsgolint` 7.0.2009 と typescript 7.0.2 で動き、`await` し忘れた Promise（`no-floating-promises`）を検出することを確認した（`tsc` と通常の oxlint では検出されない）。
  - 警告・エラーはコードを直して解消する。`oxlint-disable` コメントや設定での規則の無効化で黙らせない。誤検出でどうしても必要な場合だけ、その 1 行に理由をコメントして無効化し、Implementation の報告に挙げる。
  - `pnpm run check` が通ることは、lint の警告もエラーも 0 件であることを意味する。
  - `oxlint-tsgolint` が版の不整合などで動かない場合は、独自に回避せず報告する。
- **依存の固定**: devDependencies に厳密なバージョン（`^` なし。`pnpm add -D --save-exact`）で書き、`pnpm-lock.yaml` をコミットする。セットアップは `pnpm install --frozen-lockfile`。

### Root が決めた実装上の既定値（設計書の範囲内）
- 権限: `activeTab`、`scripting`、`storage`、`host_permissions` は `http://localhost/*` と `http://127.0.0.1/*`。全サイトへのアクセス権限は求めない。
- 既定の URL は `http://127.0.0.1:8080`（llama-server の既定のポート）。
- モデルが未選択の場合は、`/v1/models` の先頭のモデルを使う。
- 並列のときに同時に送る数は、定数 4 で始める（最適値の計測は後に回す）。
- 置き換えるタグ: `a`→`a`、`code`→`c`、`strong`/`b`→`b`、`em`/`i`→`i`。入れ子にも対応する。それ以外の要素も番号付きタグ（`x`）として包み、要素を残す。タグが合わなければ、既存の訳し直し・原文に戻す処理で扱う。
- 用語集の照合は、大文字小文字を区別せず、語の区切りで行う。語形の違い（複数形など）は扱わない。

## 制約・対象外

- 設計書の「扱わない」をそのまま守る（クラウド API、汎用ローカル LLM、ローカルファイルと PDF、拡張からの llama-server の起動・管理）。
- 拡張は llama-server 以外へ通信しない。ページの内容を外部に送らない。
- **（改訂）** 依存は devDependencies の次だけにする: `typescript`、`vite`、`vitest`、`@biomejs/biome`、`oxlint`、`oxlint-tsgolint`、`@types/chrome`、`@types/node`。実行時の依存（拡張に同梱するライブラリ）は入れない。これ以外を入れる場合は、事前にユーザーに確認する。
  - Planning の Probe（2026-11-27、一時ディレクトリ）で確認した版: typescript 7.0.2、vite 8.4.0、vitest 5.1、@biomejs/biome 2.6.9、oxlint 1.95.0、oxlint-tsgolint 7.0.2009。Node.js 24.22 / pnpm 12.23.0。Probe で、pnpm で install し、biome・oxlint（`--type-aware`）・tsc・vitest・Vite のビルドがすべて成功することを確認した。Implementation の時点で同じ版か、その時点の安定版を厳密に固定する。
- **（改訂）** 拡張が実行時に外部からコードを読み込まない（CDN、リモートのスクリプトなし）。ビルドの結果はすべて `dist/` の中で完結する。
- 動作確認するブラウザは Google Chrome 158（macOS）。Arc など他の Chromium 系ブラウザでの確認は対象外。
- ストア公開、パッケージ化、署名は対象外。
- 拡張を読み込む方法は、パッケージ化されていない拡張としての読み込み（chrome://extensions の「パッケージ化されていない拡張機能を読み込む」）。

### 設計書の「未確認・リスク」の扱い

| 項目 | 初回の扱い |
| --- | --- |
| service worker から localhost を呼べるか | **初回の最初に確かめる**（Work Item 1） |
| React などのページで置き換えが崩れる | **初回で確かめる**。React のページで置き換えと対訳を試す（動作確認方法を参照） |
| 文中の要素が保たれるか（設計書の目的） | **初回で確かめる**。基準ページで確認する |
| 「並列 + 前後の原文」と直列の訳語統一の差 | 後に回す。初回は両方式が動くことだけ確かめる |
| 1〜2 語の見出しやメニューの訳 | 後に回す。初回は `context` に前後の原文を入れる実装だけ行う |
| 自動で作ったページの説明の効き目 | 後に回す。初回は基準ページで LLM・pi を誤訳していないかを目視で見るだけ（効果の比較はしない） |
| 用語集の語形の違いと「訳さない指定」 | 後に回す。初回は語の区切りで照合する実装と、`pi` が `api` に当たらないことだけ確かめる |
| メモリ使用量、同時に送る数の最適値 | 後に回す。初回は同時に送る数を 4 で固定する |

| リーディングモードのような表示（設計書にない新しい表示方法） | 後に回す。設計書への追加を含めて、別の計画で扱う |

後に回した項目は、初回のあとの別の計画で扱う。

## 実装方針

### 構成（新規ファイル）**（改訂）**
```
package.json / pnpm-lock.yaml / pnpm-workspace.yaml   devDependencies と scripts（pnpm）
tsconfig.json         型チェック用（noEmit。src・scripts・test を対象）
biome.json            formatter だけ有効（linter・assist は無効。.gitignore を使って dist/ と node_modules/ を除外）
.oxlintrc.json        lint の定義（plugins・categories。「lint の定義」を参照）
src/manifest.json     ビルドで dist/ へコピー
src/background.ts     service worker: 翻訳モードの切り替え、PFML3 組み立て、送信（並列/直列）、/v1/models
src/content.ts        content script: 段落の抽出、表示、Observer、目印
src/text.ts           純粋なロジック（タグの置き換え・検証・復元、PFML3 プロンプト、用語集の照合、context）
src/options.html / options.ts   設定画面（URL、モデル、送り方、表示方法、用語集）
scripts/build.ts      Vite の JS API でビルドし、静的ファイルを dist/ へコピー
scripts/cdp.ts ほか   検証用の CDP helper（Node 24 で直接実行）
test/*.test.ts        vitest
dist/                 ビルドの出力（コミットしない）。これを Chrome に読み込む
README.md
```
- `src/text.ts` は DOM と chrome API に依存しない。`background.ts`、`content.ts`、`options.ts` とテストが ES modules の `import` で使う。
- ビルド: Vite のライブラリモードで、エントリ（`background`、`content`、`options`）ごとに `iife` 形式の 1 ファイルへまとめる。content script は `executeScript` でクラシックスクリプトとして注入するため、出力に `import` を残さない。Planning の Probe で、Vite 8.4 で 3 つのエントリを iife で出力し、`import` が残らないことを確認した（拡張としての読み込みは未確認）。具体的な設定は実装時に決める。
- 検証で service worker の関数を CDP から呼ぶ場合、バンドルすると関数がグローバルに出ないため、必要な関数を `globalThis` に明示的に公開してよい（外部への通信先は増やさない）。
- ツールバーのボタン（`chrome.action.onClicked`）で `chrome.scripting.executeScript` を使って注入する。もう一度押すとオフにして原文に戻す。ボタンのバッジで状態を示す。
- content script は段落ごとにメッセージで service worker に訳を頼む。service worker が `fetch` で llama-server に送る。
- 停止条件（タグが合わない、接続できない）の表示は、ページ上の小さな目印と、ツールバーのバッジまたはページ上の通知で示す。具体的な見た目は実装時に決める。

### Work Item の順序（分割の目安）
1. **（改訂）ツールチェーンの導入と接続の確認（最初）**: package.json、tsconfig、biome、oxlint、vitest、Vite のビルドを入れ、正式チェック（`pnpm run check`）が通る状態にする。既存の JS の実装（`manifest.json`、`src/background.js`、`scripts/cdp.mjs`、`scripts/verify-connection.mjs`）を TS と `src/manifest.json` に置き換える。そのうえで、`dist/` を読み込んだ拡張の最小の service worker で、`/v1/models` の取得と `/v1/completions` への PFML3 送信を、実際の Chrome で確かめる。通らない場合は理由（CORS、host_permissions、Private Network Access など）を記録し、**後続を止めて相談する**（設計の前提が崩れるため）。
2. **翻訳の中核**: `text.ts`（タグ・検証・PFML3・context）、抽出、並列送信、置き換え表示と原文のホバー表示、訳し直しと原文に戻す処理、オフで原文に戻す処理、接続エラーの表示。基準ページで確認する。
3. **追加の振る舞い**: `MutationObserver`、SPA での継続、対訳表示、直列モード、用語集、設定画面。React のページで確認する。
4. **文書と検証 Skill**: README と、検証 Skill（後述）。2・3 の確認に検証 Skill を使う場合は、2 の時点で作り始めてよい。

### 文書
- `README.md`（新規）: 概要、必要なもの（Node.js 24 と pnpm を含む）、**（改訂）** セットアップ（`pnpm install --frozen-lockfile`、`pnpm run build`、`dist/` を読み込む）と正式チェック（`pnpm run check` と各コマンド）、llama-server の router モードでの起動例（`--models-dir`、`--parallel`、モデルファイルの置き方と名前、モデルの入手先）、拡張の読み込み方、設定、既知の制限、設計書へのリンク。
- 設計書 `docs/designs/browser-translator.md`: 変更しない。**（改訂）** 再計画で確認した結果、設計書には言語・ビルド・テストの記述がなく、振る舞いと通信先も変わらないため、今回の改訂でも更新は不要。Work Item 1 で前提が崩れた場合だけ、相談のうえ更新する。
- 検証 Skill `.pi/skills/verify-project/`（新規、後述）。
- CONTRIBUTING は作らない。セットアップと正式チェックは README に短く書く。

## 完了条件

1. Work Item 1: **（改訂）** `pnpm run build` で作った `dist/` を Chrome に読み込んだ拡張の service worker から、`http://127.0.0.1:<port>` の llama-server（router モード）に対して `/v1/models` と `/v1/completions` が成功し、PFML3 の訳文が返る。
2. **（改訂）** `pnpm run check`（format:check、lint、typecheck、test、build）がすべて成功する。lint の警告・エラーは 0 件で、規則を無効化して黙らせていない（理由付きの 1 行の例外があれば報告されている）。
3. 基準ページ https://huggingface.co/blog/ibm-research/an-indic-voice-agent-with-cuga で、翻訳モードをオンにすると次の状態になる。
   - 本文の段落が日本語になる。`pre` やコードブロックは原文のまま。
   - 「The knowledge engine.」と「Keep guardrails cheap.」の段落で、`code`（`agent.knowledge.search()`、`OFF_TOPIC`）が中身を変えずに残り、`strong` が残り、文の自然な位置に置かれる。
   - リンクを含む段落（例: 「CUGA (ConfigUrable …」）で、リンクの `href` と要素が残る。
   - 訳せなかった段落があれば、原文のまま目印が付いている。目印のない段落でタグの抜けや重複がない。
   - マウスを乗せると原文が見られる。オフにすると、ページが翻訳前と同じ DOM の文章に戻る。
4. 対訳表示、直列モード、用語集（`pi` が `api` に当たらない）、モデルの選択、URL の変更が設定画面から使え、翻訳に反映される。
5. llama-server を止めた状態で翻訳モードをオンにすると、接続できないことが表示される。
6. React のページで、置き換えと対訳表示を試した結果（崩れの有無、元に戻されたかどうか）が記録されている。崩れた場合も対訳表示で読めること。崩れ自体を初回で直すことは完了条件にしない（設計書が対訳表示を逃げ道としているため）。
7. 拡張が llama-server 以外へ通信していない（manifest の `host_permissions` と、コード上の `fetch` 先で確認）。
8. README と検証 Skill が揃っている。

## 動作確認方法

### 保証する対象と対象外
- 保証する: 上記の完了条件。特に、タグの置き換えと復元、タグの検証、PFML3 の形式、用語集の語の区切り、実際の Chrome での接続と表示。
- 対象外: 訳文の品質の定量評価、方式ごとの訳語統一の比較、性能の最適値、全サイトでの表示、Chrome 以外のブラウザ。

### 自動テスト（vitest）**（改訂）**
- 対象: `src/text.ts` の純粋な関数。テストは `test/*.test.ts` に置き、`pnpm test`（`vitest run`）で動かす。
  - タグの置き換え: 入れ子、同じ種類の複数の要素、未知の要素（`x`）、空の要素。
  - タグの検証: 数・種類・番号の一致、抜け・重複・未知の番号の検出。
  - 復元: 訳文の中のタグの順序が原文と違っていても、元の要素（属性を含む）に戻る。
  - PFML3 の組み立て: 並列（`context`）、直列（翻訳履歴）、`glossary`、`form=polite`、停止トークン。PFML3 の形式は設計時の実験スクリプト（`/tmp/kba-scripts/plamo_par.py`、`gloss.py`。消えている可能性がある）と、PLaMo の公式モデルカード（設計書の参考を参照）に合わせる。
  - 用語集の照合: `pi` が `api` に当たらない、大文字小文字を区別しない。
- DOM の抽出・表示はテストのために jsdom などを入れず、実際の Chrome で確認する（vitest の環境は node のまま）。
- ツールチェーン自体（設定ファイル、ビルド）のための専用テストは書かない。`pnpm run check` が通ること、`dist/` に必要なファイルがそろい `import` が残っていないこと、`dist/` を Chrome に読み込めることで確認する。

### TDD
- 採用する: `src/text.ts` のタグの置き換え・検証・復元。入出力が明確で、目的の中心であり、test-first の利点が大きい。公開インターフェースは、例えば「DOM ノードの代わりに、要素の種類と子を表す単純な構造を受け取り、タグ付き文字列と対応表を返す関数」と「訳文と対応表を受け取り、検証結果と復元用の構造を返す関数」。具体的な形は実装時に決める。`tdd` Skill を使う。
- 採用しない: PFML3 の組み立て・用語集の照合（テストは書くが、実装と同時でよい）、ツールチェーンの導入、service worker、content script、設定画面（実際の Chrome で確認する）。

### 実際の Chrome での確認
- 環境: Chrome 158、llama-server 1.0.0 の router モード。検証用の llama-server と Chrome は、所有するポートと一時プロファイル（`--user-data-dir` に一時ディレクトリ）で分離し、利用者の普段のプロファイルや常駐している llama-server を使わない・止めない。
- 拡張の読み込み: **（改訂）** 読み込むのは `pnpm run build` で作った `dist/`（リポジトリのルートではない）。検証の前に必ずビルドし直す。ブランド版 Chrome は `--load-extension` を受け付けない。Planning の Probe で、`--remote-debugging-pipe --enable-unsafe-extension-debugging` を付けて起動し、CDP の `Extensions.loadUnpacked` で読み込めることを確認した（読み込みのみ。翻訳の動作は未確認）。Node.js の標準機能だけで CDP を操作できる（helper は TS で書き、Node 24 で直接実行する）。
- モデル: `/tmp/kba-dl/`（または `/tmp/kba-router/`）に GGUF があればそれを使う。確認は 0.8B を中心にし、品質の目視は 2B または 8B でもよい。ファイルが消えていた場合は、Hugging Face から取得してよいか（数 GB の通信）をユーザーに確認してから取得する。
- 操作と観測: CDP で基準ページを開き、翻訳モードをオンにして、DOM を取得し、完了条件 3 を照合する。スクリーンショットを証拠として残す。ツールバーのボタンを押す操作は CDP で直接再現できない可能性がある。その場合は、service worker と同じ切り替え処理を CDP から呼んで自動確認し、**実際のボタンのクリックは、ヘッドあり（画面あり）の Chrome で少なくとも 1 回直接確認する**。直接の確認が Agent だけで難しい場合は、ユーザーに手順を示して確認を依頼する。
- React のページ: 例として https://react.dev/learn （React で作られた文書サイト）。置き換えと対訳表示を試し、ページ内の移動（SPA の URL 変更）で翻訳モードが続くこと、崩れの有無を記録する。同じ目的を満たす別の React のページに変えてもよい。
- 後始末: 自分が起動した Chrome と llama-server を止め、一時プロファイルと一時ファイルを消す。利用者のファイル・プロセスには触れない。

### 検証資産
- 現状: このプロジェクトに既存の検証 Skill はない。**（改訂）** Work Item 1 の JS 版の helper（`scripts/cdp.mjs`、`scripts/verify-connection.mjs`。未コミットで Stage 済み）があり、読み込み・SW の観測・後始末の方法は再利用できる。ただし読み込むパスがルートで、JS のままのため、Work Item 1 で TS に置き換え、`dist/` を読み込むように直す。JS の helper での成功を、TS 化後の確認として流用しない。別の Agent が会話履歴なしで、拡張の読み込みから基準ページでの照合と後始末までを行う手段がないため、補う必要がある。
- 作成: 共通 `create-verification-skill`（`/Users/minoru/Documents/mywork/pi-dev/pi-skills/skills/create-verification-skill/SKILL.md`）で `.pi/skills/verify-project/` を作る。初期対象は「llama-server（router モード）の起動 → 拡張の読み込み → 基準ページでの翻訳と完了条件 3 の照合 → 後始末」と「React のページでの置き換え・対訳表示」。CDP を操作する小さな TS の helper を `scripts/` に置いてよい（上に挙げた devDependencies 以外の依存は追加しない）。
- 分担: Worker は Skill と helper を作り、実際に動かして証拠を残す。Root は、完了条件の受け入れを自分で判断し、少なくとも基準ページの結果とスクリーンショットを直接確かめる。Skill の実行が成功したことを、Root の受け入れの代わりにしない。
- Implementation の裁量: Implementation の Root は、現在の手段を確かめ直したうえで、承認済みの保証対象・対象外・期待結果を変えずに、操作・観測の方法を具体化してよい。必要な最小の helper の作成・保存・再利用、検証 Skill の作成・更新も含む。**（改訂）** 制約に挙げた devDependencies の install はこの Plan で承認済み。それ以外の追加の install（パッケージ、Playwright など）、利用者のプロファイルや常駐プロセスの変更、モデルの取得（大きな通信）は、事前にユーザーに確認する。安全に分離できない、権限が足りないなど、許可された範囲で検証が成り立たない場合は、試した方法と不足、再開の条件を示して BLOCKED とする。期待結果を緩めたり、成り立たなかった手順を成功として扱ったりしない。
- 保証・期待結果・設計書の公開された振る舞いを変える必要が出た場合は、REPLAN_REQUIRED として Planning に戻す。

### 既存の未コミットの変更の扱い **（改訂）**
- Work Item 1 の JS の実装（`.gitignore`、`manifest.json`、`src/background.js`、`scripts/cdp.mjs`、`scripts/verify-connection.mjs`）は未コミットで Stage 済み。Planning では変更・破棄しない。Implementation の Work Item 1 で、内容を引き継いで TS に置き換える（置き換えは Work Item 1 の作業そのもの）。
- `.pi/verification-evidence/` の既存の証拠は JS 版の記録として残し、TS 化後の確認の証拠にしない。
