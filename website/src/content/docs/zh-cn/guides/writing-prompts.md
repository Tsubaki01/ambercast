---
title: 编写提示词
description: .test.md 提示词文件格式、自然语言语句，以及密钥授予行。
sidebar:
  order: 3
---

提示词是一个名为 `<name>.test.md` 的 Markdown 文件。它是唯一的可信来源：`ambercast generate` 读取它来生成执行计划，且只有当提示词的有意义内容发生变化时，计划才会被重新生成。

## 结构

- 一个标题（H1），命名该测试用例。
- 一条或多条自然语言语句，用平实的句子描述应发生的行为 —— 没有特殊语法或 DSL。

```markdown
# Sign in

When I submit valid credentials, I reach the dashboard.
```

Markdown 在被纳入计划的溯源信息之前只会经过最小限度的规范化：会去除开头的字节顺序标记（BOM），并把行尾转换为 LF，但不会做任何裁剪、重排或改写。按你希望它被读取的样子来写提示词。

## 密钥：授予行

提示词和执行计划中不得包含字面量凭据。请以 `{{secrets.name}}` 的形式引用密钥，并用独占一行的授予行显式授权其使用 —— 该行必须位于任何代码块之外：

```markdown
@ambercast-secret {{secrets.password}}
```

一个没有匹配授予行的密钥引用会直接失败，而不是被默默放行。完整的解析与脱敏约定参见[密钥](/ambercast/zh-cn/guides/secrets/)。

## 一个实际的例子

```markdown
# Sign in with a saved password

@ambercast-secret {{secrets.password}}

When I submit the username "demo@example.com" and the password {{secrets.password}}, I reach the dashboard.
```

下一步：运行 `ambercast generate` 和 `ambercast run` —— 参见[命令](/ambercast/zh-cn/guides/commands/)。
