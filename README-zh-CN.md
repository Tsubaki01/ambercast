[English](README.md) | [日本語](README-ja.md) | 简体中文

# ambercast

提示词原生的 E2E 测试。

[![npm version](https://img.shields.io/npm/v/ambercast)](https://www.npmjs.com/package/ambercast)
[![CI](https://github.com/kotarotsubaki/ambercast/actions/workflows/ci.yml/badge.svg)](https://github.com/kotarotsubaki/ambercast/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node >= 22.14](https://img.shields.io/badge/node-%3E%3D22.14-brightgreen)

您可以使用自然语言 Markdown 提示词编写测试用例——提示词本身即是唯一真实来源（single source of truth）。AI 生成器会将每条提示词转换成确定性的、类似锁文件（lockfile）的执行计划（plan）。此后每次运行都会重放这份计划，实现**零 AI 调用**：快速、免费且完全可复现。当应用的 UI 发生漂移（drift）时，计划会进行自我修复；当测试的*语义*发生变化时，则会请您介入复核。

就像琥珀中封存的昆虫一样，您测试的意图只需铸造一次便被完整保留——无论表层如何变化。

> [!NOTE]
> ambercast 目前处于 pre-1.0 版本，仍在积极开发中。详情请参见[状态与限制](#状态与限制)。

**完整文档：** https://kotarotsubaki.github.io/ambercast/zh-cn/ （English / 日本語 / 简体中文）

## 安装

```bash
npm install -D ambercast
```

或者，您也可以无需安装直接运行：

```bash
npx ambercast <command>
```

使用前提为 Node.js >= 22.14、Chromium（`npx playwright-core install chromium`）以及已完成身份验证的 [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) 或 [Codex CLI](https://github.com/openai/codex)；ambercast 本身不管理凭据（请自备密钥），详情请参见[入门指南](https://kotarotsubaki.github.io/ambercast/zh-cn/guides/getting-started/)。

## 快速开始

目前尚无 `init` 命令，您只需准备一个提示词文件即可开始，默认假定应用运行在 `http://localhost:3000`（详情请参见[配置](https://kotarotsubaki.github.io/ambercast/zh-cn/reference/configuration/)）。

1. 在 `tests/ambercast/sign-in.test.md` 中编写测试提示词：

   ```markdown
   # Sign in

   When I submit valid credentials, I reach the dashboard.
   ```

2. 生成计划并运行：

   ```bash
   npx ambercast generate
   npx ambercast run
   ```

`generate` 会在提示词旁边生成 `sign-in.ambercast.plan.json` 和 `sign-in.ambercast.grounding.json`，请将这三个文件都提交到 git。此后每次 `run` 只要缓存的 grounding 完整，就仅重放该计划且零 AI 调用；缺失 grounding 的步骤会回退到 AI，加上 `--cache-only` 则会直接失败；详情请参见[编写提示词](https://kotarotsubaki.github.io/ambercast/zh-cn/guides/writing-prompts/)指南。

## 了解更多

- [命令指南](https://kotarotsubaki.github.io/ambercast/zh-cn/guides/commands/) — 介绍 generate、run、check 与 heal 命令的用法说明
- [退出码](https://kotarotsubaki.github.io/ambercast/zh-cn/guides/exit-codes/) — 详细说明 0 至 5 退出码含义及批次结果混合时的优先级判定
- [生成文件](https://kotarotsubaki.github.io/ambercast/zh-cn/guides/artifacts/) — 说明哪些生成文件应提交至 git，哪些应加入 gitignore
- [机密凭据](https://kotarotsubaki.github.io/ambercast/zh-cn/guides/secrets/) — 介绍确保凭据不进入提示词或计划的安全传递方式
- [CI 运行](https://kotarotsubaki.github.io/ambercast/zh-cn/guides/ci/) — 介绍在 CI 环境运行测试的方法，以及在 CI 中阻止 heal 的机制
- [配置参考](https://kotarotsubaki.github.io/ambercast/zh-cn/reference/configuration/) — 完整列出 `ambercast.config.json` 配置文件所支持的全部字段

## 状态与限制

ambercast 目前处于 **0.x、pre-1.0** 版本：破坏性变更可能会出现在次版本（minor release）中。当前支持范围如下：

- 目前仅支持 Chromium（对 Firefox 与 WebKit 的支持已在计划中）。
- 目前仅支持本地执行——暂不提供托管的 runner。
- 暂未提供 `init` 命令——请手动搭建配置与提示词。
- 暂未提供结果查看器（viewer）。
- 暂未提供 MCP server。

## 贡献

欢迎您提交 Bug 报告和 PR。请您先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，其中说明了 PR 标题规范、日常脚本，以及 AGENTS.md 中维护者的 AI 自动化与外部贡献的关系（并非前置条件）。

## 许可证

MIT——详情请参见 [LICENSE](LICENSE)。
