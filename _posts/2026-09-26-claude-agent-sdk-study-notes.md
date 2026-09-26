---
layout: post
title: "Claude Agent SDK 学习笔记：从执行机制到业务系统实践"
date: 2026-09-26 00:00:00 +0800
tags:
  - Agent
  - Claude Agent SDK
  - TypeScript
  - 学习笔记
description: "结合官方文档与脱敏工程示例，梳理执行循环、工具与 Skill、权限、会话恢复、流式输出及生产实践。"
categories: [技术]
permalink: /2026/09/26/claude-agent-sdk-study-notes/
---

整理日期：2026-09-26。以 Anthropic 官方文档为主要依据，使用 TypeScript 说明接口。

本文将实际工程中的接入方式抽象为一个“故障诊断助手”。项目名称、内部组织、服务地址、专有业务规则、代码路径及仓库信息均已移除。代码分为“独立教学示例”和“工程模式示意”；后者会省略数据库、鉴权、界面及业务函数实现，不能直接当作完整程序运行。本文没有调用真实业务服务验证示例。

阅读时区分三类内容：**官方能力**描述 SDK 的行为；**工程实践**来自已有实现的脱敏抽象；**改进建议**是结合文档提出的设计选择，不代表已经落地。

## 1. 先明确边界：模型、Agent SDK 与业务应用分别负责什么。

Claude Code SDK 已更名为 Claude Agent SDK。TypeScript 使用 `@anthropic-ai/claude-agent-sdk`，Python 使用 `claude-agent-sdk`。这是同一产品能力的发展，不是需要同时安装的两套 Agent 框架。[官方迁移说明](https://code.claude.com/docs/en/agent-sdk/migration-guide)

| 层次 | 主要职责 | 故障诊断中的例子 |
|---|---|---|
| 模型 | 理解目标、提出假设、选择操作、解释结果 | 判断是否需要继续查询日志 |
| Agent SDK | 驱动执行循环、分派工具、管理会话与事件 | 执行工具并把结果送回模型 |
| 业务应用 | 用户身份、数据权限、任务状态、接口、展示和持久化 | 查询故障记录、生成报告、保存审计记录 |

Agent SDK 将 Claude Code 的工具与执行机制嵌入开发者管理的应用进程环境。普通 API Client SDK 主要提供模型 API 访问；Agent SDK 进一步提供现成的 Agent 运行能力。Claude Code CLI 则是面向终端用户的交互入口。[官方概览](https://code.claude.com/docs/en/agent-sdk/overview)

实际执行位置也需要分清：模型推理由模型服务承担；Claude Code 执行程序运行在应用配置的环境中；进程内 MCP 工具的处理函数运行在宿主应用中；远程 MCP 服务的处理逻辑运行在对应服务中。把 SDK 部署进容器，不会自动把远程服务也搬进这个容器。[MCP 文档](https://code.claude.com/docs/en/agent-sdk/mcp)、[部署文档](https://code.claude.com/docs/en/agent-sdk/hosting)

理解这一层次后，设计问题就容易定位：分析方法不清晰，调整指令或 Skill；数据查错，检查工具和业务权限；过程不可见，处理事件流；重启后丢上下文，处理会话存储。

## 2. 一次 `query()` 是如何完成工作的。

以“分析某次请求失败的原因”为例，一次执行可能依次发生：模型请求读取日志，SDK 执行读取并返回内容；模型发现某个依赖异常，再调用查询接口；模型比较证据，最后输出结论。中间不需要应用自己把每个工具结果重新拼成下一次模型请求。

```text
应用提交目标与配置
        ↓
模型选择下一步 ←──────────┐
        ↓                │
请求工具调用              │
        ↓                │
SDK 检查并执行工具         │
        ↓                │
工具结果加入上下文 ────────┘
        ↓
模型给出最终回答 → SDK 输出结果事件
```

这就是 Agent Loop。循环可能因为正常完成、执行错误、主动中断或达到限制而结束；正常结束不等于业务结论一定正确，仍需要证据和业务验收。[官方执行循环](https://code.claude.com/docs/en/agent-sdk/agent-loop)

最容易混淆的是三个单位：

| 单位 | 含义 | 例子 |
|---|---|---|
| 用户交互轮次 | 用户发起一次新输入 | “再检查一下昨天是否也出现过” |
| Agent 内部轮次 | 执行循环中的一次模型决策与工具交互 | 查询日志后，继续查依赖服务 |
| 工具调用次数 | 实际调用工具的数量 | 一次决策同时查询两个来源 |

因此，用户只发一句话，也可能产生多次模型调用；同一轮决策也可能请求多个工具。评估成本和耗时时，不能只统计聊天消息数量。

下面是独立教学示例。运行环境需要安装 SDK、配置官方支持的认证方式，并使用支持这些选项的版本；示例只向模型提供三个内置读取工具。

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

async function main() {
  try {
    const run = query({
      prompt: "检查当前目录的日志，列出异常及对应证据。证据不足时明确说明。",
      options: {
        cwd: process.cwd(),
        systemPrompt: "你是故障诊断助手。只依据已读取的数据作答。",
        settingSources: [],
        tools: ["Read", "Glob", "Grep"],
        allowedTools: ["Read", "Glob", "Grep"],
        permissionMode: "dontAsk",
        maxTurns: 6,
      },
    });

    for await (const message of run) {
      if (message.type === "system" && message.subtype === "init") {
        console.log("session:", message.session_id);
      }
      if (message.type === "result") {
        if (message.subtype === "success") {
          console.log(message.result);
        } else {
          console.error("run ended:", message.subtype);
        }
      }
    }
  } catch (error) {
    console.error("SDK execution failed:", error);
  }
}

await main();
```

这里的 `for await` 消费的是执行事件，不是要求应用手动驱动工具循环。应用既需要处理结果状态，也需要捕获迭代过程抛出的异常；连接、进程和执行错误并不总能用一条正常文本表示。[执行循环与结果处理](https://code.claude.com/docs/en/agent-sdk/agent-loop)

## 3. Tool、MCP、Skill、Subagent 和 Plugin 的关系。

| 概念 | 它是什么 | 适合承载的内容 |
|---|---|---|
| Tool | 模型可以请求执行的操作 | 查询日志、读取文件、发布报告 |
| MCP | 连接和描述工具等资源的协议 | 将业务接口提供给 Agent |
| Skill | 任务方法、说明与配套资源 | 日志诊断步骤、报告撰写规范 |
| Subagent | 处理子任务的独立 Agent 上下文 | 单独调查依赖问题后返回结果 |
| Plugin | 相关扩展的打包与加载方式 | 分发一组技能、Agent 定义和其他扩展 |

可以用一个具体任务检验理解：“按照日志诊断规范，查询两类日志，再生成报告。”规范可以放在 Skill 中；查询由 Tool 执行；业务工具可以通过 MCP 暴露；如果调查任务很大，可以委派给 Subagent；相关扩展可以按 Plugin 分发。

Skill 被调用时，通常是在当前执行上下文中加载方法说明，并不自动产生独立 Agent。一个名字叫 `start_analysis` 的工具，也可能只是创建进度记录；是否启动子 Agent，要看处理函数和 SDK 配置。[Skills](https://code.claude.com/docs/en/agent-sdk/skills)、[Subagents](https://code.claude.com/docs/en/agent-sdk/subagents)、[官方能力概览](https://code.claude.com/docs/en/agent-sdk/overview)

工程实践中，可以把通用规则留在系统提示词中，把各类问题的调查方法拆成 Skill，再用工具提供可执行能力。这样新增一种分析方法时，不必同时修改所有工具和界面逻辑。

## 4. 自定义工具：把程序能力交给模型选择。

官方 TypeScript 工具定义包含名称、描述、Zod 参数 Schema 和处理函数，再通过 `createSdkMcpServer()` 注册。这里的 MCP Server 可以在宿主应用进程内运行，无需为每个自定义工具部署独立 HTTP 服务。[官方自定义工具文档](https://code.claude.com/docs/en/agent-sdk/custom-tools)

下面把工程中“确定性计算交给工具”的模式，改写为不依赖业务系统的教学示例：

```ts
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const formatTime = tool(
  "format_time",
  "将毫秒时间戳转换为指定时区的时间，避免人工换算错误。",
  {
    timestampMs: z.number().int(),
    timeZone: z.string(),
  },
  async ({ timestampMs, timeZone }) => {
    try {
      const text = new Intl.DateTimeFormat("zh-CN", {
        timeZone,
        dateStyle: "medium",
        timeStyle: "long",
        hourCycle: "h23",
      }).format(new Date(timestampMs));

      return { content: [{ type: "text" as const, text }] };
    } catch {
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: "转换失败，请检查时间戳范围和时区名称。",
        }],
      };
    }
  },
);

const businessTools = createSdkMcpServer({
  name: "business-tools",
  tools: [formatTime],
});

// 将这段配置合并进 query() 的 options。
const toolOptions = {
  mcpServers: { "business-tools": businessTools },
  allowedTools: ["mcp__business-tools__format_time"],
};
```

工具名称的完整形式来自 `mcpServers` 的键与工具名。描述帮助模型理解何时调用；Schema 检查参数形状；处理函数负责实际执行。

**参数合法不代表业务操作合法。**例如 `issueId` 是非空字符串，不代表当前用户有权访问该问题。实际业务工具还应从服务端可信上下文取得用户身份，在处理函数或下游服务中校验访问权限；不要让模型自行填写可信身份。

错误也需要区分：工具返回 `isError: true` 表示这次操作失败，模型仍可能调整参数或选择其他工具继续任务；它不等于整个 `query()` 必须失败。只返回一段“查询失败”的普通文本，会让机器侧更难稳定区分成功和失败。[工具错误处理](https://code.claude.com/docs/en/agent-sdk/custom-tools#handle-errors)

工程中的报告发布、通知或任务创建属于有副作用的工具。实践建议是使用业务幂等键，例如“业务会话 + 操作类型 + 报告版本”，并通过数据库约束或下游幂等接口执行。内存中的 `alreadyPublished` 只能减少当前进程内的重复调用，不能覆盖重启、多副本和请求重试。

## 5. System Prompt、Skill 与配置加载解决的是不同问题。

系统提示词定义稳定角色和通用规则；Skill 定义特定任务的方法；运行时上下文描述本次用户、任务和已知事实。把三者分开，有利于维护，也减少每次执行都携带全部领域细节的必要。

系统提示词的三种方式必须明确：不设置时使用 SDK 的精简默认提示；选择 `claude_code` preset 时使用对应预设；传入自定义字符串时使用自己提供的提示内容。自定义字符串不会自动追加到完整预设后面。[官方系统提示词说明](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts)

```ts
// 适合在 Claude Code 行为基础上增加规则。
const presetPrompt = {
  type: "preset" as const,
  preset: "claude_code" as const,
  append: "分析报告需要列出证据来源，并区分事实与假设。",
};

// 适合具有独立产品身份和业务流程的助手。
const customPrompt = [
  "你是故障诊断助手。",
  "调查前先确认已有证据。",
  "无法确认根因时，输出假设和下一步验证方法。",
].join("\n");
```

Skill 的常见文件形式如下，目录仅为教学示例：

```text
.claude/
  skills/
    log-diagnosis/
      SKILL.md
      references/
      scripts/
```

SDK 发现 Skill 的元数据，再在调用时加载完整说明。包含脚本不意味着脚本会自动执行；仍需要 Agent 调用相应工具，并经过该工具的执行控制。[官方 Skills 文档](https://code.claude.com/docs/en/agent-sdk/skills)

`settingSources` 控制用户、项目和本地配置来源。例如 `['project']` 与 `['user']` 不是同一个意思；`plugins` 按显式路径加载扩展又是另一个配置入口。工程中应让注释、实际选项和部署目录保持一致。[配置加载文档](https://code.claude.com/docs/en/agent-sdk/claude-code-features)

还要避免把 `settingSources: []` 理解为完整隔离：它限制这些配置来源，不会使整个进程失去宿主权限，也不能屏蔽所有其他配置来源。类似地，XML 标签能帮助区分用户输入和指令，但不能替代权限校验或进程隔离。[官方配置边界](https://code.claude.com/docs/en/agent-sdk/claude-code-features#what-settingsources-does-not-control)

## 6. 权限应分成“工具是否可用”和“调用是否获准”两层理解。

| 配置 | 主要影响 | 不应误解为 |
|---|---|---|
| `tools` | 选择提供给模型的内置工具 | 同时自动限制全部 MCP 工具 |
| `mcpServers` | 注册 MCP 服务与工具 | 已完成业务数据鉴权 |
| `allowedTools` | 对匹配调用提供预授权 | 只有这些工具存在或可被调用 |
| `disallowedTools` | 禁用工具，或拒绝匹配规则的调用 | 任意字符串都能表达完整安全策略 |
| `canUseTool` | 处理尚需运行时决策的权限请求 | 每个工具调用必经的拦截器 |
| `PreToolUse` | 在工具执行前进行程序化检查 | 操作系统级沙箱 |

其中 `tools: ['Read', 'Grep']` 限制的是内置工具集合；MCP 工具需结合注册与相应规则单独控制。[工具可用性说明](https://code.claude.com/docs/en/agent-sdk/custom-tools#configure-allowed-tools)

**关键细节是：被前面的权限流程批准的调用，通常不会再进入 `canUseTool`。**如果把某个工具完整预授权，又只在回调中检查其业务权限，检查可能不执行。需要每次检查的规则，可以放入匹配该工具的 `PreToolUse`；业务访问控制仍应由服务端执行。[官方权限文档](https://code.claude.com/docs/en/agent-sdk/permissions)

下面两段代码表达不同的意图：

```ts
// 只表达“Read 预授权”，并未移除其他工具。
const preapproveRead = {
  allowedTools: ["Read"],
};

// 显式限制内置工具集合，并拒绝需要额外审批的操作。
const limitedBuiltins = {
  tools: ["Read", "Glob", "Grep"],
  allowedTools: ["Read", "Glob", "Grep"],
  permissionMode: "dontAsk" as const,
};
```

`dontAsk` 的含义是把原本需要询问的调用拒绝掉；并非“未写入 allowedTools 的所有行为都会被拒绝”。本来不需要审批的调用仍有自己的规则，因此固定工具范围应显式配置。[权限模式说明](https://code.claude.com/docs/en/agent-sdk/permissions#permission-modes)

工程中可以按两层验收：先确认模型可见的工具集合符合任务需要，再确认这些工具访问的数据和产生的副作用符合业务权限。只看一个“允许列表”不足以验证整个系统。

## 7. Hooks 与沙箱：一个控制调用，一个约束执行环境。

Hooks 是生命周期扩展点。`PreToolUse` 可以检查请求、更新输入或拒绝调用；`PostToolUse` 可用于记录结果等处理。返回 `{}` 的含义应理解为“这个 Hook 没有额外决定”，后续权限流程仍然存在。[官方 Hooks 文档](https://code.claude.com/docs/en/agent-sdk/hooks)

以下是工程模式示意，`policyAllows` 是由应用实现的同步策略函数：

```ts
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

declare function policyAllows(
  toolName: string,
  toolInput: unknown,
): boolean;

const enforcePolicy: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse") return {};

  if (!policyAllows(input.tool_name, input.tool_input)) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "该操作不符合当前任务的执行策略。",
      },
    };
  }

  return {};
};

const hookOptions = {
  hooks: {
    PreToolUse: [{ hooks: [enforcePolicy] }],
  },
};
```

这里没有指定 matcher，因此用于匹配所有工具调用。真正的策略实现应根据工具类型判断参数，而不是用一个字符串黑名单试图覆盖所有行为。

已有工程的一种适配模式是：拦截 `Bash`，把命令交给远程执行器，然后返回 `deny` 阻止本地重复执行，再将远程输出放进拒绝原因。

```ts
// 工程模式示意；省略执行器和参数获取。
const result = await remoteExecutor.exec(command);

return {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: `命令已由远程执行器处理：${result.stdout}`,
  },
};
```

它的意图可以理解，但 `deny` 在 SDK 语义中仍然表示拒绝调用。由此可能出现“业务命令成功，权限统计却记录拒绝”的分歧，模型也可能据此尝试其他执行方式。应把它视为需要单独验证的兼容方案。一个可评估的替代设计是将远程执行暴露为专用工具，正常返回结果，并按需移除本地 `Bash`。

沙箱则约束进程实际能访问什么。只重定向 Bash，不会自动隔离内置文件工具、宿主进程内的 MCP 处理函数或远程业务服务。工作目录 `cwd` 也不是文件系统隔离边界；共享同一宿主权限时，仅使用不同目录不能证明租户隔离。[安全部署文档](https://code.claude.com/docs/en/agent-sdk/secure-deployment)

## 8. 会话恢复：恢复上下文需要 ID，也需要可用的历史。

应区分三个标识：业务会话 ID 表示用户界面中的对话；SDK 会话 ID 标识 Agent 的上下文历史；执行 ID 标识某次启动或重试。一个业务会话可能因为恢复失败而关联过多个 SDK 会话，也可能有多次执行记录。

| 方式 | 选择哪个历史 | 适用情况 |
|---|---|---|
| `continue` | 当前目录最近的会话 | 单一操作者、最近任务续接 |
| `resume` | 指定 SDK 会话 ID | 多用户服务、明确续接目标 |
| Fork | 从已有历史创建新分支 | 尝试另一个分析方向 |

SDK 会话 ID 可以从初始化事件取得，也可以从结果事件读取。多用户应用通常应显式保存映射，恢复时检查访问权限。[官方会话文档](https://code.claude.com/docs/en/agent-sdk/sessions)

下面是工程模式示意。`saveBinding` 必须由应用实现，示例只突出应尽早保存 ID：

```ts
const run = query({
  prompt: input,
  options: {
    cwd: workDir,
    ...(previousSdkSessionId ? { resume: previousSdkSessionId } : {}),
  },
});

for await (const message of run) {
  if (message.type === "system" && message.subtype === "init") {
    await saveBinding(businessSessionId, message.session_id);
  }
  if (message.type === "result") {
    await saveBinding(businessSessionId, message.session_id);
  }
}
```

只在结束事件保存 ID，会在中途异常时留下映射空缺；扫描目录中最新文件可以作为历史兼容手段，但存在并发和路径推导问题，直接消费初始化事件更清楚。调用方仍应像前面的完整示例一样处理异常。

跨机器恢复还需要历史可读、工作目录对应关系稳定，以及必要工具和运行配置可用。仅把 ID 写入数据库，不会使另一台机器自动拥有原来的历史文件。当前官方提供 `sessionStore` 适配机制，通过 `append` 与 `load` 等方法接入自有存储；记录应按接口约定保序保存，具体支持情况需核对安装版本。[外部会话存储文档](https://code.claude.com/docs/en/agent-sdk/session-storage)

**恢复对话也不等于恢复全部外部环境。**历史可能说“已生成某个文件”，但文件需要另行持久化；内存变量、临时凭据和远程任务状态也不会因为恢复聊天记录而自动恢复。Fork 复制分析分支，同样不自动撤销或复制外部业务副作用。

已有工程还对某些历史文件末尾形式做了额外检查。此类规则应归类为特定版本或兼容端点的适配，不能推广成“官方 SDK 的所有 assistant 结尾历史都不能恢复”。

## 9. Session Facts：为什么还要保存一份业务事实。

会话历史记录“发生过哪些消息与工具调用”，业务事实记录“哪些结果已经成立”。例如一份报告已经发布，其编号、版本、结论及证据应成为明确的业务记录，而不应只存在于自然语言历史中。

以下是脱敏后的数据设计示意：

```ts
type SessionFact = {
  businessSessionId: string;
  factKey: string;
  version: number;
  status: "active" | "superseded";
  payload: unknown;
  sourceRunId: string;
  injectedSdkSessionId?: string;
  injectedVersion?: number;
};
```

后续执行可以按业务需要选取有效事实，作为额外上下文传入。恢复失败并建立新 SDK 会话时，再注入所需事实；事实版本变化时，也需要使旧注入状态失效。注入标记最好在确认消息已进入相应执行上下文后更新，避免“数据库显示已注入，但执行根本未启动”。

这是应用层设计，不是 SDK 自动提供的长期业务记忆。SDK 的上下文压缩可以减少历史占用，但摘要也不应成为业务状态的唯一事实来源。[官方上下文管理说明](https://code.claude.com/docs/en/agent-sdk/agent-loop)

一个实用原则是：模型读取事实来减少重复调查；执行器在执行有副作用的动作前，再查询真实业务状态。即使模型忘记某次发布，也不应导致重复创建报告。

## 10. 流式输出：增量用于展示，完整消息用于归档与确认。

普通 SDK 消息流与文本增量流是两个层次。设置 `includePartialMessages: true` 后，应用可以收到 `stream_event`，同时仍会收到完整的 `assistant`、`user` 和 `result` 等消息。[流式输出文档](https://code.claude.com/docs/en/agent-sdk/streaming-output)

| 事件 | 应用如何理解 |
|---|---|
| `system/init` | 保存初始化信息与 SDK 会话 ID |
| `assistant` | 处理模型内容块，包括文本或工具调用 |
| `user` | 检查内容块；其中可能是工具结果，不全是真人输入 |
| `stream_event` | 接收文本、工具参数等增量 |
| `result` | 处理执行结束状态与汇总信息 |

如果界面已经逐字追加了文本增量，又把完整 assistant 文本追加一次，就会重复显示。应用可以将增量用于临时展示，将完整消息用于校准和持久化；这是两种处理用途，不应当作两份不同的回答。

下面是合并到消息循环中的教学片段，只展示正文增量：

```ts
if (message.type === "stream_event") {
  const event = message.event;
  if (
    event.type === "content_block_delta" &&
    event.delta.type === "text_delta"
  ) {
    appendTextToUI(event.delta.text);
  }
}
```

实际多任务界面还应按执行、消息和内容块关联增量。尤其存在子 Agent 时，不能把所有来源的文字混成一条无结构字符串。工具参数的 JSON 增量也需要完整组装后再解析，不能假设每个分片都是合法 JSON。

**流式输入又是另一件事。**它是持续向运行中的会话提交用户消息的输入模式；流式输出则是持续接收生成事件。只开启部分输出消息，并不等于已经实现一个持续接收多轮输入的会话通道。[流式输入文档](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)

工程中可以把模型正文、工具进度、业务状态和最终报告分开处理。例如“报告正在生成”属于应用状态，“已调用日志查询”属于工具事件，“根因可能是连接池耗尽”属于模型结论。三者的可靠性和展示方式不同。

## 11. 执行控制：超时、轮次预算、费用预算和停止操作各有职责。

| 控制项 | 解决的问题 | 工程注意点 |
|---|---|---|
| `maxTurns` | 限制内部工具使用轮次 | 不等于聊天轮次或工具总数 |
| `maxBudgetUsd` | 按 SDK 费用统计限制执行 | 不能替代第三方网关实际账单核对 |
| 模型流空闲超时 | 识别模型输出长时间停滞 | 工具执行期间可能没有模型文字 |
| 单工具超时 | 避免外部接口一直等待 | 应由工具实现或执行框架处理 |
| 总任务时限 | 限制整个任务墙钟时间 | 包含模型、工具、重试与等待 |
| 用户停止 | 响应取消意图 | 应传递到当前运行句柄和下游操作 |

官方轮次和预算限制达到阈值后，会以相应结果状态结束。它们不是按毫秒计时的任务调度器。[执行限制文档](https://code.claude.com/docs/en/agent-sdk/agent-loop#turns-and-budget)

已有工程的一个有效模式是维护 `pendingToolUseIds`：发出工具调用时加入，收到工具结果时移除。等待工具期间暂停“模型流空闲”计时，但仍保留单工具超时和总时限，防止一个卡住的工具无限等待。

包装 SDK 时还有一个普通 JavaScript 层面的陷阱：

```ts
// 这个包装只转发事件。
async function* wrapEvents() {
  yield* query({ prompt: "检查日志" });
}

// 返回的异步生成器不会自动继承底层 Query 的 interrupt()/close()。
```

因此，增加备用模型、重试或观测包装后，应显式保留并转发运行控制能力。只检测外层对象“有没有 interrupt 方法”，不能保证包装后仍然能停止底层进程。具体可用控制方法及输入模式，应以安装版本的 Query 类型为准。

同样，停止模型生成不代表外部请求、排队任务或数据库写入自动撤销。应用需要明确取消传播与清理策略；已经完成的业务副作用则按业务规则处理。

## 12. 结构化输出：工具参数、工具返回值、最终报告是三个契约。

| 契约 | 常见机制 | 它检查什么 |
|---|---|---|
| 模型调用工具的参数 | 工具的输入 Schema | 参数名、类型与约束 |
| 工具返回给模型的数据 | `content`，以及可选结构化字段 | 工具向 Agent 提供什么结果 |
| Agent 最终给应用的结果 | `outputFormat` | 最终输出的结构 |

工具参数通过 Zod 校验，不代表最终回答也满足同一个结构；让模型“用 JSON 回答”也不等于应用已经建立可验证的输出契约。

下面是最终诊断结果的配置示例：

```ts
const diagnosisSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["confirmed", "inconclusive"] },
    summary: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
    nextSteps: { type: "array", items: { type: "string" } },
  },
  required: ["status", "summary", "evidence", "nextSteps"],
  additionalProperties: false,
};

const outputOptions = {
  outputFormat: {
    type: "json_schema" as const,
    schema: diagnosisSchema,
  },
};
```

消费结果时同时检查 `subtype === 'success'` 和 `structured_output` 是否存在；需要时再使用应用自己的 Schema 验证并取得类型。官方还定义了无法生成有效结构化结果的失败情况。[结构化输出文档](https://code.claude.com/docs/en/agent-sdk/structured-outputs)

**结构正确不代表事实正确。**一份格式完全合法的报告，仍可能引用不存在的日志。业务应用应检查证据是否存在、状态是否自洽，以及报告中的操作是否真实完成。示例特意允许 `inconclusive`，避免要求模型在证据不足时也必须填写确定根因。

对需要保存、检索和统计的诊断结果，可以先形成结构化记录，再由应用渲染卡片或 Markdown；发布行为由显式工具或确定的业务流程执行。这是可选改进，不是所有对话都必须使用的模式。

## 13. 子 Agent：用独立上下文处理可拆分的调查。

官方支持通过 `agents` 定义专门的子 Agent，也支持文件定义和内置通用子 Agent。子任务的中间调查留在其上下文中，主 Agent 获取返回结果；这有助于减少主上下文承载的细节，并支持独立任务并行。[官方子 Agent 文档](https://code.claude.com/docs/en/agent-sdk/subagents)

下面是配置片段，而不是已执行的并行任务：

```ts
const agentOptions = {
  tools: ["Agent", "Read", "Glob", "Grep"],
  allowedTools: ["Agent", "Read", "Glob", "Grep"],
  agents: {
    "log-investigator": {
      description: "调查本地日志异常，返回证据位置与待验证假设。",
      prompt: "只分析分配给你的日志。区分直接证据与推测。",
      tools: ["Read", "Glob", "Grep"],
    },
  },
};
```

配置定义了能力，主 Agent 是否调用仍取决于任务与指令。需要稳定执行的业务步骤，不能只因为定义了子 Agent 就认为一定发生。

在故障诊断中，可以把“检查错误日志”和“检查独立的部署记录”拆开；如果第二项必须等待第一项产生服务名称，则应先后执行。工程上要判断依赖，而不是为了并行而并行。

子 Agent 的上下文隔离也不等于文件系统隔离：若共享工作目录或外部服务，仍可能发生写入冲突。返回结果最好包含结论、证据位置、未解决问题和可信度依据，让主 Agent 能够复核。

## 14. 观测与兼容层：记录过程，同时验证事件语义。

一个实用的观测层可区分业务会话、单次执行、模型调用和工具调用。建议记录有效模型、工具名称、耗时、状态、用量、重试、取消原因，以及必要的证据或产物引用。业务状态与 SDK 状态分别保存，避免把“模型输出结束”直接等同于“报告发布成功”。

统计 Token 时不要把每一条 assistant 事件都当成一次独立计费请求，也不要把逐步统计再加上最终汇总。官方费用文档解释了消息 ID 去重、逐步字段和结果汇总的差别；应先选定统计口径，再实现聚合。[费用与用量文档](https://code.claude.com/docs/en/agent-sdk/cost-tracking)

已有工程通过包装 query 与工具处理函数接入观测，并额外记录应用事件。这是应用集成；换一个观测供应商时，不应改变业务工具的语义。

兼容模型网关还需要额外验证。接口能返回文本，只说明最基础路径可用，不能证明工具调用、增量参数、usage 时序、会话恢复、错误码和结构化输出都兼容。应保存“最小可复现输入 + 原始事件 + 期望行为”，把兼容修复留在适配层。

备用模型也有两个不同层次：SDK 自带的备用模型配置，与应用因特定失败而重新发起一次执行。后者需要重新考虑上下文、已发生的副作用和剩余预算；不能简单把原始任务再完整执行一次而忽略之前已发布的内容。

## 15. 把这些能力组合为一个可维护的诊断流程。

以下流程综合了已有工程模式与前文的改进建议，并非声称每一步已经在某个系统中实现：

```text
收到用户任务
  → 应用校验身份和业务访问权限
  → 加载业务会话、已有结果与执行配置
  → 恢复 SDK 会话，或创建新会话并补入必要事实
  → 构造系统提示词、Skill 来源与工具集合
  → 启动 query，保存初始化会话 ID
  → 消费事件，展示正文与工具进度
  → 工具处理函数执行业务校验和幂等操作
  → 检查最终状态、结构化结果与证据
  → 保存报告、事实、用量和执行记录
  → 清理执行资源，并按策略持久化会话与产物
```

为了判断自己是否理解，可以尝试回答下面的问题：

1. 一条用户输入触发了三次模型调用、五次工具调用，应该如何统计轮次、耗时和费用？
2. 为什么在 `allowedTools` 中预授权工具后，某些 `canUseTool` 检查不再触发？
3. 为什么 `settingSources: []` 和独立 `cwd` 都不能单独证明完整隔离？
4. 为什么保存了 SDK 会话 ID，仍可能无法在另一台机器续接？
5. 为什么已经接收文本增量后，不能再把完整消息直接追加到同一区域？
6. 一个工具返回错误后，Agent 是否仍可能正常完成任务？
7. 用户点击停止后，如何确认远程任务和重试也已经停止？
8. 一个 JSON 结构合法的诊断结果，还需要哪些业务验证？
9. 子 Agent 与 Skill 分别适合拆分什么？
10. 多副本部署中，什么机制防止模型重复发布同一份报告？

复习顺序可以采用：[概览](https://code.claude.com/docs/en/agent-sdk/overview) → [执行循环](https://code.claude.com/docs/en/agent-sdk/agent-loop) → [自定义工具](https://code.claude.com/docs/en/agent-sdk/custom-tools) → [Skills](https://code.claude.com/docs/en/agent-sdk/skills) → [权限](https://code.claude.com/docs/en/agent-sdk/permissions) → [会话](https://code.claude.com/docs/en/agent-sdk/sessions) → [流式输出](https://code.claude.com/docs/en/agent-sdk/streaming-output) → [Hooks](https://code.claude.com/docs/en/agent-sdk/hooks)。再按实际需要补充外部存储、结构化输出、子 Agent 和部署内容。
