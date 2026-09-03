---
title: CI 使用
description: 安全的默认 CI 流水线、CI 中的 heal 拒绝、缓存写回规则，以及退出码门禁。
sidebar:
  order: 8
---

在 CI 中一种安全的默认做法是：先用 `check` 做新鲜度门禁，再运行 `run`，且不启用修复或缓存写回：

```bash
npx ambercast check
npx ambercast run
```

- `heal` 不会在任何地方自动运行，并且除非在 `ambercast.config.json` 中显式设置 `ci.heal: true` 选择加入，否则它在 CI 中会完全拒绝运行（退出码 2）。
- 除非为该次调用传入 `--update-cache`，或设置 `ci.updateGroundingCache: true`，否则 `run` 产生的定位缓存改动不会在 CI 中被持久化 —— 参见[写回矩阵](/ambercast/zh-cn/guides/commands/#定位缓存写回)。
- 请以进程退出码作为流水线的判定依据（参见[退出码](/ambercast/zh-cn/guides/exit-codes/)）；其中 `4` 尤其意味着已提交的执行计划/定位缓存已不再匹配提示词，需要执行 `generate` 或 `heal`，而不是简单地重新运行。
