---
title: 简介
description: ambercast 是什么、为什么存在，以及 generate/run/heal 循环的工作方式。
sidebar:
  order: 1
---

用自然语言 Markdown 提示词编写测试用例 —— 提示词是唯一的可信来源。AI 生成器会将每个提示词转换为确定性的、类似锁文件的执行计划（plan）。此后的运行以 **零 AI 调用** 方式回放：快速、免费、完全可复现。当应用的 UI 发生漂移时，计划会自我修复；当测试的*语义*发生变化时，则会请人来复核。

:::note
ambercast 目前是 pre-1.0 版本，仍在积极开发中。参见[状态与限制](#状态与限制)。
:::

## 工作原理

```text
sign-in.test.md
      │  ambercast generate（AI 调用，仅一次）
      ▼
sign-in.ambercast.plan.json  +  sign-in.ambercast.grounding.json
      │  两者一并提交到 git
      ▼
ambercast run（重放 —— 零 AI 调用）
      │
      ├─ grounding 命中  → 确定性重放
      ├─ grounding 未命中 → 实时 AI 辅助执行该步骤，并更新缓存（可用 git diff 查看）
      └─ 检测到漂移 → ambercast heal 修复计划（需人工确认）
```

1. **Generate（生成）** —— AI 提供方读取一次提示词，生成一份执行计划（要执行的步骤）和一份定位缓存（grounding，即它找到的具体选择器/坐标）。两者都是纯 JSON，设计上就是要被提交并像锁文件一样被复核。
2. **Run（运行）** —— 使用缓存的定位缓存在真实浏览器中重放执行计划，happy path 上不产生任何 AI 调用。某一步骤的定位缓存未命中时，仅针对该步骤回退到实时 AI 辅助解析（可用 `--cache-only` 跳过这一行为）。
3. **Heal（修复）** —— 当 UI 漂移到重放无法自行恢复的程度时，`ambercast heal` 会重新解析、修复或重新生成受影响的计划步骤，并在写入前请求确认。

## 状态与限制

ambercast 目前是 **0.x、pre-1.0** 版本：破坏性变更可能出现在次版本发布中。当前范围：

- 仅支持 Chromium（Firefox 与 WebKit 在计划中）。
- 仅支持本地执行 —— 没有托管的运行器。
- 尚无 `init` 命令 —— 需手动搭建配置与提示词（参见[快速开始](/ambercast/zh-cn/guides/getting-started/)）。
- 尚无结果查看器。
- 尚无 MCP server。
