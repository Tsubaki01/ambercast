---
title: 快速开始
description: ambercast 的环境要求、安装方式以及快速上手演练。
sidebar:
  order: 2
---

## 环境要求

- Node.js >= 22.14
- 一个 [Playwright](https://playwright.dev) 可用的 Chromium 二进制文件：

  ```bash
  npx playwright-core install chromium
  ```

- 一个已安装并完成身份验证的 AI 提供方 CLI —— 密钥自备，ambercast 不管理凭据：
  - [Claude Code CLI](https://docs.claude.com/en/docs/claude-code)（`claude`），或
  - [Codex CLI](https://github.com/openai/codex)（`codex`）

  默认情况下（`ai.provider: "auto"`）ambercast 会依次探测 `claude` 和 `codex`，使用先响应的那个；也可以传 `--ai claude` / `--ai codex`，或在配置中设置 `ai.provider` 来固定使用某一个。

## 安装

```bash
npm install -D ambercast
```

或者不安装直接运行：

```bash
npx ambercast <command>
```

## 快速开始

目前还没有 `init` 命令，需要手动搭建这两部分。

1. 在项目根目录创建 `ambercast.config.json`（可选 —— 以下即默认值）：

   ```json
   {
     "testDir": "tests/ambercast",
     "targets": {
       "web-user": { "baseUrl": "http://localhost:3000", "browser": "chromium" }
     }
   }
   ```

2. 在 `tests/ambercast/sign-in.test.md` 编写测试提示词：

   ```markdown
   # Sign in

   When I submit valid credentials, I reach the dashboard.
   ```

3. 生成执行计划，然后运行它：

   ```bash
   npx ambercast generate
   npx ambercast run
   ```

## 会写入并提交哪些文件

`generate` 会在提示词旁生成 `tests/ambercast/sign-in.ambercast.plan.json` 和 `tests/ambercast/sign-in.ambercast.grounding.json`。请将这三个文件一并提交 —— 完整说明与提交策略参见[产物](/ambercast/zh-cn/guides/artifacts/)。

下一步：[编写你自己的提示词](/ambercast/zh-cn/guides/writing-prompts/)，或阅读[命令参考](/ambercast/zh-cn/guides/commands/)。
