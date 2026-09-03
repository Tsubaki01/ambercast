---
title: プロンプトを書く
description: .test.md プロンプトファイルの形式、自然言語のステートメント、secret grant 行。
sidebar:
  order: 3
---

プロンプトは `<name>.test.md` という名前の Markdown ファイルである。唯一の信頼できる情報源であり、`ambercast generate` がこれを読んでプランを生成する。プランが再生成されるのは、プロンプトの意味のある内容が変化したときだけである。

## 構造

- テストケースを名付ける見出し（H1）。
- 何が起こるべきかを記述する、1 つ以上の自然言語のステートメント。特別な構文や DSL は使わない、平文の文章で書く。

```markdown
# Sign in

When I submit valid credentials, I reach the dashboard.
```

Markdown はプランの provenance に寄与する前に最小限に正規化される: 先頭のバイトオーダーマークが取り除かれ、改行コードは LF に変換されるが、それ以外はトリムも並べ替えも書き換えもされない。プロンプトは読ませたいとおりに書くこと。

## シークレット: grant 行

プロンプトとプランには、リテラルな認証情報を絶対に含めてはならない。シークレットは `{{secrets.name}}` として参照し、その使用をコードブロックの外側で独立した grant 行として明示的に許可する:

```markdown
@ambercast-secret {{secrets.password}}
```

対応する grant 行のないシークレット参照は、黙って処理を継続せず失敗する。解決とマスク（redaction）の全体像は [シークレット](/ambercast/ja/guides/secrets/) を参照。

## 実践的な例

```markdown
# Sign in with a saved password

@ambercast-secret {{secrets.password}}

When I submit the username "demo@example.com" and the password {{secrets.password}}, I reach the dashboard.
```

次は: `ambercast generate` と `ambercast run` を実行する — [コマンド](/ambercast/ja/guides/commands/) を参照。
