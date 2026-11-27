# Browser Translator

英語の Web ページを、ローカルの llama-server で動かす PLaMo 3 Translate で日本語に置き換える Chrome 拡張（Manifest V3）。文中の `code`・リンク・強調を保ったまま訳す。通信先はローカルの llama-server だけ。

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

拡張は `http://127.0.0.1:8080` に接続し、`/v1/models` の先頭のモデルを使う。

## 拡張の読み込みと使い方

1. `pnpm run build` する。
2. `chrome://extensions` を開き、デベロッパーモードをオンにして「パッケージ化されていない拡張機能を読み込む」でリポジトリの `dist/` を選ぶ。
3. 英語のページでツールバーの拡張のボタンを押すと翻訳モードになる（バッジ `ON`）。マウスを乗せると原文が出る。もう一度押すと原文に戻る。
   - 訳せなかった段落は原文のまま `⚠` の目印が付く。
   - llama-server に接続できないときは、ページ右上の通知とバッジ `ERR` で示す。
   - ページの読み込み直しや移動で翻訳モードは終わる。

## 現在の制限

- 設定画面はまだない（URL は `http://127.0.0.1:8080` 固定、モデルは `/v1/models` の先頭）。
- 送り方は並列だけ（直列、用語集、対訳表示、あとから追加された段落の翻訳は未実装）。
- 中に段落やリストを持つリスト項目の直下の文字は訳さない。
- 原文に `<h1>` のようなタグそっくりの文字列がある段落は訳さず、原文のまま ⚠ の目印を付ける。
