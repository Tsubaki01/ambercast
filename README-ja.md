[English](README.md) | 日本語 | [简体中文](README-zh-CN.md)

# ambercast

プロンプトネイティブな E2E テストです。

[![npm version](https://img.shields.io/npm/v/ambercast)](https://www.npmjs.com/package/ambercast)
[![CI](https://github.com/kotarotsubaki/ambercast/actions/workflows/ci.yml/badge.svg)](https://github.com/kotarotsubaki/ambercast/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node >= 22.14](https://img.shields.io/badge/node-%3E%3D22.14-brightgreen)

テストケースを自然言語の Markdown プロンプトとして書きます — プロンプトそのものが唯一の信頼できる情報源（single source of truth）になります。AI ジェネレータが各プロンプトを決定的な、ロックファイルのような実行プラン（plan）へ変換します。以降の実行はそのプランをリプレイするだけで、**AI 呼び出しはゼロ**になります。高速・無料・完全に再現可能です。アプリの UI が変化した場合はプランが自己修復し、テストの*意味*そのものが変わった場合は人間にレビューを求めます。

琥珀（amber）に閉じ込められた虫のように、テストの意図は一度だけ鋳込まれ、表面がどれだけ変化してもそのまま保たれます。

> [!NOTE]
> ambercast はまだ 1.0 未満（pre-1.0）で、活発に開発中です。[ステータスと制限事項](#ステータスと制限事項) を参照してください。

**ドキュメントサイト:** https://kotarotsubaki.github.io/ambercast/ja/ （English / 日本語 / 简体中文）

## インストール

```bash
npm install -D ambercast
```

または、インストールせずに実行します:

```bash
npx ambercast <command>
```

前提条件として Node.js >= 22.14、Chromium（`npx playwright-core install chromium`）、および認証済みの [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) または [Codex CLI](https://github.com/openai/codex) が必要であり、ambercast は認証情報を管理しないため各自でキーを用意する必要があります（詳細は[入門ガイド](https://kotarotsubaki.github.io/ambercast/ja/guides/getting-started/)を参照してください）。

## クイックスタート

`init` コマンドはまだ無く、プロンプトファイルが 1 つあれば始められますが、既定ではアプリが `http://localhost:3000` で動いている前提です（変更方法は[設定](https://kotarotsubaki.github.io/ambercast/ja/reference/configuration/)を参照してください）。

1. `tests/ambercast/sign-in.test.md` にテストプロンプトを書きます:

   ```markdown
   # Sign in

   When I submit valid credentials, I reach the dashboard.
   ```

2. プランを生成して実行します:

   ```bash
   npx ambercast generate
   npx ambercast run
   ```

`generate` はプロンプトの隣に `sign-in.ambercast.plan.json` と `sign-in.ambercast.grounding.json` を書き出すため、3 ファイルすべてを git にコミットします。以降の `run` はキャッシュ済みの grounding が揃っている限りプランをリプレイするだけで AI 呼び出しはゼロです。grounding が欠けたステップは AI にフォールバックし、`--cache-only` を付けると代わりに失敗します（詳細は[プロンプトの書き方](https://kotarotsubaki.github.io/ambercast/ja/guides/writing-prompts/)を参照してください）。

## もっと知る

- [コマンド一覧](https://kotarotsubaki.github.io/ambercast/ja/guides/commands/) — `generate`、`run`、`check`、`heal` の各コマンドの使い方
- [終了コード](https://kotarotsubaki.github.io/ambercast/ja/guides/exit-codes/) — 終了コード 0〜5 の定義と、結果が混在するバッチ実行時の優先順位
- [アーティファクト](https://kotarotsubaki.github.io/ambercast/ja/guides/artifacts/) — どの生成ファイルをコミットし、どれを gitignore すべきかの指針
- [シークレット管理](https://kotarotsubaki.github.io/ambercast/ja/guides/secrets/) — 認証情報をプロンプトやプランに含めずテストへ安全に渡す方法
- [CI での実行](https://kotarotsubaki.github.io/ambercast/ja/guides/ci/) — CI パイプラインでの実行手順と、CI 上で heal がブロックされる仕様
- [設定リファレンス](https://kotarotsubaki.github.io/ambercast/ja/reference/configuration/) — `ambercast.config.json` で利用可能な全設定フィールドの一覧

## ステータスと制限事項

ambercast は **0.x、pre-1.0** です: マイナーリリースで破壊的変更が入り得ます。現在のスコープ:

- Chromium のみ対応です（Firefox と WebKit は計画中です）。
- ローカル実行のみ — ホスト型のランナーはありません。
- `init` コマンドはまだありません — config とプロンプトは手動でセットアップしてください。
- 結果ビューアはまだありません。
- MCP サーバーはまだありません。

## コントリビューション

バグ報告やプルリクエストを歓迎します。コントリビューションの前にまず [CONTRIBUTING.md](CONTRIBUTING.md) を確認してください。そこには PR タイトル規約や日常の開発スクリプト、AGENTS.md に記載されたメンテナー用 AI 自動化と外部コントリビューションの関係（必須ではない）が記載されています。

## ライセンス

MIT — [LICENSE](LICENSE) を参照してください。
