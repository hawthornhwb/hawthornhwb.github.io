---
layout: post
title: "理解 Codex 的缓存命中：从 Agent 循环到成本统计"
date: 2026-09-23 23:00:00 +0800
description: "结合 OpenAI 官方说明，理解 Codex 如何复用上下文计算，以及缓存命中与工具调用、上下文压缩、费用和性能的关系。"
categories: [技术]
tags: [Agent, Codex, KV Cache, 上下文工程, 学习笔记]
permalink: /2026/09/23/codex-prompt-cache/
---

在 Agent 的用量统计里，经常会看到“缓存输入”“缓存命中率”等指标。它们描述的是：**当前模型调用的输入中，有多少内容复用了之前的计算状态。**

理解 Codex 的缓存命中，需要先把“用户发出的一条消息”和“背后发生的多次模型调用”分开看。本文结合 Codex 与 OpenAI API 官方说明整理，文档核对日期为 2026 年 9 月 23 日。流程和数字均为教学示例，不代表某次真实任务的内部记录；API 规则也不应直接视为 Codex 桌面端每项配置的承诺。

## 一、一条任务，为什么会反复处理相同内容？

假设给 Codex 一个任务：“修复登录问题。”它可能依次读取代码、分析原因、修改文件、运行测试，再根据报错继续修复。官方把这种持续采取行动、观察反馈的工作过程描述为 Agent 循环。[Codex 长任务说明](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex)

用户只发了一条消息，模型却可能被调用多次。每次调用都需要知道目标、此前的操作和最新结果。把上下文的增长简化后，可以得到：

```text
第 1 次输入
[固定指令、工具说明、任务要求]
→ 模型决定读取登录代码

第 2 次输入
[固定指令、工具说明、任务要求][读取请求、代码内容]
→ 模型决定修改代码

第 3 次输入
[固定指令、工具说明、任务要求][读取请求、代码内容][修改过程、结果]
→ 模型决定运行测试
```

这是一张逻辑示意图，并不要求客户端每次都通过网络重新发送完整历史。重要的是模型实际使用的上下文中存在重复部分。

官方 Agent 用量文档说明，一个任务可能包含多次模型调用，输入包括指令、工具定义、历史消息、文件以及工具结果。[Agent 用量说明](https://developers.openai.com/api/docs/guides/agents-api/observability)

## 二、缓存保存的是 KV 状态

模型处理输入时，会产生用于后续计算的 Key-Value 状态，简称 KV 状态。提示词缓存保存可复用前缀对应的状态；后续请求匹配成功，就能从已有状态继续处理新增内容和生成输出。[提示词缓存原理](https://developers.openai.com/api/docs/guides/prompt-caching)

可以用读卷宗来类比：第一次读完前 100 页，保存阅读进度；第二次前 100 页没有变化，后面新增 5 页，就接着读。这里的“阅读进度”实际是一组数学计算结果。

这个类比也解释了三个容易混淆的概念：

| 概念 | 可以怎样理解 |
| --- | --- |
| 会话历史 | 保存此前发生过什么，供后续调用组织上下文 |
| 提示词缓存 | 保存特定输入前缀的计算状态，减少重复处理 |
| 答案缓存 | 应用直接返回以前保存的答案，属于另一种机制 |

提示词缓存仍然让模型生成本次回答。缓存命中本身不会让 Codex 跳过应该执行的测试，也不会证明代码、网页或工具返回的信息已经更新。

## 三、为什么必须匹配“前缀”？

前缀是从输入开头开始、连续一致的部分。匹配要求精确一致，意思接近不够。

```text
上一次：[A 固定指令][B 工具说明][C 历史对话][D 新问题]
这一次：[A 固定指令][B 工具说明][C 历史对话][E 新问题]
        └───────── 共同前缀 ─────────┘
```

这里 A、B、C 有机会复用。如果工具说明 B 改成 B′：

```text
上一次：[A][B ][C][D]
这一次：[A][B′][C][E]
```

共同前缀就只到 A。后面的 C 即使文字相同，也不能直接沿用原来经过 B 计算出来的那份后续状态。

因此，不能把提示词缓存理解为“在整段输入里寻找重复句子，然后分别复用”。官方缓存诊断要求前缀精确匹配，并检查模型、工具等请求设置是否兼容。[缓存诊断说明](https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics)

工具变化也不一定要破坏已有前缀。官方说明，使用工具搜索时，新发现的工具定义会追加到对话末尾，以保留早期内容的缓存复用机会。[Agent 缓存说明](https://developers.openai.com/api/docs/guides/agents-api/observability)

## 四、如何读懂缓存命中率？

假设一次调用的用量是：

| 项目 | 数量 | 含义 |
| --- | ---: | --- |
| 输入 token | 20,000 | 本次全部输入 |
| 缓存输入 token | 18,000 | 输入中复用了缓存的部分 |
| 输出 token | 1,000 | 本次生成的内容 |

缓存输入属于全部输入的子集，因此输入是 20,000，而不是 38,000。API 的对应字段通常为 `input_tokens` 和 `input_tokens_details.cached_tokens`。[用量字段说明](https://developers.openai.com/api/docs/guides/agents-api/observability)

按 token 计算：

```text
本次缓存命中率 = 18,000 / 20,000 = 90%

整个任务的缓存命中率
= 各次调用的缓存输入 token 总和 / 各次调用的输入 token 总和
```

汇总任务时，应先加总数量再相除，避免让很小和很大的调用获得相同权重。还应核对统计面板的口径：按 token 统计的比例，与“有多少次请求发生过命中”的请求比例不同。

**90% 命中表示输入计算的复用程度，不表示任务进度，也不直接等于费用节省比例。**

## 五、用具体价格计算一次节省

以 GPT-5.3-Codex 的标准 API 价格为例，官方模型页面列出的每百万 token 单价如下。这只是计算示例，实际使用应查对应模型和处理档位的价格。[官方模型价格](https://developers.openai.com/api/docs/models/gpt-5.3-codex)

| 类型 | 每百万 token 价格 |
| --- | ---: |
| 普通输入 | 1.75 美元 |
| 缓存输入 | 0.175 美元 |
| 输出 | 14 美元 |

沿用前面的输入和输出数量：

```text
没有命中时的输入费用
= 20,000 × 1.75 / 1,000,000
= 0.035 美元

18,000 token 命中时的输入费用
= 2,000 × 1.75 / 1,000,000
+ 18,000 × 0.175 / 1,000,000
= 0.00665 美元

1,000 个输出 token 的费用
= 1,000 × 14 / 1,000,000
= 0.014 美元
```

输入费用减少 81%。计入输出后，这次调用费用从 0.049 美元降到 0.02065 美元，减少约 58%。这个计算仅包含所列输入和输出，没有计算工具及其他服务费用。

这说明三个指标必须分开：

- 缓存命中率：复用了多少输入。
- 输入费用节省比例：输入部分少花了多少钱。
- 整个任务费用节省比例：所有调用和相关费用合计后的变化。

### Codex 积分与 API 费用要分开

官方当前说明，Codex 积分计费没有单独的缓存写入收费；API Key 使用遵循 API 价格。订阅用量还受模型、上下文、推理、工具使用和缓存等因素影响，不能把 API 的折扣直接换算成五小时订阅额度的节省比例。[Codex 价格与用量说明](https://learn.chatgpt.com/docs/pricing)

如果自行开发 API Agent，还要注意模型间差异：部分较新模型有单独的缓存写入计价，应同时记录读取和写入量，比较实际总成本。[API 部署检查说明](https://developers.openai.com/api/docs/guides/deployment-checklist)

## 六、为什么命中率高，任务仍可能很慢？

缓存主要减少输入处理阶段的重复计算。根据这一机制，可以把任务耗时粗略分解为：

```text
总耗时
≈ 输入处理 + 推理与输出生成 + 工具执行 + 网络与调度等待
```

这只是分析模型，并非 Codex 的精确计时公式。若大部分时间花在运行测试、访问网站或生成长答案上，输入缓存带来的整体加速就可能有限。

同样，一次读取已经得到的工具结果可以成为后续上下文的一部分，但缓存这些文字的计算状态，不会使下一次真正执行测试的过程自动变快。

## 七、连续对话为什么也会缓存未命中？

保持同一个任务有助于维持共同前缀，但不能保证每次命中。常见影响因素包括：

| 变化 | 可能的影响 |
| --- | --- |
| 改写早期消息或指令 | 从变化处开始，原来的后续前缀不能继续匹配 |
| 调整工具或模型设置 | 可能改变模型实际接收的上下文或缓存兼容性 |
| 缓存过期或服务端路由变化 | 匹配的缓存条目可能无法使用 |
| 前缀太短或边界不符合条件 | 看起来相同的输入未必达到缓存要求 |

实际复用受模型的最低长度、缓存边界、有效期及路由规则影响，不能只凭肉眼比较用户消息。[提示词缓存规则](https://developers.openai.com/api/docs/guides/prompt-caching)

### 上下文压缩是长任务中的另一种变化

长对话可以通过 Compaction 压缩早期上下文，保留继续工作所需的状态。官方说明，部分压缩结果是供模型使用的不透明状态，不一定是人能直接阅读的一段摘要。[上下文压缩说明](https://developers.openai.com/api/docs/guides/compaction)

```text
压缩前：[固定指令][很长的历史记录][新消息]
压缩后：[固定指令][较短的压缩状态][新消息]
```

压缩改变了前缀，因此可能降低后续调用对旧缓存的复用；输入本身也变短了，所以命中率下降时，总成本仍可能下降。[压缩与缓存的关系](https://developers.openai.com/api/docs/guides/prompt-caching)

从工程角度，应该同时比较压缩前后的输入长度、实际费用、延迟和任务质量。仅看命中率，会把“保留很多不必要的历史”误认为一种优化。

## 八、实际使用和开发时的建议

官方建议把稳定指令、共享资料放在前面，把动态内容放在后面，并尽量追加新消息而非重写历史。[官方缓存优化建议](https://developers.openai.com/api/docs/guides/deployment-checklist)

结合这些原则，我会这样使用 Codex：

1. 同一个目标优先在原任务里补充要求，让已有背景继续发挥作用。
2. 项目规则和工具说明保持稳定，把新的变化放进后续消息。
3. 提供相关文件和必要日志，减少无关上下文。
4. 换了目标就按任务需要开新对话，不为了命中率保留大量旧历史。
5. 用任务质量、总成本和总耗时评估效率，把缓存命中率作为解释原因的辅助指标。

对于自己开发的 Agent，我还会分别记录每次调用的输入、缓存输入、输出、适用时的缓存写入、工具耗时和重试次数。这样才能分辨成本来自长上下文、生成内容，还是不必要的循环。

缓存让已有上下文的计算可以复用；上下文工程则决定哪些信息值得进入下一次调用。两者配合，才更有可能让 Agent 用合理的成本完成任务。

## 参考资料

- [Codex：Run long horizon tasks with Codex](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex)
- [OpenAI：Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [OpenAI：Prompt cache diagnostics](https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics)
- [OpenAI：Agents API observability and usage](https://developers.openai.com/api/docs/guides/agents-api/observability)
- [OpenAI：Compaction](https://developers.openai.com/api/docs/guides/compaction)
- [OpenAI：API deployment checklist](https://developers.openai.com/api/docs/guides/deployment-checklist)
- [OpenAI：GPT-5.3-Codex](https://developers.openai.com/api/docs/models/gpt-5.3-codex)
- [Codex：价格与用量](https://learn.chatgpt.com/docs/pricing)
