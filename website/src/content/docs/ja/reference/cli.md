---
title: CLI リファレンス
description: ambercast コマンドの --help 出力そのものと、全サブコマンドに共通するグローバルフラグ。
sidebar:
  order: 1
---

`ambercast --help` の出力（0.1.0）:

```text
Usage: ambercast <command> [options]

Commands:
  generate [files...]  Generate deterministic plans
  run [files...]       Replay deterministic plans
  check [files...]     Check plan freshness
  heal [files...]      Repair deterministic plans

Generate options:
  --strict  --force  --dry-run  --target <name>  --ai <claude|codex>
  --allow-empty  --list  --json  --config <path>  --no-color

Run options:
  --grep <pattern>  --target <name>  --headed  --cache-only  --update-cache  --allow-empty  --list
  --stale <fail>  --json  --no-color

Check options:
  --target <name>  --allow-empty  --list  --json  --config <path>  --no-color

Heal options:
  --dry-run  --yes, -y  --target <name>  --ai <claude|codex>  --allow-empty  --list  --json  --no-color

Heal configuration:
  heal.maxStepRepairs: Hard limit on real provider dispatches started during incremental repair. Charged at dispatch time regardless of outcome. Includes element confirmation dispatches. Excludes the cache-only baseline and Stage 3.
  heal.caseTimeoutMs: see docs/configuration.md for its admission-boundary contract.
```

## グローバルフラグ

すべてのコマンドが受け付ける:

| フラグ | 効果 |
| --- | --- |
| `--config <path>` | `ambercast.config.json` の自動検出ではなく、明示的な config ファイルを使用する |
| `--no-color` | カラー出力を無効化する |
| `--json` | レポートを人間可読テキストではなく JSON として出力する |
| `--` | このセパレータ以降はすべて、`--` で始まるものも含めてリテラルなプロンプトパスとして扱われる |

各サブコマンドのフラグの効果は [コマンド](/ambercast/ja/guides/commands/) を、`heal.maxStepRepairs` と `heal.caseTimeoutMs` については [設定リファレンス](/ambercast/ja/reference/configuration/) を参照。
