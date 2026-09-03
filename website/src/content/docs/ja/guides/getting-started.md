---
title: はじめる
description: ambercast の前提条件、インストール、クイックスタートの手順。
sidebar:
  order: 2
---

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

## 書き出され、コミットされるもの

`generate` はプロンプトと同じ場所に `tests/ambercast/sign-in.ambercast.plan.json` と `tests/ambercast/sign-in.ambercast.grounding.json` を書き出す。この 3 ファイルすべてをコミットすること — 全体像とコミット方針は [成果物](/ambercast/ja/guides/artifacts/) を参照。

次は: [自分のプロンプトを書く](/ambercast/ja/guides/writing-prompts/)、または [コマンドリファレンス](/ambercast/ja/guides/commands/) を読む。
