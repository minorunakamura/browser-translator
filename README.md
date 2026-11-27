# Browser Translator

英語の Web ページを、ローカルの llama-server で動かす PLaMo 3 Translate で日本語に置き換える（または段落の下に訳文を差し込む）Chrome 拡張（Manifest V3）。文中の `code`・リンク・強調を保ったまま訳す。通信先はローカルの llama-server だけ。

設計: [docs/designs/browser-translator.md](docs/designs/browser-translator.md)

## 必要なもの

- Node.js 24 と pnpm（版は `package.json` の `packageManager` で固定）
- Google Chrome
- llama-server（llama.cpp）と PLaMo 3 Translate の GGUF

## セットアップ

```sh
pnpm install --frozen-lockfile
pnpm run build   # dist/ に拡張を出力する
```

## 正式チェック

`pnpm run check` で次を順に実行する（1 つでも失敗すれば失敗）。

| コマンド | 内容 |
| --- | --- |
| `pnpm run format:check` | biome で整形を確認（直すときは `pnpm run format`） |
| `pnpm run lint` | `oxlint --type-aware --deny-warnings`（警告も失敗） |
| `pnpm run typecheck` | `tsc --noEmit` |
| `pnpm run test` | `vitest run`（`test/*.test.ts`） |
| `pnpm run build` | `node scripts/build.ts`（Vite で `dist/` を作る） |

## llama-server の起動

モデルは https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF （2B・8B も同様）から Q4_K_M の GGUF を取得し、1 つのディレクトリに置く。

```text
~/models/plamo/
  plamo-3-translate-0.8b-Q4_K_M.gguf
  plamo-3-translate-2b-Q4_K_M.gguf
```

router モードで起動する（ファイル名から拡張子を除いたものがモデル名になる）。

```sh
llama-server --models-dir ~/models/plamo --host 127.0.0.1 --port 8080 --parallel 4
```

拡張は既定で `http://127.0.0.1:8080` に接続し、`/v1/models` の先頭のモデルを使う（設定画面で変えられる）。

## 拡張の読み込みと使い方

1. `pnpm run build` する。
2. `chrome://extensions` を開き、デベロッパーモードをオンにして「パッケージ化されていない拡張機能を読み込む」でリポジトリの `dist/` を選ぶ。
3. 英語のページでツールバーの拡張のボタンを押すと翻訳モードになる（バッジ `ON`）。置き換え表示ではマウスを乗せると原文が出る。対訳表示では各段落の下に訳文が出る。もう一度押すと原文に戻る。
   - 翻訳モードの間は、ページがあとから追加・変更した段落も訳す。
   - ページを読み込み直さない URL の変更（SPA のページ内の移動）では翻訳モードが続き、新しい内容も訳す。
   - 訳せなかった段落は原文のまま `⚠` の目印が付く。
   - llama-server に接続できないときは、ページ右上の通知とバッジ `ERR` で示す。
   - ページの読み込み直しや通常の移動で翻訳モードは終わる。

## 設定

ツールバーの拡張のアイコンを右クリックして「オプション」を選ぶと、`chrome://extensions` の上に設定画面がダイアログで開く（`chrome://extensions` の拡張の「詳細」→「拡張機能のオプション」からも開ける）。「保存」で保存する（`chrome.storage.local`）。URL・モデル・用語集は次に送る段落から、送り方と表示方法は次に翻訳モードをオンにしたときから使われる。

| 項目 | 内容 | 既定 |
| --- | --- | --- |
| llama-server の URL | 送信先。解析できる URL だけ保存でき、末尾の `/` は除く。拡張が接続できるのは `http://localhost` と `http://127.0.0.1` のみ（`host_permissions`）。URL を変えたら「モデルの一覧を取り直す」を押す | `http://127.0.0.1:8080` |
| モデル | その URL の `/v1/models` の一覧から選ぶ。「先頭のモデルを使う」は一覧の先頭 | 先頭のモデルを使う |
| 送り方 | 並列: 同時に 4 段落まで送り、ページの説明と前後の段落の原文を `context` に入れる。直列: 1 段落ずつ順に送り、直前に訳せた段落の原文と訳文を翻訳履歴として渡す（`context` はページの説明だけ） | 並列 |
| 表示方法 | 置き換え: 段落の中身を訳文に置き換え、マウスを乗せると原文を出す。対訳: 原文はそのままで、段落の下に訳文を差し込む。React などのページで置き換えが元に戻されたり崩れたりするときに使う | 置き換え |
| 用語集 | 1 行に 1 語「原語 = 訳語」（最初の `=` で分ける。空行や片方が空の行は無視）。段落にその語があるときだけ PLaMo の `glossary` として送る。大文字小文字は区別せず、語の区切りで照合する（`pi` は `API` に当たらない）。複数形などの語形の違いは扱わない | 空 |

用語集は意味を区別せずに当てはめられるため、ページ内で意味が 1 つに決まる語にだけ使う。

## 現在の制限

- React のページ: react.dev/learn（2026-11-27、Chrome 158）では、置き換え・対訳とも表示の崩れも原文への戻しも見られなかった。崩れるページでは設定の表示方法を対訳にする。
- ページが訳文をさらに書き換えた段落は、その内容を新しい原文として訳し直す。オフにしたとき、ページが書き換えた段落はページの内容のまま残す。
- 用語集は語形の違い（複数形など）を扱わない。
- 中に段落やリストを持つリスト項目の直下の文字は訳さない。
- 文中に、名前に大文字や `_`・`.` を含む要素（SVG の `clipPath` など）がある段落は訳さず、原文のまま ⚠ の目印を付ける。
