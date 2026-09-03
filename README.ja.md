[English](README.md) | 日本語 | [简体中文](README.zh-CN.md)

# ambercast

プロンプトネイティブな E2E テスト。

[![npm version](https://img.shields.io/npm/v/ambercast)](https://www.npmjs.com/package/ambercast)
[![CI](https://github.com/Tsubaki01/ambercast/actions/workflows/ci.yml/badge.svg)](https://github.com/Tsubaki01/ambercast/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node >= 22.14](https://img.shields.io/badge/node-%3E%3D22.14-brightgreen)

テストケースを自然言語の Markdown プロンプトとして書く — プロンプトそのものが唯一の信頼できる情報源（single source of truth）になる。AI ジェネレータが各プロンプトを決定的な、ロックファイルのような実行プラン（plan）へ変換する。以降の実行はそのプランをリプレイするだけで、**AI 呼び出しはゼロ**になる。高速・無料・完全に再現可能である。アプリの UI が変化した場合はプランが自己修復し、テストの*意味*そのものが変わった場合は人間にレビューを求める。

琥珀（amber）に閉じ込められた虫のように、テストの意図は一度だけ鋳込まれ、表面がどれだけ変化してもそのまま保たれる。

> [!NOTE]
> ambercast はまだ 1.0 未満（pre-1.0）で、活発に開発中である。[ステータスと制限事項](#ステータスと制限事項) を参照。

**ドキュメントサイト:** https://tsubaki01.github.io/ambercast/ja/ （English / 日本語 / 简体中文）

## 仕組み

```text
sign-in.test.md
      │  ambercast generate（AI 呼び出し、1 回のみ）
      ▼
sign-in.ambercast.plan.json  +  sign-in.ambercast.grounding.json
      │  両方を git にコミット
      ▼
ambercast run（リプレイ — AI 呼び出しはゼロ）
      │
      ├─ グラウンディング ヒット → 決定的なリプレイ
      ├─ グラウンディング ミス → そのステップだけライブの AI 支援ステップを実行し、キャッシュを更新（git で diff 可能）
      └─ ドリフト検出 → ambercast heal がプランを修復（人間が確認）
```

1. **Generate（生成）** — AI プロバイダがプロンプトを 1 回読み、プラン（実行するステップ）とグラウンディング（grounding）キャッシュ（見つけた具体的なセレクタや座標）を生成する。どちらもプレーンな JSON であり、ロックファイルと同様にコミットしてレビューすることを前提としている。
2. **Run（実行）** — キャッシュ済みのグラウンディングを使い、実ブラウザに対してプランをリプレイする。ハッピーパスでは AI 呼び出しは発生しない。あるステップでグラウンディングがミスした場合は、そのステップに限りライブの AI 支援解決にフォールバックする（`--cache-only` でこれをスキップできる）。
3. **Heal（自己修復）** — UI のドリフトが大きくリプレイだけでは復旧できない場合、`ambercast heal` が影響を受けたプランのステップを再解決・修復・再生成し、書き込み前に確認を求める。

## 前提条件

- Node.js >= 22.14
- [Playwright](https://playwright.dev) 用の Chromium バイナリ:

  ```bash
  npx playwright-core install chromium
  ```

- インストール済み・認証済みの AI プロバイダ CLI（自前で用意する必要がある。ambercast は認証情報を管理しない）:
  - [Claude Code CLI](https://docs.claude.com/en/docs/claude-code)（`claude`）、または
  - [Codex CLI](https://github.com/openai/codex)（`codex`）

  デフォルト（`ai.provider: "auto"`）では ambercast が `claude` → `codex` の順に応答を確認し、応答があった方を使用する。`--ai claude` / `--ai codex` を渡すか、config の `ai.provider` を設定すれば固定できる。

## インストール

```bash
npm install -D ambercast
```

または、インストールせずに実行する:

```bash
npx ambercast <command>
```

## クイックスタート

`init` コマンドはまだ無いため、2 つの要素を手動でセットアップする。

1. プロジェクトルートに `ambercast.config.json` を作成する（任意 — 以下はデフォルト値）:

   ```json
   {
     "testDir": "tests/ambercast",
     "targets": {
       "web-user": { "baseUrl": "http://localhost:3000", "browser": "chromium" }
     }
   }
   ```

2. `tests/ambercast/sign-in.test.md` にテストプロンプトを書く:

   ```markdown
   # Sign in

   When I submit valid credentials, I reach the dashboard.
   ```

3. プランを生成し、実行する:

   ```bash
   npx ambercast generate
   npx ambercast run
   ```

`generate` はプロンプトと同じ場所に `tests/ambercast/sign-in.ambercast.plan.json` と `tests/ambercast/sign-in.ambercast.grounding.json` を書き出す。この 3 ファイルすべてをコミットすること。

## コマンド

すべてのコマンドは `--config <path>`、`--no-color`、`--json`、および共有の `--` セパレータ（それ以降は `--` で始まるものも含めてすべてリテラルなプロンプトパスとして扱われる）を受け付ける。位置引数はリテラルなプロンプトパスであり、指定が無い場合 ambercast は `testDir`/`testMatch`/`testIgnore` を通じてプロンプトを検出する。

### `generate [files...]`

プロンプトをプランへ変換する。必要なプロンプトについてのみ AI を 1 回呼び出し、プランが既に最新のプロンプトはスキップする。

| フラグ | 効果 |
| --- | --- |
| `--strict` | 生成結果があいまいな場合、警告のみでなく失敗にする |
| `--force` | プランが最新であっても無条件に再生成する |
| `--dry-run` | プラン/グラウンディングファイルを書き込まずにプレビューする |
| `--target <name>` | 設定済みのターゲットを選択する |
| `--ai <claude\|codex>` | この呼び出しに限りプロバイダ選択を上書きする |
| `--allow-empty` | 0 件マッチでも exit 5 で終了せず成功にする |
| `--list` | 生成せずに解決済みのプロンプトパスを報告する |
| `--config <path>` | 明示的な config ファイルを使用する |

書き込むファイル: `<name>.ambercast.plan.json`、`<name>.ambercast.grounding.json`。

### `run [files...]`

キャッシュ済みグラウンディングを使い、実際の Chromium セッションに対してプランを決定的にリプレイする。あるステップのキャッシュ済みグラウンディングが欠落している場合を除き、AI 呼び出しは発生しない。

| フラグ | 効果 |
| --- | --- |
| `--grep <pattern>` | 検出されたプロンプトパスを正規表現で絞り込む |
| `--target <name>` | 設定済みのターゲットを選択する |
| `--headed` | 表示されるブラウザウィンドウ付きで実行する |
| `--cache-only` | グラウンディングミス時に AI へフォールバックせず失敗させる |
| `--update-cache` | 今回の実行によるグラウンディングキャッシュの変更の永続化を明示的に許可する |
| `--stale <fail>` | プランが古い/欠落している場合のフレッシュネスポリシー。現時点で対応しているのは `fail` のみ（`regenerate` はパーサーには受理されるが、現状は常に exit 2 で拒否される） |
| `--ai <claude\|codex>` | グラウンディングミスのフォールバックが必要な場合に限り使用するプロバイダを上書きする |
| `--allow-empty` | 0 件マッチでも exit 5 で終了せず成功にする |
| `--list` | 実行せずに解決済みのプロンプトパスを報告する |

書き込むファイル: 呼び出しごとのエビデンスと `runsDir`（デフォルト `tests/ambercast/.runs/`）配下の `report.json`（[成果物](#成果物) を参照）。グラウンディングキャッシュの更新は、以下の書き戻しポリシーに従う。

グラウンディングキャッシュの変更が実際に永続化されるかどうかは、`--update-cache`、`grounding.localWriteBack`、および（CI の場合）`ci.updateGroundingCache` に依存する:

| 環境 | 永続化される条件 |
| --- | --- |
| ローカル、`localWriteBack: "auto"`（デフォルト） | 常に永続化 |
| ローカル、`localWriteBack: "explicit"` | `--update-cache` が渡された場合 |
| CI | `--update-cache` が渡された場合、または `ci.updateGroundingCache: true` の場合 |

### `check [files...]`

読み取り専用のフレッシュネス検査。AI プロバイダやブラウザを呼び出すことは一切なく、何も書き込まない。`run` の前段の CI ゲートとして使用する。

| フラグ | 効果 |
| --- | --- |
| `--target <name>` | 設定済みのターゲットを選択する |
| `--allow-empty` | 0 件マッチでも exit 5 で終了せず成功にする |
| `--list` | チェックせずに解決済みのプロンプトパスを報告する |
| `--config <path>` | 明示的な config ファイルを使用する |

### `heal [files...]`

グラウンディングが実際の UI と一致しなくなったプランを修復する: ステップの再解決 → 構造化されたステップ修復 → プラン全体の再生成の順にエスカレーションし、必要な範囲でのみ段階を進める。

| フラグ | 効果 |
| --- | --- |
| `--dry-run` | 何も書き込まずに修復内容を計測・プレビューする |
| `--yes`, `-y` | 対話的な確認プロンプトなしで修復を確定する |
| `--target <name>` | 設定済みのターゲットを選択する |
| `--ai <claude\|codex>` | この呼び出しに限りプロバイダ選択を上書きする |
| `--allow-empty` | 0 件マッチでも exit 5 で終了せず成功にする |
| `--list` | 修復せずに解決済みのプロンプトパスを報告する |

CI では、`ci.heal: true` が設定されていない限り `heal` は実行を拒否する（exit 2）— [CI での利用](#ci-での利用) を参照。

インクリメンタルな修復を制御する設定キーが 2 つある。完全な仕様は [`docs/configuration.md`](docs/configuration.md) を参照:

- `heal.maxStepRepairs` — 1 回の修復バッチあたりの実プロバイダ呼び出し回数のハードリミット（任意。デフォルトは未設定で上限なし）。
- `heal.caseTimeoutMs` — 1 件の修復ケースに対する admission-boundary（受理境界）のデッドライン。

## 終了コード

| コード | 意味 |
| --- | --- |
| `0` | 成功 |
| `1` | アサーション失敗（リプレイされたケースの期待値が成立しなかった） |
| `2` | 使用方法または設定エラー（不正なフラグ/config、未解決のシークレットまたはターゲット、CI での heal ブロック） |
| `3` | 環境エラー（ブラウザ起動失敗、AI プロバイダ利用不可、ファイル I/O 失敗、予期しないクラッシュ、中断） |
| `4` | プランまたはグラウンディングの成果物が信頼できない（欠落、`inputsDigest` が古い、1:1 対応が壊れている）— 結果を信頼する前に再生成が必要 |
| `5` | 選択条件が 0 件のプロンプトにマッチした（`--allow-empty` で無効化可能） |

バッチの結果がこれら複数のカテゴリにまたがる場合、報告されるプロセスの終了コードは次の固定順位のうち最も優先度が高いものになる: **2 > 3 > 4 > 1 > 5 > 0**。個々のケースの結果は、常に JSON レポートの `results`/`errors` に保持される。

## 成果物

| ファイル | 何であるか | git にコミットするか |
| --- | --- | --- |
| `<name>.test.md` | プロンプト — 唯一の信頼できる情報源 | する |
| `<name>.ambercast.plan.json` | 生成された実行プラン | する（ロックファイルのようにレビューすること） |
| `<name>.ambercast.grounding.json` | プランが解決したキャッシュ済みセレクタ/状態 | デフォルトでする（`grounding.repositoryPolicy: "committed"`） |
| `tests/ambercast/.runs/<invocation-id>/...` | 呼び出しごとのエビデンスと `report.json`（場所は `runsDir`） | しない — このディレクトリは gitignore すること |

## シークレット

プロンプトとプランには、リテラルな認証情報を絶対に含めてはならない。シークレットは `{{secrets.name}}` として参照し、環境変数 `AMBERCAST_SECRET_NAME`（ドットはアンダースコアに変換され、大文字化される）から解決する。

シークレット参照は、コードブロックの外側で、独立した行としてプロンプトが明示的に許可（grant）した場合にのみ有効になる:

```markdown
@ambercast-secret {{secrets.password}}
```

- 生成されたプランに、参照ではなくリテラルに見えるシークレット（`sk-...`、`ghp_...`、AWS アクセスキー、その他の高エントロピーなトークン）が埋め込まれている場合は拒否される（`secret-literal-rejected`、exit 2）。
- 参照されたシークレットに対応する grant 行が無い場合、または対応する環境変数が無い場合は、黙って処理を継続せず失敗する（`secret-grant-unattributable` / `secret-unresolved`、exit 2）。
- 解決されたシークレットの値は、書き込みや出力の前に、キャプチャされたエビデンス・レポート・エラー出力から必ずマスク（redact）される。

## CI での利用

CI での安全なデフォルトは、フレッシュネスをゲートする `check` を実行し、続けて heal もキャッシュの書き戻しも行わずに `run` を実行することである:

```bash
npx ambercast check
npx ambercast run
```

- `heal` はどこでも自動実行されることはなく、`ambercast.config.json` で `ci.heal: true` を明示的に指定しない限り CI では実行を拒否する。
- `run` によるグラウンディングキャッシュの変更は、その呼び出しで `--update-cache` を渡すか `ci.updateGroundingCache: true` を設定しない限り、CI では永続化されない。
- パイプラインはプロセスの終了コードをゲートに使うこと（[終了コード](#終了コード) を参照）。特に `4` は、コミット済みのプラン/グラウンディングがもうプロンプトと一致していないことを意味し、必要なのは再実行ではなく `generate` または `heal` である。

## 設定

プロジェクトルートの `ambercast.config.json` が、テスト検出・ターゲット・AI プロバイダ・ビューア・CI の挙動・グラウンディングポリシー・healing の上限を制御する。すべてのフィールドにデフォルト値があるため、このファイルは任意である。非自明な契約を持つフィールドについては [`docs/configuration.md`](docs/configuration.md) を参照。

## ステータスと制限事項

ambercast は **0.x、pre-1.0** である: マイナーリリースで破壊的変更が入り得る。現在のスコープ:

- Chromium のみ対応（Firefox と WebKit は計画中）。
- ローカル実行のみ — ホスト型のランナーは無い。
- `init` コマンドはまだ無い — config とプロンプトは手動でセットアップすること（[クイックスタート](#クイックスタート) を参照）。
- 結果ビューアはまだ無い。
- MCP サーバーはまだ無い。

## コントリビューション

プロジェクトの設計上の不変条件・規約・ワークフローについては [`AGENTS.md`](AGENTS.md) を参照。よく使うスクリプト:

- `npm run build` — `src/` を `dist/` へコンパイルする
- `npm test` — ビルド後にテストスイートを実行する
- `npm run typecheck` / `npm run lint`

## ライセンス

MIT — [LICENSE](LICENSE) を参照。
