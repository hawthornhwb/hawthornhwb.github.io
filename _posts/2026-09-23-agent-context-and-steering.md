---
layout: post
title: "Claude Code 官方文档学习笔记：上下文管理与运行中消息处理"
date: 2026-09-23 00:00:00 +0800
description: "整理 Claude Code 官方文档中的按需加载、会话压缩、Memory、子 Agent 上下文，以及消息排队、中断和 Hook 的行为。"
categories: [技术]
tags: [Claude Code, 官方文档, 上下文管理, 学习笔记]
permalink: /2026/09/23/agent-context-and-steering/
---

这篇笔记整理 Claude Code 官方文档中的两个主题：**上下文窗口如何管理，以及执行过程中如何接收新的用户消息。**

文档阅读日期为 2026 年 9 月 23 日。下文记录公开说明的产品行为，不推断内部源码实现；具体限制、快捷键和默认行为以对应版本文档为准。

## 一、执行循环与上下文

Claude Code 官方将模型外面的运行层称为 *agentic harness*。它提供工具，并管理模型能够看到的上下文。

任务通常在三个阶段之间循环：收集上下文、采取行动、验证结果。工具返回的信息会影响下一步决策。上下文包含会话、文件内容、命令输出、项目指令、Memory、已加载的 Skills 和系统指令。

Claude Code 还会将消息、工具调用和结果保存为本地会话记录，支持恢复或分叉会话。新会话不会自动继承此前会话的全部历史，可以通过项目指令与 Auto memory 保留跨会话信息。

来源：[How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)。

## 二、按需加载 Skills 与工具

Skills 的描述用于帮助 Claude 判断何时使用某项能力；完整正文在调用 Skill 时才加载。较长的参考内容可以放在支持文件中，需要时再读取。

对于只希望手动调用的 Skill，可以设置 `disable-model-invocation: true`，避免模型自行调用，并使其描述不在启动时占用上下文。

来源：[Skills](https://code.claude.com/docs/en/skills)。

MCP 工具定义默认可以通过工具搜索按需加载。在使用具体工具之前，通常先保留工具名称和服务端指令，减少完整工具定义的预先加载。

来源：[Manage context with skills and subagents](https://code.claude.com/docs/en/how-claude-code-works#manage-context-with-skills-and-subagents)。

## 三、会话压缩与内容重新加载

接近上下文限制时，Claude Code 会先清理较早的工具输出，必要时再总结会话。较早的详细指令仍可能丢失，因此官方建议把持久规则放在 `CLAUDE.md` 中。

可以运行 `/compact` 手动压缩，并指定保留重点；也可以在 `CLAUDE.md` 中添加压缩指导。若单个过大的文件或工具输出导致反复压缩后立即填满窗口，Claude Code 会在多次尝试后报错，避免持续循环。

来源：[When context fills up](https://code.claude.com/docs/en/how-claude-code-works#when-context-fills-up)。

压缩后的处理依内容来源而不同：

| 内容 | 压缩后的行为 |
| --- | --- |
| 系统提示与输出风格 | 继续生效 |
| 根目录 `CLAUDE.md` 与无路径限制的规则 | 从磁盘重新注入 |
| Auto memory 与计划文件 | 重新注入 |
| Git 状态 | 重新读取 |
| 路径规则与子目录 `CLAUDE.md` | 读取相关文件时重新加载 |
| 已调用 Skill 正文 | 在预算限制内重新注入 |
| 部分近期文件 | 重新读取，过大时保留路径引用 |
| 后台命令与后台子 Agent | 继续运行，并保留运行提醒 |
| 先前 Hook 添加的上下文 | 随会话一起总结 |

来源：[What survives compaction](https://code.claude.com/docs/en/context-window#what-survives-compaction)。

## 四、项目指令与 Auto memory

官方将 `CLAUDE.md` 与 Auto memory 分开说明：

| 类型 | 维护者 | 主要内容 |
| --- | --- | --- |
| `CLAUDE.md` | 用户 | 项目约定、工作流程和指令 |
| Auto memory | Claude | 偏好、纠正、经验与项目相关信息 |

Auto memory 使用 `MEMORY.md` 作为索引，并把详细内容保存到主题文件。按当前文档，启动时读取索引的前 200 行或前 25KB，以先达到的限制为准；详细主题文件在需要时读取。

Auto memory 保存在本机，同一 Git 仓库的 worktree 和子目录共享对应记忆目录，不会自动跨机器或云环境同步。

`CLAUDE.md` 属于提供给模型的上下文，而不是强制执行的配置。官方建议保持指令具体、简洁、结构清楚。

来源：[How Claude remembers your project](https://code.claude.com/docs/en/memory)。

## 五、子 Agent 的上下文隔离

官方区分普通子 Agent 与 fork：

| 类型 | 初始上下文 |
| --- | --- |
| 非 fork 子 Agent | 从独立上下文开始，接收委派任务及自身配置 |
| Fork | 继承创建时的父会话上下文 |

非 fork 子 Agent 不会自动看到主会话之前读过的文件、调用过的 Skills 和全部历史。Fork 则从父会话的副本开始。

子 Agent 后续的工具调用与大量读取保留在自己的上下文中，完成后向主会话返回结果摘要。因此，“是否继承创建时的上下文”和“后续是否使用独立上下文”是两个需要分别理解的行为。

来源：[Subagents — What loads at startup](https://code.claude.com/docs/en/sub-agents#what-loads-at-startup)。

## 六、Prompt caching 与压缩的区别

Prompt caching 通过复用相同请求前缀，降低重复输入的处理成本与延迟。Claude Code 会尽量将稳定内容放在请求前部，将持续变化的会话放在后部。

官方文档描述的内容顺序包括：

1. 系统提示和工具定义。
2. 项目上下文，例如 `CLAUDE.md`、Auto memory 和无路径限制的规则。
3. 用户消息、模型回答与工具结果。

前缀发生变化时，其后的缓存匹配会受到影响。缓存与上下文压缩用途不同：缓存复用计算，压缩改变当前携带的会话内容。缓存命中不等于上下文窗口被扩大。

来源：[How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching)。

## 七、执行中的消息排队与中断

工作中输入普通消息并按 Enter，Claude Code 会先将其排队，而不是直接中断当前回合。

消息的交付时机取决于内容与执行状态：

| 情况 | 官方描述的行为 |
| --- | --- |
| 工具调用期间提交普通消息 | 当前这些工具调用结束后交给模型，可以在同一回合处理 |
| 回合结束时仍有排队消息 | 按提交顺序自动发送 |
| 排队的命令或 Shell 命令 | 通常等回合结束，再依次执行；部分命令例外 |
| 按 `Esc` | 中断当前执行；已排队消息随后处理 |
| 按 `Ctrl+Enter` | 中断并立即发送排队消息，草稿也随之排队 |

`Ctrl+Enter` 的上述行为要求 v2.1.275 或更新版本，并取决于终端按键支持；文档也提供 `Ctrl+X Ctrl+S` 作为替代。Shell 模式的行为存在例外，应以交互文档为准。

来源：[Queue messages while Claude works](https://code.claude.com/docs/en/interactive-mode#queue-messages-while-claude-works)。

这些说明确认了消息的交付时机，但没有给出普通消息队列的完整源码结构，不能据此断言它一定修改某个 system prompt 或使用某种固定内部封装。

## 八、UserPromptSubmit Hook 与 Checkpoint

### UserPromptSubmit Hook

`UserPromptSubmit` 在用户提交提示、Claude 处理它之前运行，可以校验提示、阻止提示或补充上下文。

Hook 可以通过纯文本输出或 JSON 中的 `additionalContext` 添加内容；使用 `decision: "block"` 可以阻止提示进入处理。Hook 添加上下文与普通用户消息排队是不同的机制。

来源：[Hooks — UserPromptSubmit](https://code.claude.com/docs/en/hooks#userpromptsubmit)。

### Checkpoint 的范围

Checkpoint 用于恢复受支持的文件编辑，并支持通过 rewind 回到此前状态。它不是 Git 的替代品，也不能覆盖所有修改。

官方明确指出，通过 Bash 命令产生的文件修改不受同样的追踪，例如命令执行的删除、移动和复制。停止执行与恢复文件是不同操作，不能把中断理解为自动回滚。

来源：[Checkpointing](https://code.claude.com/docs/en/checkpointing#limitations)。

## 九、阅读时需要区分的概念

| 概念 | 主要用途 |
| --- | --- |
| 当前上下文 | 本次模型调用能够使用的信息 |
| 会话压缩 | 减少当前携带的历史内容 |
| Auto memory | 保存可跨会话复用的信息 |
| Prompt caching | 复用重复前缀的计算 |
| 子 Agent 上下文 | 隔离子任务的后续处理过程 |
| 消息排队 | 控制新增消息何时交给模型 |
| 中断 | 停止当前执行 |
| Checkpoint | 恢复支持范围内的文件状态 |

查阅实际会话时，可以使用 `/context` 查看上下文占用，使用 `/memory` 检查记忆与指令文件，使用 `/compact` 指定压缩重点。官方也支持用 `/autocompact` 配置提前压缩，并在切换无关任务时使用 `/clear`。

来源：[Explore the context window](https://code.claude.com/docs/en/context-window)。
