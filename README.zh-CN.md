[English](README.md) | [日本語](README.ja.md) | 简体中文

# ambercast

提示词原生的 E2E 测试。

[![npm version](https://img.shields.io/npm/v/ambercast)](https://www.npmjs.com/package/ambercast)
[![CI](https://github.com/kotarotsubaki/ambercast/actions/workflows/ci.yml/badge.svg)](https://github.com/kotarotsubaki/ambercast/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node >= 22.14](https://img.shields.io/badge/node-%3E%3D22.14-brightgreen)

用自然语言 Markdown 提示词编写测试用例——提示词本身就是唯一真实来源（single source of truth）。AI 生成器会把每条提示词转换成确定性的、类似锁文件（lockfile）的执行计划（plan）。此后每次运行都会重放这份计划，**零 AI 调用**：快、免费、完全可复现。当应用的 UI 发生漂移（drift）时，计划会自我修复；当测试的*语义*发生变化时，则会请人来复核。

就像琥珀中封存的昆虫，你测试的意图只需铸造一次便被完整保留——无论表层如何变化。

> [!NOTE]
> ambercast 目前是 pre-1.0 版本，仍在积极开发中。参见[状态与限制](#状态与限制)。

**完整文档：** https://kotarotsubaki.github.io/ambercast/zh-cn/ （English / 日本語 / 简体中文）

## 安装

```bash
npm install -D ambercast
```

或者无需安装直接运行：

```bash
npx ambercast <command>
```

你需要 Node.js >= 22.14、Chromium 二进制文件（`npx playwright-core install chromium`），以及一个已通过身份验证的 AI 提供方 CLI，即 [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) 或 [Codex CLI](https://github.com/openai/codex)（ambercast 不管理凭据；请自备密钥）——参见[入门指南](https://kotarotsubaki.github.io/ambercast/zh-cn/guides/getting-started/)。

## 快速开始

目前尚无 `init` 命令；你只需要一个提示词文件，默认配置假定你的应用运行在 `http://localhost:3000`（参见[配置](https://kotarotsubaki.github.io/ambercast/zh-cn/reference/configuration/)）。

1. 在 `tests/ambercast/sign-in.test.md` 编写测试提示词：

   ```markdown
   # Sign in

   When I submit valid credentials, I reach the dashboard.
   ```

2. 生成计划，然后运行它：

   ```bash
   npx ambercast generate
   npx ambercast run
   ```

`generate` 会在提示词旁写入 `sign-in.ambercast.plan.json` 和 `sign-in.ambercast.grounding.json`；将这三个文件全部提交。此后每次 `run` 都会重放该计划，零 AI 调用——参见[编写提示词](https://kotarotsubaki.github.io/ambercast/zh-cn/guides/writing-prompts/)指南。

## 了解更多

- [命令](https://kotarotsubaki.github.io/ambercast/zh-cn/guides/commands/) — generate、run、check 和 heal 命令概览。
- [退出代码](https://kotarotsubaki.github.io/ambercast/zh-cn/guides/exit-codes/) — 退出代码 0–5 以及混合批次结果的优先级顺序。
- [工件](https://kotarotsubaki.github.io/ambercast/zh-cn/guides/artifacts/) — 哪些生成的文件需要提交，哪些需要加入 gitignore。
- [机密](https://kotarotsubaki.github.io/ambercast/zh-cn/guides/secrets/) — 凭据如何在不进入提示词或计划的情况下传递给测试。
- [CI 使用](https://kotarotsubaki.github.io/ambercast/zh-cn/guides/ci/) — 在 CI 上运行以及为何在 CI 中禁用 heal。
- [配置参考](https://kotarotsubaki.github.io/ambercast/zh-cn/reference/configuration/) — `ambercast.config.json` 每个字段的完整参考。

## 状态与限制

ambercast 目前是 **0.x、pre-1.0** 版本：破坏性变更可能出现在次版本（minor release）中。当前范围：

- 仅支持 Chromium（Firefox 与 WebKit 在计划中）。
- 仅支持本地执行——没有托管的 runner。
- 尚无 `init` 命令——需手动搭建配置与提示词（参见[快速开始](#快速开始)）。
- 尚无结果查看器（viewer）。
- 尚无 MCP server。

## 贡献

欢迎提交 Bug 报告和 PR；请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，其中涵盖了 PR 标题规范、日常脚本，以及 AGENTS.md 中维护者的 AI 自动化与外部贡献的关系（它不是前置条件）。

## 许可证

MIT——参见 [LICENSE](LICENSE)。
