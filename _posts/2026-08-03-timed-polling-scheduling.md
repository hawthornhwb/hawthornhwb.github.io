---
layout: post
title: "关于定时轮询调度的实践思考"
date: 2026-08-03 00:20:00 +0800
description: "从告警卡片刷新出发，记录定时器从本地 Map 到 Redis 分布式状态管理的演进，以及原子领取、执行租约和并发更新的设计。"
categories: [技术]
tags: [定时任务, Redis, 分布式系统, 学习笔记]
---

快手的实习已经结束，通过博客总结一下这段时间在开发过程中沉淀的一些经验。

这次记录的是告警处置进展卡片的定时刷新设计：从单机上的 `setInterval + Map`，逐步拆分为外部调度、共享状态和业务执行三个部分。需求看起来只是开启、停止和调整间隔，真正需要处理的却是多实例之间的状态一致性，以及任务执行中发生停止、恢复或超时后的行为。

> 本文根据[定时器设计文档](https://www.yuque.com/huangweibo-fj8jd/hkk109/ga9mcuiq1m4h84h1)整理，于 2026 年 9 月 23 日补充。文中的领取、完成写回及异常处理规则，是为说明设计边界而补充的约定；代码用于展示核心逻辑，不代表完整线上实现。

## 一、为什么需要定时刷新

原有告警处置进展卡片只在报警流程开始时触发。值班 oncall 和后续入群的同学，无法仅通过卡片了解当前处置进展。

因此，希望给卡片增加定时轮询能力：开启后按配置间隔刷新，支持暂停、恢复和修改间隔，让群里的同学能够看到持续更新的处理状态。

项目采用 Hono 作为后端 Web 框架。在这套方案中，Hono 承担 HTTP 请求入口，调度能力由独立组件提供。当前业务没有复杂的工作流编排需求，且已有可复用的内部轮询组件，因此选择在业务层维护定时状态，控制引入新框架的成本。

## 二、从本地定时器到分布式定时器

| 对比项 | 本地定时器方案 | 分布式定时器方案 |
| --- | --- | --- |
| 触发方式 | Conan 实例内的 `setInterval` | 外部轮询服务每 60 秒触发一次扫描 |
| 状态存储 | 当前实例的 `Map` | Redis 保存调度状态 |
| 执行上下文 | 跟随单机方案维护 | MySQL 保存刷新所需的业务上下文 |
| 业务执行 | 创建任务的实例执行 | Conan 实例领取任务后执行刷新 |
| 主要收益 | 快速完成单机验证 | 调度与业务动作解耦，应用重启后可继续扫描已有任务 |
| 主要局限 | 多实例状态不共享，重启丢失，任务分散 | 存在轮询延迟，跨服务链路增加排查成本 |

本地方案最大的风险是：创建任务的请求和停止任务的请求，可能落在不同实例上。定时器只在创建它的机器上可见，另一个实例无法正确操作这份状态。实例重启后，内存中的任务也会消失。

最终选择把三个职责拆开：**轮询服务负责触发，Redis 负责保存共享调度状态，Conan 负责领取和执行任务。** MySQL 则保存执行时需要读取的上下文，避免把所有业务数据都塞进定时状态。

这里的“重启后继续执行”是指 Conan 应用实例重启后，仍能读取 Redis 中的任务；Redis 自身故障后的数据恢复能力，还取决于持久化和高可用配置。

## 三、四个组件如何协同

```text
轮询服务（每 60 秒触发）
        │
        ▼
Conan 扫描入口 ──────► Redis：读取候选任务、原子领取
        │                         │
        │ ◄──── 领取成功，返回 runId 和租约
        ▼
MySQL：读取 sessionId 对应的业务上下文
        │
        ▼
Conan 执行卡片刷新
        │
        ▼
Redis：校验 status、runId 和租约，完成本轮写回
```

轮询只是一次“检查是否到期”的机会。扫描发现候选任务后，还需要一次原子领取：**扫描结果可以过时，执行资格必须以领取时 Redis 中的最新状态为准。** 多个实例即使同时扫描到同一任务，也不能仅凭扫描结果直接执行。

每分钟扫描一次意味着到期不等于立即执行。在扫描稳定、没有积压的情况下，任务可能等待接近一个扫描周期；网络延迟、执行排队或服务故障还会增加等待时间，因此不能把 60 秒视为严格的延迟上限。这个方案适合分钟级刷新，不适合要求精确触发的任务。

## 四、状态与数据结构

### 1. 三种状态

| 当前状态 | 事件或条件 | 新状态与操作 |
| --- | --- | --- |
| 不存在 | 开启定时器 | 创建 `ready` 状态 |
| `ready` | 已到期，且原子领取成功 | 进入 `running`，生成 `runId`，设置执行租约 |
| `running` | 执行完成，轮次匹配且租约有效 | 回到 `ready`，清除轮次和租约 |
| `ready` / `running` | 停止 | 进入 `stopped`，清除轮次和租约 |
| `stopped` | 恢复，且业务上下文存在 | 回到 `ready`，将 `nextRunAt` 设为当前时间 |
| `running` | 租约过期，重新领取成功 | 保持 `running`，生成新的 `runId` 和租约 |
| `ready` | 修改间隔 | 保持 `ready`，重新计算 `nextRunAt` |
| `running` | 修改间隔 | 保持 `running`，保留当前轮次和租约，更新后续调度时间 |

`stopped` 状态禁止领取。本文沿用原设计中修改间隔脚本的规则：已停止的任务不接受间隔修改，应先恢复。

### 2. Redis 只保存调度信息

使用 Redis Hash 保存任务，以环境区分 key，以报警会话标识 `sessionId` 作为 field：

```typescript
const stage = process.env.KWS_SERVICE_STAGE;
if (!stage) throw new Error('KWS_SERVICE_STAGE is required');

const timersKey = `{${stage}:similar-crashes}:timers`;
// field = sessionId
// value = JSON.stringify(timerState)

interface TimerState {
  status: 'ready' | 'running' | 'stopped';
  intervalMinutes: number;
  nextRunAt: number;
  lastRunAt?: number;
  runningUntil?: number;
  runId?: string;
  updatedAt: number;
}
```

本文统一使用 `status` 字段，避免接口定义中的 `status` 与操作示例中的 `state` 混用。除以分钟计的 `intervalMinutes` 外，时间字段统一采用毫秒时间戳。

- `nextRunAt`：下一次应执行时间，不保证届时立即执行。
- `lastRunAt`：上一轮取得执行资格的时间，不表示执行成功。
- `runningUntil`：当前执行租约的截止时间，初始可考虑 10 分钟，再结合实际耗时调整。
- `runId`：当前轮次的唯一标识，用于拒绝旧执行者的迟到写回。
- `updatedAt`：最近一次状态更新时间。

`runningUntil` 是应用判断的时间字段，不是 Redis key 的过期时间。租约到期后，需要下一次扫描和领取才能推进状态。

## 五、核心操作

### 1. 注册：先保证上下文可用

原始注册逻辑是把序列化后的状态写入 Hash：

```typescript
await redis.hset(timersKey, sessionId, JSON.stringify(timerState));
```

但 `HSET` 会覆盖已有 field。若注册请求重复到达，无条件写入初始状态，可能覆盖一个正在运行或已经停止的任务。

因此，首次创建可以使用 `HSETNX`；已有任务应通过明确的状态操作更新。这里建议先保存 MySQL 上下文，再创建 Redis 调度状态。如果第二步失败，依靠幂等重试补齐。两次写入不属于同一个跨存储事务，不能假设它们天然同时成功。

### 2. 停止：禁止后续领取，使当前轮次失效

```text
stopTimer(sessionId, now):
  在 Redis 原子操作中：
    读取并校验 timer，不存在则返回 timer_not_found
    timer.status = stopped
    清除 timer.runId 和 timer.runningUntil
    timer.updatedAt = now
    保存 timer
```

清除 `runId` 后，即使旧执行者稍后完成，也无法凭旧轮次把状态改回 `ready`。

**停止状态不等于中断已经发出的外部请求。** 若刷新已经开始，仍可能产生最后一次卡片更新。可以在执行外部动作前再次检查资格以缩小窗口，但要严格阻止迟到副作用，还需要下游支持版本校验、幂等或可取消机制。

### 3. 恢复：让任务在下一次扫描时具备执行资格

```text
resumeTimer(sessionId, now):
  先确认 MySQL 中的业务上下文存在
  在 Redis 原子操作中：
    读取并校验 timer
    若 status 不是 stopped，直接返回当前状态
    校验 intervalMinutes，必要时采用经过校验的默认值
    timer.status = ready
    timer.nextRunAt = now
    清除 timer.runId 和 timer.runningUntil
    timer.updatedAt = now
    保存 timer
```

`nextRunAt = now` 表示可以被下一次扫描领取，不代表恢复接口会立即刷新。MySQL 上下文检查与 Redis 更新也不是原子事务，执行前仍应处理上下文缺失的情况。

### 4. 修改间隔：避免旧 JSON 覆盖新状态

考虑两个请求交错执行：

```text
修改间隔：读取 status = ready
停止操作：读取 status = ready
停止操作：写入 status = stopped
修改间隔：把之前读到的 JSON 整体写回
最终结果：status 被错误地改回 ready
```

单次 `HSET` 的原子性，不能保证“读取 → 修改 → 写回”这一组操作的原子性。即使不操作上下文，只要使用旧 JSON 整体覆盖，就可能丢失并发更新。

可以通过 Redis Lua 脚本，把校验和修改放在一次原子执行中。Redis 会在脚本执行期间阻止其他命令交错执行，因此脚本应保持短小，只处理状态，不承担耗时业务逻辑。[Redis Lua 官方说明](https://redis.io/docs/latest/develop/programmability/eval-intro/)

```lua
local timersKey = KEYS[1]
local sessionId = ARGV[1]
local intervalMinutes = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local function finite(n)
  return n ~= nil and n == n and n > -math.huge and n < math.huge
end

local function fail(reason)
  return cjson.encode({ changed = false, reason = reason })
end

if not finite(intervalMinutes) or intervalMinutes <= 0 then
  return fail("invalid_interval")
end
if not finite(now) or now < 0 then
  return fail("invalid_now")
end

local nextRunAt = now + intervalMinutes * 60000
if not finite(nextRunAt) then
  return fail("invalid_interval")
end

local raw = redis.call("HGET", timersKey, sessionId)
if not raw then
  return fail("timer_not_found")
end

local ok, timer = pcall(cjson.decode, raw)
if not ok or type(timer) ~= "table" then
  return fail("bad_timer_state")
end

if timer.status == "stopped" then
  return cjson.encode({ changed = false, reason = "stopped", timer = timer })
end
if timer.status ~= "ready" and timer.status ~= "running" then
  return fail("bad_timer_state")
end

-- 只改变间隔和后续调度时间，保留当前状态、runId 和租约。
timer.intervalMinutes = intervalMinutes
timer.nextRunAt = nextRunAt
timer.updatedAt = now

redis.call("HSET", timersKey, sessionId, cjson.encode(timer))
return cjson.encode({ changed = true, timer = timer })
```

生产实现还应校验完整的数据结构，并设置符合业务的间隔范围。上面的脚本集中展示并发修改规则。

不仅修改间隔需要原子更新，**停止、恢复、领取和完成写回，也都应遵循相同的原子状态变更规则**。否则，任一保留“客户端读旧值后整体覆盖”的操作，仍可能破坏其他操作的结果。

## 六、领取、租约和完成写回

原设计通过 `runningUntil` 和 `runId` 表达执行资格。为了让整个流程闭合，还需要明确领取和完成时的约定。

### 1. 原子领取

领取操作重新读取最新状态，仅允许两类任务通过：

- `ready` 且 `nextRunAt <= now`；
- `running` 且 `runningUntil <= now`，即上一轮租约已经过期。

领取成功后，原子设置 `status = running`、新的唯一 `runId`、`runningUntil = now + leaseMs` 和 `lastRunAt = now`。未过期的 `running` 任务和所有 `stopped` 任务都不能被领取。

这里补充采用“以本轮领取时间安排下一轮”的规则：领取时设置 `nextRunAt = now + intervalMinutes * 60000`。这是为本文示例选择的调度语义，并不是原始文档已经确定的实现。若执行耗时超过间隔，完成后可能在下一次扫描时很快再次被领取；若业务期望每次完成后再等待完整间隔，则需要另行设计完成时的排期及配置版本校验。

### 2. 完成时拒绝迟到写回

```text
completeTimer(sessionId, expectedRunId, now):
  在 Redis 原子操作中读取最新 timer
  若 status != running，拒绝写回
  若 runId != expectedRunId，拒绝写回
  若 runningUntil <= now，拒绝写回

  timer.status = ready
  清除 timer.runId 和 timer.runningUntil
  保留最新的 intervalMinutes 和 nextRunAt
  timer.updatedAt = now
  保存 timer
```

完成写回保留 Redis 中最新的间隔和下一次执行时间，防止任务执行期间用户调整的配置被覆盖。

例如，A 领取后因超时失去租约，B 重新领取并获得新 `runId`。A 后续恢复运行时，不能再提交旧轮次的调度状态。停止后重新恢复的场景，也通过清除和重新生成 `runId` 隔离旧执行者。

### 3. 租约解决恢复，不保证业务只执行一次

租约过期不意味着旧执行进程已停止。因此，B 重新领取后，A 仍可能继续执行外部刷新。`runId` 能保护 Redis 状态写回，却不能自动防止下游副作用重复发生。

对于卡片刷新，可以优先设计为对同一卡片的幂等更新，并在下游支持时增加版本检查，避免旧结果覆盖新结果。如果任务可能超过 10 分钟，应按实际耗时调整租约，或设计带轮次校验、仅在有效租约内续期的机制。

## 七、落地时还需要关注什么

这套设计满足的是分钟级、可恢复的刷新需求。上线时仍需要明确以下行为：

- **上下文缺失**：禁止无上下文执行，记录原因，并按业务规则停止任务或等待修复。
- **执行失败**：区分可重试错误和不可恢复错误，约定下一次尝试时间；不要把失败当作成功更新。
- **实例崩溃**：保留 `running`，等待租约过期后重新领取，记录接管次数。
- **请求重复**：注册、停止和恢复应具有幂等语义，重复请求不能意外重置任务。
- **数据损坏**：隔离无法解析的记录，避免单个异常状态阻断整批扫描。
- **任务规模增长**：控制扫描批次和执行并发；任务数量较大时，再评估分片或按到期时间建立索引。
- **可观测性**：日志关联 `sessionId`、`runId` 和环境，关注扫描耗时、执行延迟、失败率与租约接管次数。

回看这次设计，定时器的关键不只是“隔一段时间执行一次”，还包括：状态由谁保存、哪个实例拥有执行资格、实例失联后如何接管，以及用户操作如何与正在执行的任务协调。

把这些规则写清楚后，开启、停止、恢复和修改间隔才有一致且可解释的行为。

## 参考资料

- [原始定时器设计文档（语雀）](https://www.yuque.com/huangweibo-fj8jd/hkk109/ga9mcuiq1m4h84h1)
- [Redis：Scripting with Lua](https://redis.io/docs/latest/develop/programmability/eval-intro/)
- [Redis：HSET](https://redis.io/docs/latest/commands/hset/)
