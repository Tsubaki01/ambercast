[English](README.md) | 日本語 | [简体中文](README.zh-CN.md)

# ambercast

プロンプトネイティブな E2E テスト。

[![npm version](https://img.shields.io/npm/v/ambercast)](https://www.npmjs.com/package/ambercast)
[![CI](https://github.com/kotarotsubaki/ambercast/actions/workflows/ci.yml/badge.svg)](https://github.com/kotarotsubaki/ambercast/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node >= 22.14](https://img.shields.io/badge/node-%3E%3D22.14-brightgreen)

テストケースを自然言語の Markdown プロンプトとして書く — プロンプトそのものが唯一の信頼できる情報源（single source of truth）になる。AI ジェネレータが各プロンプトを決定的な、ロックファイルのような実行プラン（plan）へ変換する。以降の実行はそのプランをリプレイするだけで、**AI 呼び出しはゼロ**になる。高速・無料・完全に再現可能である。アプリの UI が変化した場合はプランが自己修復し、テストの*意味*そのものが変わった場合は人間にレビューを求める。

琥珀（amber）に閉じ込められた虫のように、テストの意図は一度だけ鋳込まれ、表面がどれだけ変化してもそのまま保たれる。

> [!NOTE]
> ambercast はまだ 1.0 未満（pre-1.0）で、活発に開発中である。[ステータスと制限事項](#ステータスと制限事項) を参照。

**ドキュメントサイト:** https://kotarotsubaki.github.io/ambercast/ja/ （English / 日本語 / 简体中文）

## インストール

```bash
npm install -D ambercast
```

または、インストールせずに実行する:

```bash
npx ambercast <command>
```

Node.js >= 22.14、Chromium バイナリ（`npx playwright-core install chromium`）、および認証済みの AI プロバイダー CLI（[Claude Code CLI](https://docs.claude.com/en/docs/claude-code) または [Codex CLI](https://github.com/openai/codex) のいずれか。ambercast は認証情報を管理しないため、自身のキーを用意すること）が必要である — [入門ガイド](https://kotarotsubaki.github.io/ambercast/ja/guides/getting-started/) を参照。

## クイックスタート

`init` コマンドはまだ無い。必要なのはプロンプトファイルのみであり、デフォルトではアプリが `http://localhost:3000` にあることを前提としている（[設定](https://kotarotsubaki.github.io/ambercast/ja/reference/configuration/) を参照）。

1. `tests/ambercast/sign-in.test.md` にテストプロンプトを書く:

   ```markdown
   # Sign in

   When I submit valid credentials, I reach the dashboard.
   ```

2. プランを生成し、実行する:

   ```bash
   npx ambercast generate
   npx ambercast run
   ```

`generate` はプロンプトと同じ場所に `sign-in.ambercast.plan.json` と `sign-in.ambercast.grounding.json` を書き出す。これら 3 つのファイルをすべてコミットすること。以降の `run` はプランをリプレイするだけで、AI 呼び出しはゼロになる — [プロンプトの書き方](https://kotarotsubaki.github.io/ambercast/ja/guides/writing-prompts/) ガイドを参照。

## もっと知る

- [コマンド](https://kotarotsubaki.github.io/ambercast/ja/guides/commands/) — generate、run、check、heal コマンドの概要。
- [終了コード](https://kotarotsubaki.github.io/ambercast/ja/guides/exit-codes/) — 終了コード 0–5 と、結果が混在するバッチでの優先順位。
- [アーティファクト](https://kotarotsubaki.github.io/ambercast/ja/guides/artifacts/) — どの生成ファイルをコミットし、どれを gitignore すべきか。
- [シークレット](https://kotarotsubaki.github.io/ambercast/ja/guides/secrets/) — 認証情報をプロンプトやプランに含めずにテストへ渡す方法。
- [CI での利用](https://kotarotsubaki.github.io/ambercast/ja/guides/ci/) — CI 上での実行と、CI で heal がブロックされる理由。
- [設定リファレンス](https://kotarotsubaki.github.io/ambercast/ja/reference/configuration/) — `ambercast.config.json` の全フィールドに関する完全なリファレンス。

## ステータスと制限事項

ambercast は **0.x、pre-1.0** である: マイナーリリースで破壊的変更が入り得る。現在のスコープ:

- Chromium のみ対応（Firefox と WebKit は計画中）。
- ローカル実行のみ — ホスト型のランナーは無い。
- `init` コマンドはまだ無い — config とプロンプトは手動でセットアップすること（[クイックスタート](#クイックスタート) を参照）。
- 結果ビューアはまだ無い。
- MCP サーバーはまだ無い。

## コントリビューション

バグ報告や PR を歓迎する。まずは [CONTRIBUTING.md](CONTRIBUTING.md) を参照すること。同ファイルには PR タイトルの規約、日常的に使うスクリプト、そして AGENTS.md にあるメンテナーの AI 自動化が外部からのコントリビューションとどのように関連しているか（必須要件ではない）が記載されている。

## ライセンス

MIT — [LICENSE](LICENSE) を参照。
