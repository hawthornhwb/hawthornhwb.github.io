---
layout: post
title: "Codex 权限控制：底层原理学习笔记"
date: 2026-09-26 00:00:00 +0800
tags:
  - Agent
  - Codex
  - 权限控制
  - 学习笔记
description: "从运行时策略检查、操作系统沙盒与审批协议，理解 Codex 的请求批准、帮我批准和完全访问。"
categories: [技术]
permalink: /2026/09/26/codex-permission-control/
---

## 1. 核心架构

Codex 的权限控制由三个部分配合完成：

- **模型**：提出要执行的操作，例如运行命令、修改文件。
- **运行时（Runtime / Harness）**：检查策略、处理审批、调度工具。
- **操作系统沙盒**：对实际运行的进程强制限制文件和网络访问。

模型提出操作，并不等于操作已经获得执行权限。运行时决定是否执行以及如何执行，沙盒约束执行过程中能访问的资源。[官方沙盒文档](https://learn.chatgpt.com/docs/sandboxing)

简化流程：

```text
模型提出工具调用
        ↓
运行时检查配置与执行规则
        ├─ 当前权限允许 → 在沙盒内执行
        ├─ 需要审批 → 用户或审核代理决定 → 按批准范围执行
        └─ 明确禁止 → 拒绝执行
        ↓
执行结果或权限错误返回模型
```

这是概念流程，实际顺序会随工具和审批类型变化。

## 2. 三个权限选项对应什么

权限设置可以拆成三个独立维度：

| 维度 | 配置项 | 控制内容 |
|---|---|---|
| 执行范围 | `sandbox_mode` | 文件系统和网络等资源边界 |
| 审批策略 | `approval_policy` | 什么时候需要暂停并请求批准 |
| 审批人 | `approvals_reviewer` | 由用户还是审核代理作出决定 |

三个常见预设的对应关系：

| 选项 | 沙盒 | 审批策略 | 审批人 |
|---|---|---|---|
| 请求批准 | `workspace-write` | `on-request` | `user` |
| 帮我批准 | `workspace-write` | `on-request` | `auto_review` |
| 完全访问 | `danger-full-access` | `never` | 不经过上述审批 |

**前两个选项主要改变审批人；完全访问同时改变执行边界和审批策略。** 自定义配置与组织要求可能进一步限制实际权限。[官方配置说明](https://learn.chatgpt.com/docs/sandboxing#configure-defaults)

## 3. 第一层：运行时的策略检查

运行时接收工具调用参数，例如：

```text
命令：python update_config.py
工作目录：/project
额外权限请求：……
```

它结合当前权限配置和执行规则处理请求。

官方 `execpolicy` 支持按命令参数前缀匹配，产生三种结果：

- `allow`：允许匹配的命令在沙盒外执行，无须提示。
- `prompt`：要求审批。
- `forbidden`：禁止执行。

多个规则命中时，采用最严格的结果：

```text
forbidden > prompt > allow
```

对于可安全解析的复合 shell 命令，Codex 使用 tree-sitter 拆分检查，避免仅凭第一条命令就放行整段脚本。复杂脚本则按整个调用处理。[官方 Rules 文档](https://learn.chatgpt.com/docs/agent-configuration/rules)

**局限：规则匹配无法完整预测任意程序运行后的行为。** 一条 Python 命令可能在脚本内部读写文件、启动子进程，因此还需要执行阶段的强制约束。

## 4. 第二层：操作系统沙盒

沙盒在程序实际访问资源时实施限制。

| 平台 | 官方披露的实现 |
|---|---|
| macOS | Seatbelt 策略，通过 `sandbox-exec` 执行 |
| Linux | 默认使用 `bubblewrap（bwrap）` 和 `seccomp` |
| Windows | 原生 Windows 沙盒；WSL2 使用 Linux 方案 |

这些限制适用于命令及其子进程。[官方底层实现说明](https://learn.chatgpt.com/docs/agent-approvals-security#os-level-sandbox)

例如，一个脚本尝试写入不允许修改的路径：

```text
脚本发起写入
    ↓
操作系统检查沙盒权限
    ↓
拒绝访问
    ↓
错误返回 Codex
```

模型即使没有提前识别这次越界，写入仍可以被系统拦截。沙盒依靠资源访问规则执行限制，无须理解脚本的业务目的。

## 5. “请求批准”：运行时等待结构化决策

审批界面背后有明确的通信协议。

以官方 App Server 的命令审批为例：

1. 服务器发出 `item/commandExecution/requestApproval`。
2. 请求携带命令、工作目录、原因及关联操作标识等信息。
3. 客户端展示审批界面。
4. 用户选择后，客户端返回 `accept`、`acceptForSession`、`decline` 等决定。
5. 服务器据此继续或拒绝操作。

因此，点击“批准”会产生被运行时处理的结构化结果。授权范围可以是单次操作、会话或具体资源；批准一次不必把整个会话变成完全访问。[官方审批协议](https://learn.chatgpt.com/docs/app-server#approvals)

## 6. “帮我批准”：独立代理负责审核

这个模式保留原有沙盒，把符合条件的审批请求交给独立审核代理。

审核代理通常能看到：

- 精简的对话记录与用户要求。
- 待审批的具体操作。
- 相关工具调用及输出。

必要时，它也可以做只读检查。随后返回批准或拒绝及理由，运行时执行该决定。被拒绝的操作不会执行，主代理需要寻找更安全的方案或询问用户。[官方自动审核文档](https://learn.chatgpt.com/docs/sandboxing/auto-review)

两种检查的职责不同：

| 机制 | 主要回答的问题 |
|---|---|
| 沙盒 | 这个进程能否访问该资源？ |
| 审核代理 | 这个操作是否符合授权和审核政策？ |

自动审核只处理需要审批的操作。已经允许在沙盒内执行的操作，不会全部重新审核。审核代理也可能判断错误，官方不将其视为确定性的安全保证。[自动审核的限制](https://learn.chatgpt.com/docs/sandboxing/auto-review#limits)

## 7. “完全访问”：取消 Codex 的沙盒限制

完全访问对应：

```toml
sandbox_mode = "danger-full-access"
approval_policy = "never"
```

两项配置分别表示：

- 不使用 Codex 自己的文件系统和网络沙盒边界。
- 不暂停请求相应的执行审批。

这里需要区分：

```text
never = 不询问
danger-full-access = 不施加 Codex 沙盒限制
```

**单独设置 `never` 不等于全部允许。** 与受限沙盒组合时，越界操作仍会被限制。[官方说明](https://learn.chatgpt.com/docs/sandboxing#configure-defaults)

完全访问也不等于自动获得管理员身份。操作仍受操作系统账号、外部环境，以及各工具自身权限约束。

## 8. 容易误解的边界

**沙盒允许，不代表业务上正确。**  
如果某个文件本来就允许写入，错误覆盖它也可能符合沙盒权限。沙盒控制访问范围，无法保证每次修改都符合用户意图。

**网络权限不是整个产品的统一开关。**  
本地命令的网络限制，与网页搜索、MCP、连接器、浏览器等工具的权限控制分别管理。[官方网络控制范围](https://learn.chatgpt.com/docs/agent-approvals-security#traffic-outside-the-command-network-proxy)

**自动审核不等于自动同意。**  
它增加了对操作含义和授权的判断，但仍需要沙盒作为独立的执行边界。

学习时可以用三个问题分析任何权限设置：**允许访问什么资源？什么操作需要审批？由谁作出审批决定？**

---

文档查阅日期：2026-09-26。具体配置、接口与实现可能随版本变化，使用时应核对对应版本的官方文档。

