---
name: verify-project
description: browser-translator（Chrome MV3 拡張 + ローカル llama-server）の実動作確認。dist/ を一時プロファイルの Chrome に読み込み、所有するポートの llama-server（router モード）で基準ページと React のページ（react.dev）を翻訳し、設定画面の操作・service worker の送信内容・DOM の照合とスクリーンショットを残して後始末する。拡張の翻訳・表示（置き換え・対訳・原文の吹き出し）・あとから追加された段落・SPA での継続・接続エラー・設定（URL・モデル・送り方・表示方法・用語集）を変更したときに使う。
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

拡張の既定の送信先は `http://127.0.0.1:8080`。helper は設定画面で URL を変えられるので、検証用の llama-server は 8080 以外の自分のポート（例 `18080`）で起動する。

1. `lsof -iTCP:8080 -sTCP:LISTEN` と `lsof -iTCP:18080 -sTCP:LISTEN` を確かめる。8080 にいるプロセス（利用者の常駐 llama-server など）は**止めたり使ったりしない**。
2. 18080 が空いていれば、そこで自分の llama-server を起動する（下記）。使われていれば別の空いたポートを選ぶ（`host_permissions` の都合で `127.0.0.1` か `localhost` に限る）。
3. helper には `--server=http://127.0.0.1:18080`（`verify-translate.ts`・`verify-react.ts`）か第 2 引数（`verify-settings.ts`）で渡す。helper が設定画面で URL を保存してから翻訳する。

## 手順

証拠のディレクトリを run ごとに決める: `EVID=.pi/verification-evidence/<run名>-$(date +%Y%m%dT%H%M%S)`（Git 管理外）。続けて `mkdir -p "$EVID"`（手順 1 と 3 がこの中に書き込む）。

1. 版を記録する: `git rev-parse HEAD > $EVID/source.txt; git status --short >> $EVID/source.txt`。
2. ビルドする: `pnpm run build`（検証の前に必ず。読み込むのは `dist/`）。
3. llama-server を router モードで起動し、PID を控える:
   ```sh
   llama-server --models-dir <GGUF のディレクトリ> --host 127.0.0.1 --port 18080 --parallel 4 > $EVID/llama-server.log 2>&1 &
   echo $! > $EVID/llama-server.pid
   ```
   使用可能になるまで待ち、`curl -s http://127.0.0.1:18080/v1/models > $EVID/models.json` に目的のモデル（先頭が 0.8B。設定の確認には 2 つ以上）が並ぶことを確かめる。拡張は設定でモデルが未選択なら `/v1/models` の先頭を使う。
4. 設定の照合（Feature Map「設定画面」「URL」「モデル」「直列」「用語集」。設定に関わる変更のとき）:
   `node scripts/verify-settings.ts $EVID http://127.0.0.1:18080`
   exit 0 で、`$EVID/settings.json` の `checks` がすべて true。`settings-options-*.png` に設定画面、`settings-*-*.png` に訳したページが写っている。並列・直列・並列の 3 回訳すため、0.8B〜2B で 2 分ほどかかる。
5. 翻訳の照合（Feature Map「置き換え翻訳」）:
   `node scripts/verify-translate.ts translate $EVID --server=http://127.0.0.1:18080`
   exit 0 で、`$EVID/translate.json` の `checks` がすべて true（`bubble*` は原文の吹き出し。`bubbleColors` は薄い黄 `#fff6cc`・枠 `#b8921a`・文字 `#1f1f1f`）。スクリーンショット（`translate-*.png`）を開いて、日本語の本文・`code`・リンクの見た目と、`translate-4-bubble.png`（段落の下）・`translate-5-bubble-above.png`（段落の上）の吹き出しを目で確かめる。吹き出しの位置・`font-size`・幅・色は `translate.json` の `bubble` を `run.md` に書く。
   吹き出しの見た目を変えたときは、白いページと暗いページでも撮る（Feature Map「吹き出しの色（白いページ・暗いページ）」）: `node scripts/verify-bubble-colors.ts $EVID --server=http://127.0.0.1:18080`。exit 0 で、`bubble-colors.json` の `checks` がすべて true。`bubble-colors-light.png`・`bubble-colors-dark.png` で吹き出しが本文と区別できることを目で確かめ、色と `bodyBackground` を `run.md` に書く。
6. 対訳表示（Feature Map「対訳表示（基準ページ）」）:
   `node scripts/verify-translate.ts bilingual $EVID --server=http://127.0.0.1:18080`
   exit 0 で、`$EVID/bilingual.json` の `checks` がすべて true。`bilingual-2-*.png` で原文の下に訳文（`code`・強調・リンク付き）が出ていることを目で確かめる。
7. React のページ（Feature Map「React のページ・あとから追加された段落・SPA・リロード」）:
   `node scripts/verify-react.ts replace $EVID --server=http://127.0.0.1:18080` と
   `node scripts/verify-react.ts bilingual $EVID --server=http://127.0.0.1:18080`
   それぞれ exit 0 で、`react-<display>.json` の `checks` がすべて true。崩れ・戻しの目安（`idleRequests`・`shownBeforeIdle` / `shownAfterIdle`）・bfcache の使用（`back.restoredFromCache`）・ページのエラー（`pageErrors`）は記録値なので、`run.md` に書き、`react-<display>-*.png` を目で確かめる。1 回 2〜3 分（0.8B）。
8. 接続エラーの表示（Feature Map「接続エラー」）: 自分の llama-server を PID で止め（`kill $(cat $EVID/llama-server.pid)`）、`lsof -iTCP:18080 -sTCP:LISTEN` が空になったのを確かめてから:
   `node scripts/verify-translate.ts unreachable $EVID --server=http://127.0.0.1:18080`
   exit 0 で、`unreachable.json` の `checks` がすべて true。`unreachable-1-on.png` に赤い通知（URL を含む）が写っている。
9. 実行記録 `$EVID/run.md` を書く: 対象機能と入口、source の版と未コミット変更、前提（Chrome・llama-server の版、モデル）、操作、期待結果と観測結果、成否、未確認の範囲。
10. 後始末: 自分が起動した llama-server だけを PID で止める（プロセス名で一括終了しない）。Chrome と一時プロファイルは helper が終了時に閉じて消す（`ls -d ${TMPDIR:-/tmp}/bt-chrome-*` で残りが無いか確かめる）。証拠は消さない。後始末の後に `$EVID` の JSON と PNG が読めることを確かめる。

手順 5・6・8 の `--server` を省くと、helper は設定を変えずに既定の `http://127.0.0.1:8080` へ送る（8080 が空いていて自分で起動した場合だけ使う）。

失敗したら、llama-server が使用可能か（`/v1/models`）と `dist/` が最新かを確かめ直してから再実行する。helper の不具合は helper を直して再実行する。製品の不具合を期待値の緩和で隠さない。

## helper

- `scripts/cdp.ts`: Chrome の起動（一時プロファイル）、拡張の読み込み、service worker への attach、`Runtime.evaluate`。
- `scripts/extension.ts`: 設定画面（`chrome-extension://<id>/options.html`）を新しいタブで開き、利用者と同じくフォームを埋めて「保存」を押す `applyOptions`（保存後のスクリーンショットと `chrome.storage.local` の中身を返す）。service worker のセッションで `Network.enable` し、送信の URL・時刻・本文・応答の訳文と `finish_reason` を記録する `recordWorkerRequests`、同時送信数の `maxInFlight`、PFML3 を要素に分ける `pfml3Elements`。
- `scripts/verify-settings.ts <evidenceDir> <serverUrl> [pageUrl]`: 1 つの Chrome で、設定画面から (1) URL（末尾 `/` 付きで入力）・2 番目のモデル・並列・用語集 `pi = パイ` / `harness = 実行基盤` を保存して訳す、(2) 直列・先頭のモデルにして訳す、(3) 並列に戻して訳す。送信内容とページを照合して `settings.json` とスクリーンショットを保存する。
- `scripts/verify-translate.ts <translate|bilingual|unreachable> <evidenceDir> [pageUrl] [--server=<url>]`: `--server` があれば先に設定画面でその URL を保存する（`bilingual` は表示方法「対訳」も保存する）。新しいタブで基準ページを開き、翻訳前に段落の原文を page の main world の `WeakMap` に控え（ページの DOM は変えない）、CDP の `Extensions.triggerAction`（ツールバーのボタンを押したときと同じく `chrome.action.onClicked` が発火する）で翻訳モードを切り替え、DOM を照合する。`translate` では CDP の `Input.dispatchMouseEvent` で訳した段落にマウスを乗せ、原文の吹き出し（Shadow DOM の中身・`font-size`・幅・位置・`user-select`・色、吹き出しへ移っても残る、離れると消える）を観測する。JSON とスクリーンショットを保存する。
- `scripts/verify-bubble-colors.ts <evidenceDir> --server=<url> [pageUrl]`: 設定画面で URL と表示方法「置き換え」を保存し、React のページ（既定 https://react.dev/learn ）を CDP の `Emulation.setEmulatedMedia` で `prefers-color-scheme: light` と `dark` にしてそれぞれ開いて訳し、訳した段落にマウスを乗せて吹き出しを撮る。吹き出しの計算済みの色と body の背景色を `bubble-colors.json` に、スクリーンショットを `bubble-colors-{light,dark}.png` に保存する。
- `scripts/verify-react.ts <replace|bilingual> <evidenceDir> --server=<url> [pageUrl] [--link=<path>]`: 設定画面で URL と表示方法を保存し、React のページ（既定 https://react.dev/learn ）で (1) 翻訳（`code` の中に `<` を含む段落が ⚠ ではなく訳されたかを含む）、(2) 待つ・スクロール・ホバーの後に React が原文に戻したか、(3) ページ側から段落を 1 つ足して訳されるか（送信が 1〜2 回で止まるか）と、その段落をページが同じ本文で描き直したとき訳文が戻るか、(4) ページ内のリンク（既定 `/learn/describing-the-ui`）を CDP のマウス操作で押して SPA の移動（同じ document のまま）後もバッジ `ON` で新しい内容が訳されるか、(5) 変化がない間に送信が出ないか、(6) オフ、(7) オンにしてリロードで翻訳モードが終わるか、(8) オンにして通常の移動の後に履歴で戻ったとき（bfcache を含む）翻訳モードが終わっているか、を観測して `react-<display>.json` とスクリーンショットを保存する。
- `scripts/verify-connection.ts`: Work Item 1 の接続確認（service worker から `/v1/models` と `/v1/completions`）。

`Extensions.triggerAction` は CDP からの発火で、画面上のボタンを物理的に押すわけではない。実際のボタンのクリックは、ヘッドありの Chrome で人が少なくとも 1 回確かめる（Feature Map の注意を参照）。

## 証拠と安全性

- 保存先は `.pi/verification-evidence/<run>/`（`.gitignore` 済み）。run ごとに新しいディレクトリを使い、古い成功を流用しない。
- 保存するのは JSON の照合結果、スクリーンショット、必要な最小限のログだけ。秘密値や個人情報は保存しない。基準ページは公開記事。
- 利用者の普段の Chrome プロファイルや常駐の llama-server を使わない・止めない。後始末は自分が起動した PID と自分が作った一時ディレクトリに限る。

## 再利用

Pi をこのリポジトリで起動し（project trust を確認）、`/skill:verify-project <今回の対象>` で呼び出すか、この `SKILL.md` を明示的に読み込む。Skill を更新したら新しいセッションか `/reload`。通常の変更では関係する機能だけを実行し、変わった手順・helper・Map の該当箇所だけを直す。
