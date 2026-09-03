---
title: 成果物
description: 生成される各ファイルが何であるか、git にコミットすべきか、そして grounding.repositoryPolicy の切り替え。
sidebar:
  order: 6
---

| ファイル | 何であるか | git にコミットするか |
| --- | --- | --- |
| `<name>.test.md` | プロンプト — 唯一の信頼できる情報源 | する |
| `<name>.ambercast.plan.json` | 生成された実行プラン | する（ロックファイルのようにレビューすること） |
| `<name>.ambercast.grounding.json` | プランが解決したキャッシュ済みセレクタ/状態 | デフォルトでする（`grounding.repositoryPolicy: "committed"`） |
| `tests/ambercast/.runs/<invocation-id>/...` | 呼び出しごとのエビデンスと `report.json`（場所は `runsDir`） | しない — このディレクトリは gitignore すること |

プランとグラウンディングファイルは、`testDir` 配下のプロンプトと同じ場所に置かれる。実行エビデンスは `runsDir` 配下に置かれ、これはプロジェクトルートの `.runs` ではなく `tests/ambercast/.runs`（`testDir` 内）がデフォルトである。

## コミット方針

プランとグラウンディングキャッシュは、ロックファイルのようにレビューされることを前提としている: `<name>.ambercast.plan.json` の diff は生成されたステップがどう変わったかを正確に示し、`<name>.ambercast.grounding.json` の diff は解決されたセレクタがどう変わったかを正確に示す。

## `grounding.repositoryPolicy`

グラウンディングキャッシュをコミット済みの成果物として扱うかどうかを制御する:

- `"committed"`（デフォルト） — グラウンディングキャッシュは git 上でプランと並んで存在することが期待される。`check` はこれを使って、グラウンディングファイルの無い新しいプランを、単なる未キャッシュではなく古い（stale）ものとして分類する。
- `"uncommitted"` — グラウンディングキャッシュはローカルな使い捨て状態（例えば gitignore 済み）として扱われる。このポリシーでも `run` はローカルでそれを書き込み・読み込みする。ただし、フレッシュな checkout でペアが信頼できると `check` が判断するために存在している必要はない。

フィールドの全リストは [設定リファレンス](/ambercast/ja/reference/configuration/) を、グラウンディングキャッシュが決して含まないものについては [シークレット](/ambercast/ja/guides/secrets/) を参照。
