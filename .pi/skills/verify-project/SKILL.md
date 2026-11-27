---
name: verify-project
description: browser-translator（Chrome MV3 拡張 + ローカル llama-server）の実動作確認。dist/ を一時プロファイルの Chrome に読み込み、所有するポートの llama-server（router モード）で基準ページを翻訳し、DOM の照合とスクリーンショットを残して後始末する。拡張の翻訳・表示・接続エラーを変更したときに使う。
---

# verify-project（browser-translator）

拡張を実際の Chrome に読み込み、利用者の入口（ツールバーのボタン）から翻訳モードを操作して、ページの DOM を照合する。
対象機能は [Feature Map](references/feature-map.md) から、今回の変更に関係するものだけを選ぶ。Map にない機能や実行しなかった手順を検証済みとしない。
この Skill は `pnpm run check`（自動テスト）や Root の受け入れ判断の代わりにはならない。

## 前提

- cwd はリポジトリのルート。Node.js 24、pnpm、`pnpm install --frozen-lockfile` 済み。
- Google Chrome（`/Applications/Google Chrome.app`、確認済みは 158）。ブランド版は `--load-extension` を受け付けないため、`scripts/cdp.ts` が `--remote-debugging-pipe --enable-unsafe-extension-debugging` で起動し、CDP の `Extensions.loadUnpacked` で `dist/` を読み込む。プロファイルは毎回新しい一時ディレクトリ（終了時に削除）。
- llama-server 1.0.0 以降（`llama-server --version`）と PLaMo 3 Translate の GGUF を 1 つのディレクトリに置いたもの（例: `plamo-3-translate-0.8b-Q4_K_M.gguf`）。無ければ取得してよいか利用者に確認する（数百 MB〜数 GB）。
- 外部サイト（基準ページ）にアクセスできること。

## ポートの決め方（重要）

設定画面がまだ無いため、拡張は `http://127.0.0.1:8080` だけに接続する。

1. `lsof -iTCP:8080 -sTCP:LISTEN` で 8080 が空いていることを確かめる。
2. 空いていれば、検証用の llama-server を 8080 で自分で起動する（下記）。
3. 使われていれば（利用者が常駐させた llama-server など）、**止めたり使ったりしない**。翻訳の検証は行わず、未確認として報告する。8080 の常駐サーバーを使ってよいかは利用者に確認する。

## 手順

証拠のディレクトリを run ごとに決める: `EVID=.pi/verification-evidence/<run名>-$(date +%Y%m%dT%H%M%S)`（Git 管理外）。続けて `mkdir -p "$EVID"`（手順 1 と 3 がこの中に書き込む）。

1. 版を記録する: `git rev-parse HEAD > $EVID/source.txt; git status --short >> $EVID/source.txt`。
2. ビルドする: `pnpm run build`（検証の前に必ず。読み込むのは `dist/`）。
3. llama-server を router モードで起動し、PID を控える:
   ```sh
   llama-server --models-dir <GGUF のディレクトリ> --host 127.0.0.1 --port 8080 --parallel 4 > $EVID/llama-server.log 2>&1 &
   echo $! > $EVID/llama-server.pid
   ```
   使用可能になるまで待ち、`curl -s http://127.0.0.1:8080/v1/models` に目的のモデル（先頭が 0.8B）が並ぶことを確かめる。拡張は `/v1/models` の先頭のモデルを使う。
4. 翻訳の照合（Feature Map「置き換え翻訳」）:
   `node scripts/verify-translate.ts translate $EVID`
   exit 0 で、`$EVID/translate.json` の `checks` がすべて true。スクリーンショット（`translate-*.png`）を開いて、日本語の本文・`code`・リンクの見た目を目で確かめる。
5. 接続エラーの表示（Feature Map「接続エラー」）: 自分の llama-server を PID で止め（`kill $(cat $EVID/llama-server.pid)`）、`lsof -iTCP:8080 -sTCP:LISTEN` が空になったのを確かめてから:
   `node scripts/verify-translate.ts unreachable $EVID`
   exit 0 で、`unreachable.json` の `checks` がすべて true。`unreachable-1-on.png` に赤い通知が写っている。
6. 実行記録 `$EVID/run.md` を書く: 対象機能と入口、source の版と未コミット変更、前提（Chrome・llama-server の版、モデル）、操作、期待結果と観測結果、成否、未確認の範囲。
7. 後始末: 自分が起動した llama-server だけを PID で止める（プロセス名で一括終了しない）。Chrome と一時プロファイルは helper が終了時に閉じて消す（`ls -d ${TMPDIR:-/tmp}/bt-chrome-*` で残りが無いか確かめる）。証拠は消さない。後始末の後に `$EVID` の JSON と PNG が読めることを確かめる。

失敗したら、llama-server が使用可能か（`/v1/models`）と `dist/` が最新かを確かめ直してから再実行する。helper の不具合は helper を直して再実行する。製品の不具合を期待値の緩和で隠さない。

## helper

- `scripts/cdp.ts`: Chrome の起動（一時プロファイル）、拡張の読み込み、service worker への attach、`Runtime.evaluate`。
- `scripts/verify-translate.ts <translate|unreachable> <evidenceDir> [pageUrl]`: 新しいタブで基準ページを開き、CDP の `Extensions.triggerAction`（ツールバーのボタンを押したときと同じく `chrome.action.onClicked` が発火する）で翻訳モードを切り替え、DOM を照合して JSON とスクリーンショットを保存する。
- `scripts/verify-connection.ts`: Work Item 1 の接続確認（service worker から `/v1/models` と `/v1/completions`）。

`Extensions.triggerAction` は CDP からの発火で、画面上のボタンを物理的に押すわけではない。実際のボタンのクリックは、ヘッドありの Chrome で人が少なくとも 1 回確かめる（Feature Map の注意を参照）。

## 証拠と安全性

- 保存先は `.pi/verification-evidence/<run>/`（`.gitignore` 済み）。run ごとに新しいディレクトリを使い、古い成功を流用しない。
- 保存するのは JSON の照合結果、スクリーンショット、必要な最小限のログだけ。秘密値や個人情報は保存しない。基準ページは公開記事。
- 利用者の普段の Chrome プロファイルや常駐の llama-server を使わない・止めない。後始末は自分が起動した PID と自分が作った一時ディレクトリに限る。

## 再利用

Pi をこのリポジトリで起動し（project trust を確認）、`/skill:verify-project <今回の対象>` で呼び出すか、この `SKILL.md` を明示的に読み込む。Skill を更新したら新しいセッションか `/reload`。通常の変更では関係する機能だけを実行し、変わった手順・helper・Map の該当箇所だけを直す。
