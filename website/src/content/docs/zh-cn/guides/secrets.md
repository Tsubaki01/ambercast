---
title: 密钥
description: 密钥引用语法 {{secrets.name}}、环境变量映射、授予以及脱敏。
sidebar:
  order: 7
---

提示词和执行计划中不得包含字面量凭据。请以 `{{secrets.name}}` 的形式引用密钥，并从环境变量 `AMBERCAST_SECRET_NAME` 中解析（点号变为下划线，全部大写 —— 因此 `{{secrets.api.key}}` 会解析 `AMBERCAST_SECRET_API_KEY`）。

## 授予行

密钥引用只有在提示词中显式授予时才会生效，授予语句需独占一行且位于代码块之外：

```markdown
@ambercast-secret {{secrets.password}}
```

位于围栏代码块、缩进代码块或行内代码片段中的授予行不具备授权效力 —— 它只是文档说明，不是授予。

## 失败关闭（Fail-closed）错误

- 生成的执行计划如果内嵌了一个形似字面量密钥的值（`sk-...`、`ghp_...`、AWS access key，或其他高熵 token）而非一个引用，会被拒绝（`secret-literal-rejected`，退出码 2）。
- 一个被引用的密钥若没有匹配的授予行，或没有匹配的环境变量，会直接失败（`secret-grant-unattributable` / `secret-unresolved`，退出码 2），而不是悄悄放行。

## 脱敏

已解析的密钥值在写入或打印之前，会先从捕获的证据、报告和错误输出中被脱敏。

完整示例参见[编写提示词](/ambercast/zh-cn/guides/writing-prompts/)。
