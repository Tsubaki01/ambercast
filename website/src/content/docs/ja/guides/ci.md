---
title: CI での利用
description: 安全なデフォルトの CI パイプライン、CI での heal 拒否、キャッシュ書き戻しルール、終了コードによるゲート。
sidebar:
  order: 8
---

CI での安全なデフォルトは、フレッシュネスをゲートする `check` を実行し、続けて heal もキャッシュの書き戻しも行わずに `run` を実行することである:

```bash
npx ambercast check
npx ambercast run
```

- `heal` はどこでも自動実行されることはなく、`ambercast.config.json` で `ci.heal: true` を明示的に指定しない限り CI では実行を拒否する（exit 2）。
- `run` によるグラウンディングキャッシュの変更は、その呼び出しで `--update-cache` を渡すか `ci.updateGroundingCache: true` を設定しない限り、CI では永続化されない — [書き戻しマトリクス](/ambercast/ja/guides/commands/#グラウンディングの書き戻し) を参照。
- パイプラインはプロセスの終了コードをゲートに使うこと（[終了コード](/ambercast/ja/guides/exit-codes/) を参照）。特に `4` は、コミット済みのプラン/グラウンディングがもうプロンプトと一致していないことを意味し、必要なのは再実行ではなく `generate` または `heal` である。
