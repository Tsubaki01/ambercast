---
title: 产物
description: 每个生成文件是什么、是否应提交，以及 grounding.repositoryPolicy 开关。
sidebar:
  order: 6
---

| 文件 | 是什么 | 是否提交到 git？ |
| --- | --- | --- |
| `<name>.test.md` | 提示词 —— 可信来源 | 是 |
| `<name>.ambercast.plan.json` | 生成的执行计划 | 是（像复核锁文件一样复核它） |
| `<name>.ambercast.grounding.json` | 计划解析出的缓存选择器/状态 | 默认是（`grounding.repositoryPolicy: "committed"`） |
| `tests/ambercast/.runs/<invocation-id>/...` | 单次运行的证据与 `report.json`（位置由 `runsDir` 决定） | 否 —— 将此目录加入 gitignore |

计划与定位缓存文件位于 `testDir` 下、与其提示词相邻的位置。运行证据位于 `runsDir` 下，其默认值为 `tests/ambercast/.runs`（在 `testDir` 内部），而不是项目根目录下的 `.runs`。

## 提交策略

计划和定位缓存设计上就是要像锁文件一样被复核：`<name>.ambercast.plan.json` 的 diff 精确展示了生成的步骤如何变化，`<name>.ambercast.grounding.json` 的 diff 精确展示了解析出的选择器如何变化。

## `grounding.repositoryPolicy`

控制定位缓存是否被视为一个需要提交的产物：

- `"committed"`（默认）—— 定位缓存被要求出现在 git 中并与计划放在一起；`check` 会据此把没有定位缓存文件的新鲜计划归类为过期，而不仅仅是未缓存。
- `"uncommitted"` —— 定位缓存被视为本地的、可丢弃的状态（例如加入 gitignore）。在此策略下 `run` 仍会在本地写入和读取它；只是在全新检出时，`check` 不会要求它存在才能判定这对文件可信。

完整字段列表参见[配置参考](/ambercast/reference/configuration/)；定位缓存绝不会包含的内容参见[密钥](/ambercast/zh-cn/guides/secrets/)。
