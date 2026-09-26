---
layout: post
title: "学习笔记：AI Agent 中的沙箱与 Hook"
date: 2026-09-26 00:00:00 +0800
tags:
  - Agent
  - Codex
  - Claude Code
  - 学习笔记
description: "结合 Codex、Claude Code 与 Claude Agent SDK，理解沙箱、Hook、权限与审批的分工、执行边界和常见误区。"
categories: [技术]
permalink: /2026/09/26/agent-sandbox-and-hooks/
---

> 结合 Codex、Claude Code 与 Claude Agent SDK 官方文档整理。  
> 文档查阅日期：2026 年 9 月 26 日。产品配置和支持范围可能随版本变化。

## 1. 核心概念

**沙箱（Sandbox）控制执行环境的资源访问边界；Hook（钩子）在特定事件发生时自动执行预设逻辑。**

| 机制 | 核心问题 | 示例 |
|---|---|---|
| 提示词、项目说明 | 希望 Agent 怎样工作？ | 修改代码后运行测试 |
| Hook | 事件发生时自动执行什么？ | 文件编辑后触发格式检查 |
| 权限与审批 | 这次操作是否获准执行？ | 发布前请求用户批准 |
| 沙箱 | 程序实际能访问什么？ | 禁止修改项目外文件 |

记忆方式：**提示词指导行为，Hook 连接流程，审批管理授权，沙箱限制访问。**

## 2. 沙箱为什么存在？

Agent 的工作过程通常是：

```text
用户提出任务
    ↓
模型生成工具调用请求
    ↓
Agent 运行框架接收请求
    ↓
工具执行命令、读写文件或访问网络
    ↓
结果返回模型
```

模型提出操作，运行框架负责执行。沙箱主要限制执行中的程序，以及受其约束的子进程。

例如，我们可以设计这样的策略：

- 项目目录允许读写。
- 系统工具允许读取。
- 私钥目录禁止读取。
- 项目外目录禁止写入。
- 网络只允许访问指定服务。

即使模型误判，或者脚本内部执行了意料之外的操作，执行环境仍可拒绝越界访问。这是技术限制，不依赖模型是否记住了提示词。

上述只是策略示例，不能据此认为某个产品的默认配置已经实施了全部限制。[Codex 沙箱文档](https://learn.chatgpt.com/docs/sandboxing)

## 3. 沙箱的三个重要边界

**第一，沙箱不等于 Docker。**

沙箱可以通过操作系统机制、容器或虚拟机实现。不同方案的隔离范围、性能和维护成本不同。

**第二，沙箱不等于模拟执行。**

允许写入的项目文件可能是真实文件，修改会产生真实影响。沙箱本身通常不负责自动回滚，恢复需要依靠 Git、备份或快照。

**第三，沙箱的保护范围取决于哪些能力被放进其中。**

“命令运行在沙箱中”不等于“整个 Agent 的所有工具都在同一沙箱中”。远程服务、浏览器、文件工具等可能使用独立的权限控制。

Claude Code 官方文档明确区分了命令沙箱、内置文件工具和桌面操作的边界。[Claude Code 沙箱范围](https://code.claude.com/docs/en/sandboxing#scope)

## 4. Codex 中的沙箱与审批

Codex 把沙箱模式和审批策略分开配置。

```toml
sandbox_mode = "workspace-write"
approval_policy = "on-request"

[sandbox_workspace_write]
network_access = false
```

这段配置表达的意图是：

- 在工作区允许的范围内开展工作。
- 默认不给命令网络访问。
- 需要超出既有边界时，走授权流程。

常见沙箱模式：

| 模式 | 主要含义 |
|---|---|
| `read-only` | 允许读取、检查，不能直接写入文件 |
| `workspace-write` | 允许在工作区及配置允许的范围内写入 |
| `danger-full-access` | 移除 Codex 的沙箱限制 |

常见审批策略：

| 策略 | 主要含义 |
|---|---|
| `on-request` | 按需请求批准 |
| `never` | 不弹出审批请求 |

**`never` 不等于无限权限。**

“受限沙箱 + `never`”仍保留访问边界，只是不能通过审批请求扩大权限。审批策略与沙箱模式必须一起理解。[Codex 配置说明](https://learn.chatgpt.com/docs/sandboxing#configure-defaults)

## 5. Claude Code 与 Agent SDK 中的沙箱

Claude Code 可通过 `/sandbox` 配置命令沙箱，提供文件系统与网络隔离。

它区分两种方式：

- **Auto-allow**：符合沙箱条件的命令可自动获准，但仍有规则和例外。
- **Regular permissions**：命令即使处于沙箱内，也经过常规权限流程。

因此，**“是否隔离”和“是否询问用户”是不同问题。** [Claude Code 沙箱模式](https://code.claude.com/docs/en/sandboxing#sandbox-modes)

自己开发 Claude Agent SDK 应用时，还可以把整个应用放进容器或虚拟机：

```text
命令沙箱：约束 Agent 启动的命令
应用隔离：约束整个 SDK 应用及其执行环境
```

具体部署应分别考虑文件、网络、凭证和系统权限。[Claude Agent SDK 部署指南](https://code.claude.com/docs/en/agent-sdk/secure-deployment)

## 6. Hook 的工作原理

Hook 是运行框架预留的事件回调入口，通常包含三个部分：

```text
事件 Event
    → 什么时候触发？

匹配条件 Matcher
    → 哪些事件需要处理？

处理器 Handler
    → 触发后执行什么逻辑？
```

例如：

```text
事件：PreToolUse
匹配条件：Write 或 Edit
处理逻辑：检查目标路径，禁止修改 .env
```

运行框架自动触发检查，不需要模型每次主动决定“先检查一下”。

Hook 的处理器可以执行脚本、调用服务或运行回调函数；部分产品还支持调用模型判断。**事件触发可以由程序确定，但模型参与的判断仍可能具有不确定性。** [Claude Hook 使用指南](https://code.claude.com/docs/en/hooks-guide)

## 7. 常见 Hook 事件

| 事件 | 时机 | 典型用途 |
|---|---|---|
| `SessionStart` | 会话开始或恢复 | 加载项目背景 |
| `UserPromptSubmit` | 用户提交输入 | 检查输入、补充上下文 |
| `PreToolUse` | 工具执行之前 | 校验参数、阻止调用 |
| `PostToolUse` | 工具执行之后 | 记录结果、运行检查 |
| `Stop` | Agent 准备结束响应 | 检查完成条件 |
| `SessionEnd` | 会话结束 | 清理资源 |

需要特别区分：

- **前置 Hook** 可以在操作发生前拦截。
- **后置 Hook** 面对的是已经发生的操作，不能自动撤销副作用。
- **异步 Hook** 允许主流程继续，不能指望它及时阻止已经开始的操作。

具体事件支持的返回值和控制能力，以对应产品文档为准。[Claude Hook 事件参考](https://code.claude.com/docs/en/hooks)

## 8. 一个 Hook 示例及其局限

下面是概念伪代码：

```python
def before_tool_use(event):
    if event.tool_name in ["Write", "Edit"]:
        if filename(event.file_path) == ".env":
            return DENY("禁止修改 .env")

    return NO_DECISION
```

它表达了两个意思：

1. 对匹配到的文件工具调用进行检查。
2. 不匹配时不额外干预，继续其他权限检查。

**这个 Hook 不能保证 `.env` 在所有路径下都不可修改。**

如果 Bash 脚本或其他工具也能写入该文件，就需要额外覆盖那些访问路径，或使用相应的文件权限与沙箱限制。

Claude Agent SDK 中，对应机制是注册 `PreToolUse` 回调、设置匹配条件，并返回结构化决定。[Claude Agent SDK Hooks](https://code.claude.com/docs/en/agent-sdk/hooks)

## 9. Codex 与 Claude 的 Hook 差异

两者都支持生命周期 Hook，但配置不能直接视为完全兼容。

| 项目 | Codex | Claude Code / Agent SDK |
|---|---|---|
| 常见入口 | `hooks.json`、`config.toml` | settings 文件、SDK 的 `hooks` 选项 |
| 处理方式 | 命令、MCP 工具 | 命令、HTTP、MCP、提示词、Agent；SDK 还支持回调 |
| 使用前需核对 | 事件、工具覆盖、信任状态 | 事件、处理器类型、SDK 语言差异 |

当前 Codex 文档说明：`prompt`、`agent` 处理器会被解析但跳过执行；普通非托管 Hook 需要经过信任审查。

迁移 Hook 时，应逐项检查：**事件名、匹配条件、输入格式、输出协议、失败行为和工具覆盖范围。** [Codex Hooks](https://learn.chatgpt.com/docs/hooks)

## 10. 沙箱与 Hook 怎样配合？

以“修改接口并运行测试”为例：

```text
模型提出工具调用
    ↓
前置 Hook：检查参数或业务规则
    ↓
权限系统：判断是否获准
    ↓
工具在受限环境中执行
    ↓
沙箱：限制实际文件与网络访问
    ↓
后置 Hook：记录结果、触发检查
    ↓
Agent 继续工作或准备结束
```

这是概念流程，具体产品的内部顺序和分支可能不同。

各机制可以承担不同职责：

- 沙箱限制源码修改范围。
- Hook 检查工具参数、触发格式化或测试。
- 审批决定是否允许发布。
- Git 或快照负责恢复修改。

沙箱不能判断算法是否正确；测试通过也不代表业务逻辑完全正确。

## 11. 常见误区与复习问题

| 误区 | 正确理解 |
|---|---|
| 不询问用户就是没有沙箱 | 审批和沙箱是独立维度 |
| 工作目录是项目目录，就只能访问项目 | 工作目录本身不是访问控制 |
| 开启沙箱后不会修改真实文件 | 获准写入的文件仍会被真实修改 |
| Hook 返回成功就一定能执行 | 仍可能被权限系统或沙箱拒绝 |
| Hook 报错就一定阻止执行 | 取决于事件及失败协议 |
| 检查 `Write` 就覆盖所有文件修改 | 其他工具和程序可能有不同路径 |
| 后置 Hook 发现问题会自动回滚 | 已发生的副作用需要独立恢复机制 |

例如，Claude Code 的 `PreToolUse` 命令 Hook 可通过 `exit 2` 阻止调用；普通 `exit 1` 本身通常只产生非阻塞错误。超时、脚本缺失、输出格式错误也必须单独核对。[Hook 失败语义](https://code.claude.com/docs/en/hooks#exit-code-output)

复习时可以用三个问题检验理解：

1. **为什么 Hook 允许的操作仍可能失败？**  
   因为其他权限检查或底层沙箱仍可能拒绝。

2. **为什么沙箱允许的操作仍需要 Hook？**  
   因为资源访问获准，并不代表参数、流程或业务规则符合要求。

3. **为什么不能只写一句“不要读取敏感文件”？**  
   因为提示词指导模型行为，实际访问限制需要由执行环境实施。
