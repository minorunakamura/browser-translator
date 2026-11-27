# GitHub Actions CI の追加

## 目的

GitHub 上で push / pull request ごとに正式チェック `pnpm run check` を自動実行し、壊れた変更を早期に検出する。

## 要件・決定事項

- ワークフローは `.github/workflows/ci.yml` の 1 本、1 ジョブ。
- トリガー: `push`（`main` ブランチのみ）と `pull_request`（全ブランチ向け）。
- ランナー: `ubuntu-latest`。
- Node.js: `24`（`actions/setup-node` の `node-version: 24`）。
- pnpm: `pnpm/action-setup` で `version` を指定せず、`package.json` の `packageManager: pnpm@12.23.0` を使う。
- 手順: checkout → pnpm セットアップ → setup-node（`cache: pnpm`）→ `pnpm install --frozen-lockfile` → `pnpm run check`。
  - pnpm は setup-node より先にセットアップする（`cache: pnpm` の前提条件）。
- Action はコミット SHA で固定し、タグをコメントで併記する（devDependencies を厳密固定する既存方針と揃える）。2026-11-27 時点の最新:
  - `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`
  - `pnpm/action-setup@73e46992e05b19abd31f2f3c20e0e7370d762115 # v6.1.1`
  - `actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0`
  - Implementation 開始時に SHA とタグの対応を `gh api` 等で再確認する。食い違えば最新の正しい SHA を使う（メジャーが変わる場合はユーザーに確認）。
- `permissions: contents: read` を設定し、GITHUB_TOKEN の権限を最小にする。

### 根拠（外部調査、2026-11-27）

- pnpm/action-setup は v6.1.0 から pnpm 12 に対応し、`version` 省略時は `packageManager` を読む（https://github.com/pnpm/action-setup）。
- setup-node の `cache: pnpm` は pnpm が先に入っていれば使える（https://github.com/actions/setup-node）。
- ubuntu-latest（Ubuntu 26.04 / 24.04 どちらも）のツールキャッシュに Node 24 がある（actions/runner-images の Readme）。
- CI 環境では pnpm の `--frozen-lockfile` が既定。明示しても動作は同じだが、意図を明確にするため明示する（https://pnpm.io/cli/install）。
- pnpm の `minimumReleaseAge`（既定 1 日）は frozen install の lockfile 検証にも再適用される。既存の `pnpm-workspace.yaml` の `minimumReleaseAgeExclude` がそのまま効く。

## 制約・対象外

- Chrome 実機での拡張の検証、llama-server を使う検証（`scripts/verify-connection.ts` など）は CI に入れない。
- `dist/` の artifact 保存、リリース、デプロイ、マトリクス（複数 OS / Node）、`concurrency` 等の追加設定は入れない。
- 依存（devDependencies）は追加しない。`package.json` の scripts も変更しない。
- ブランチ保護ルール（必須チェック化）など GitHub リポジトリ設定は変更しない。
- README はまだ存在せず、作成は既存 Plan（`docs/plans/browser-translator-initial.md`）の Work Item の範囲なので、今回は作成・更新しない。

## 実装方針

- `.github/workflows/ci.yml` を新規作成するのみ。
- 文書更新: なし（README 未作成のため。CI の記載は README 作成時に既存 Plan 側で扱えばよい）。

## 完了条件

1. `.github/workflows/ci.yml` が上記の要件どおりに存在する。
2. `actionlint` がエラー 0 件。
3. ローカルで `pnpm run check` が成功する（CI と同じコマンド）。
4. GitHub 上で実際にワークフローが実行され、全ステップが成功する（pnpm 12.23.0、Node 24 が使われたことをログで確認）。

## 動作確認方法

- 保証対象: ワークフローの構文の正しさ、GitHub Actions 上で install と `pnpm run check` が成功すること。
- 対象外: Chrome 実機・llama-server の検証（CI に入れないため）。
- 自動テスト: 追加しない（設定ファイルのみの変更で、専用テストを書かない既存方針に従う）。TDD は不採用。
- 直接確認:
  1. `actionlint .github/workflows/ci.yml` → エラー 0 件。
  2. `pnpm run check` → 成功。
  3. 作業ブランチを push して PR を作るか、`main` への push で、`gh run list` / `gh run view --log` で実行結果を確認。期待結果: ジョブ成功、ログに pnpm 12.23.0 と Node v24.x が出る。push / PR 作成はユーザーの許可を得てから行う。
- 検証資産: 既存の `.pi/skills/verify-project/` 等の Chrome 用検証は今回の対象と関係ない。上記の確認は `actionlint` と `gh`（導入・認証済み）の標準コマンドで、会話履歴なしで実行できるため Create の予定はない。Implementation の Root は、手段が不足すると判明した場合、承認済みの保証対象・期待結果を変えずに最小の手順・helper を補完してよい。追加 install やリポジトリ設定の変更が必要なら事前にユーザーに確認する。GitHub 上で実行できない（権限不足など）場合は、試した方法と再開条件を示して BLOCKED とし、成功扱いにしない。
- 証拠: `gh run view` の結果（run URL と成否）を報告する。cleanup は不要（一時ブランチを作った場合は、マージ後の扱いをユーザーに確認）。
