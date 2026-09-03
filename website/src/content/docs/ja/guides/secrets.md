---
title: シークレット
description: "{{secrets.name}} 参照構文、環境変数へのマッピング、grant、マスク処理。"
sidebar:
  order: 7
---

プロンプトとプランには、リテラルな認証情報を絶対に含めてはならない。シークレットは `{{secrets.name}}` として参照し、環境変数 `AMBERCAST_SECRET_NAME`（ドットはアンダースコアに変換され、大文字化される — つまり `{{secrets.api.key}}` は `AMBERCAST_SECRET_API_KEY` を解決する）から解決する。

## grant 行

シークレット参照は、コードブロックの外側で、独立した行としてプロンプトが明示的に許可（grant）した場合にのみ有効になる:

```markdown
@ambercast-secret {{secrets.password}}
```

フェンス付きコードブロック、インデントされたコードブロック、またはインラインコードスパンの中にある grant 行は権威を持たない — それはドキュメントであり、grant ではない。

## フェイルクローズなエラー

- 生成されたプランに、参照ではなくリテラルに見えるシークレット（`sk-...`、`ghp_...`、AWS アクセスキー、その他の高エントロピーなトークン）が埋め込まれている場合は拒否される（`secret-literal-rejected`、exit 2）。
- 参照されたシークレットに対応する grant 行が無い場合、または対応する環境変数が無い場合は、黙って処理を継続せず失敗する（`secret-grant-unattributable` / `secret-unresolved`、exit 2）。

## マスク（redaction）

解決されたシークレットの値は、書き込みや出力の前に、キャプチャされたエビデンス・レポート・エラー出力から必ずマスクされる。

実践的な例は [プロンプトを書く](/ambercast/ja/guides/writing-prompts/) を参照。
