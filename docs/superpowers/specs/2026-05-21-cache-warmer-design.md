# opencode-cache-warmer 插件设计文档

v3 — 基于四代理复审修订

## 概述

针对 Windows opencode 桌面端，开发一个插件用于**维持 LLM API Prompt Cache**（如 Claude 的 5 分钟 TTL）。通过周期性检测活跃会话的空闲时间，在空闲超过阈值时代用户发送一条轻量消息，迫使 LLM API 命中缓存前缀，随后撤回该条消息以保持对话上下文干净。

## 目标

- 自动保持活跃会话的 LLM API prompt cache 不失效
- 不影响用户正常对话体验（ping 后自动撤回，对用户透明）
- 可配置空闲阈值和检测间隔
- 仅在 Windows 桌面端使用（本地验证优先）

## 架构

```
┌──────────────────────────────────────────────────────────────┐
│                      opencode desktop                          │
│                                                               │
│  ┌──────────────┐   events       ┌─────────────────────────┐  │
│  │  session      │──────────────▶│  activeSessions          │  │
│  │   .created    │               │  Map<sessionID, {        │  │
│  │   .status     │               │    lastUserMessageTime,  │  │
│  │   .deleted    │               │    lastPingTime,         │  │
│  │  message.     │               │    isBusy,               │  │
│  │   .updated    │               │    failedPings,          │  │
│  └──────────────┘               │  }>                      │  │
│                                  └───────────┬─────────────┘  │
│                                              │                │
│                               setTimeout 递归自调度           │
│                               (.finally 保证不中断)           │
│                                ┌──────────▼──────────────┐   │
│                                │   scanAndPing()          │   │
│                                │  完成后 .finally 调度    │   │
│                                │  AbortSignal 巡查        │   │
│                                └──────────┬──────────────┘   │
│                                           │                  │
│                    for each session: idle > threshold?        │
│                    && !isBusy && failedPings < max            │
│                                           │                  │
│                    ┌──────────────────────▼───────────────┐   │
│                    │  prompt() 发送 ping_message           │   │
│                    │     → await AI 回复                    │   │
│                    │  revert 前检查 lastUserMessageTime    │   │
│                    │  是否 > pingStartTime                  │   │
│                    │  revert(assistant.parentID)            │   │
│                    │  → 回退整轮 exchange                   │   │
│                    │  更新 lastPingTime                     │   │
│                    │  用户活动时复位 failedPings            │   │
│                    └──────────────────────────────────────┘   │
│                                                               │
│  ┌──────────────┐   scheduleNext() 中检查                    │
│  │  AbortController  ← .finally 保证调用                     │
│  │  clearTimeout    ← 优雅停止                               │
│  └──────────────┘                                            │
└──────────────────────────────────────────────────────────────┘
```

## 核心数据结构

### activeSessions 内存 Map

```typescript
Map<sessionID, {
  lastUserMessageTime: number, // 仅用户消息的时间戳（ms）—— 用于竞态判断
  lastPingTime:        number, // 插件最近一次完成 ping 的 timestamp（ms）
  isBusy:              boolean,// 会话是否正在处理中
  failedPings:         number, // 连续 ping 失败次数（熔断用）
}>
```

### 为何区分 lastUserMessageTime 与 lastActivity

`message.updated` 在 AI 流式输出时频繁触发。若所有消息更新都刷新同一个时间戳，ping 期间的 AI 输出会导致竞态检查误判（以为是用户发了新消息），错误放弃 revert。

**方案**：仅用户消息（`role === "user"`）更新 `lastUserMessageTime`，竞态检查只用此字段。AI 输出只更新 `isBusy`（通过 `session.status`）。

### 空闲判断

```typescript
const effective = Math.max(meta.lastUserMessageTime, meta.lastPingTime)
if (!meta.isBusy && meta.failedPings < MAX_FAILED_PINGS && now - effective > idleThresholdMs) {
  // 触发 ping
}
```

### 只存内存

不需要持久化。插件重启后重新扫描已有会话，并检查是否有残留的未撤回 ping 消息。

## 事件处理

### 事件监听清单

所有事件通过同一个 `event` hook 分发，入口处 **try/catch 包裹全部事件处理逻辑**，防止单个事件异常中断整个 event stream。

| 事件 | type discriminator | 行为 |
|------|-------------------|------|
| `session.created` | `event.type === "session.created"` | 加入 Map：`isBusy=true`，`failedPings=0`，`lastUserMessageTime=Date.now()` |
| `session.status` | `event.type === "session.status"` | 更新 `isBusy`：`status.type === "idle"` → `false`，否则 → `true` |
| `message.updated` | `event.type === "message.updated"` | `role === "user"` 时更新 `lastUserMessageTime`；同时 **复位 `failedPings=0`**（用户活跃即熔断复位） |
| `session.deleted` | `event.type === "session.deleted"` | 从 Map 中删除 |

### 事件 payload 精确路径

根据 SDK types (`@opencode-ai/sdk` `types.gen.ts`)：

**`message.updated`：**
```
event.properties.info.sessionID     ← 全大写 ID
event.properties.info.role          ← "user" | "assistant"
event.properties.info.time.created   ← number (ms)
```

**`session.status`：**
```
event.properties.sessionID          ← 全大写 ID
event.properties.status.type        ← "idle" | "busy" | "retry" （对象 union，非字符串）
```

**`session.created`：**
```
event.properties.info.id            ← Session 对象内的 id
```

**`session.deleted`：**
```
event.properties.info.id            ← Session 对象内的 id
```

## 插件启动初始化

```typescript
// sleep 工具
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// 1. 从 worktree 路径读取配置（含容错回退）
let config: Config
try {
  const configPath = path.join(worktree, ".opencode", "plugins", "cache-warmer.json")
  config = JSON.parse(await fs.promises.readFile(configPath, "utf-8"))
} catch {
  config = DEFAULT_CONFIG  // 文件不存在/格式错误时使用默认值
}

// 2. 检查 enabled 标志
if (!config.enabled) return

// 3. 初始化 activeSessions Map
// 4. 带指数退避的 session.list()
async function initSessions(retries = 3, baseDelayMs = 5000): Promise<void> {
  for (let i = 0; i <= retries; i++) {
    try {
      const sessions = await client.session.list()
      for (const s of sessions.data ?? []) {
        activeSessions.set(s.id, {
          lastUserMessageTime: Date.now(),
          lastPingTime: 0,
          isBusy: true,          // 保守：启动时假设所有会话都忙
          failedPings: 0,
        })
      }
      // 扫描残留的未撤回 ping 消息并清理（每个会话独立 try/catch）
      await cleanupOrphanPings(sessions.data ?? [])
      return
    } catch (e) {
      if (i === retries) {
        console.error("[cache-warmer] session.list() failed after retries:", e)
        return
      }
      await sleep(baseDelayMs * (2 ** i))
    }
  }
}
```

### 启动后补扫

open code 重启后已存在的空闲会话不会触发 `session.created` 或 `message.updated`。因此在**首个 `checkIntervalMs` 周期**到达时额外执行一次 `client.session.list()` 补扫，确保所有已有会话被纳入 Map。

**注意**：此补扫仅执行一次，通过标志位控制。

### 启动时 isBusy 保守策略

初始化时所有会话 `isBusy = true`。后续收到 `session.status` 事件（`status.type === "idle"`）后才设为 `false`。这避免启动瞬间对正在工作中的会话误触发 ping。

### 残留孤儿 ping 清理

`cleanupOrphanPings` 对每个会话独立 try/catch（失败不影响其他会话清理）。检测方式：

1. 对每个会话，拉取最后 N 条消息（N=4）
2. 寻找 pattern：用户消息文本匹配 pingMessage + 紧随其后的 assistant 消息回复极短（如 ≤5 tokens）
3. 若匹配，从该用户消息的 ID 处执行 `revert()` 撤回整轮 exchange
4. 若该用户消息之前有更新的用户消息（说明用户已发新消息覆盖），**不撤回**（避免误删后续对话）
5. 每个会话的清理失败仅记录日志，不阻断整体流程

## 定时扫描

### setTimeout 递归自调度（.finally 保证不中断）

```typescript
let timer: ReturnType<typeof setTimeout> | null = null
let isScanning = false
const ac = new AbortController()

function scheduleNext() {
  if (ac.signal.aborted) return
  timer = setTimeout(() => {
    scanAndPing().finally(() => scheduleNext())
  }, checkIntervalMs)
}

async function scanAndPing() {
  if (isScanning || ac.signal.aborted) return
  isScanning = true
  try {
    const now = Date.now()
    const snapshot = new Map(activeSessions)  // 快照，避免循环中 Map 被事件修改

    for (const [id, meta] of snapshot) {
      if (ac.signal.aborted) break           // 每轮循环检查 AbortSignal
      if (meta.isBusy) continue
      if (meta.failedPings >= MAX_FAILED_PINGS) continue

      const effective = Math.max(meta.lastUserMessageTime, meta.lastPingTime)
      if (now - effective < idleThresholdMs) continue

      // 先尝试清理上次可能残留的孤儿 ping，再决定是否发新 ping
      const hasOrphan = await checkAndCleanOrphan(id)
      if (hasOrphan) {
        meta.lastPingTime = Date.now()
        continue  // 清理完成后不立即发新 ping，等下个周期再说
      }

      await executePing(id, meta, ac.signal)
    }
  } catch (unexpected) {
    console.error("[cache-warmer] scanAndPing unhandled:", unexpected)
  } finally {
    isScanning = false
  }
}
```

**关键保障**：
- `.finally(() => scheduleNext())` —— **无论 scanAndPing 成功/失败/抛异常，timer 链永不断裂**
- 循环中 `ac.signal.aborted` 检查 —— AbortController 真正生效
- Map 快照 —— 避免循环中 Map 被事件并发修改导致迭代器异常

### 执行 ping（含竞态保护、熔断、parentID revert）

```typescript
async function executePing(
  sessionID: string,
  meta: SessionMeta,
  signal: AbortSignal,
) {
  const pingStartTime = Date.now()

  try {
    // 发送 ping（不设 noReply，需要真实 API 调用来命中缓存）
    const result = await client.session.prompt({
      path: { id: sessionID },
      body: {
        parts: [{ type: "text", text: pingMessage }],
      },
    })

    if (signal.aborted) return

    // === 竞态检查 ===
    // 仅检查 lastUserMessageTime（用户消息时间戳），不受 AI 流式输出干扰
    if (meta.lastUserMessageTime > pingStartTime) {
      console.warn(`[cache-warmer] user msg during ping for ${sessionID}, skip revert`)
      meta.lastPingTime = Date.now()
      return
    }

    // === 撤回整轮对话 ===
    // prompt() 返回的 AssistantMessage.info.parentID 即为对应的用户消息 ID
    const userMsgID = result.data?.info?.parentID
    if (userMsgID) {
      await client.session.revert({
        path: { id: sessionID },
        body: { messageID: userMsgID },
      })
    } else {
      // fallback
      await client.session.command({
        path: { id: sessionID },
        body: { command: "/undo" },
      })
    }

    meta.lastPingTime = Date.now()
    meta.failedPings = 0  // 成功时复位熔断计数
  } catch (error) {
    meta.failedPings++
    meta.lastPingTime = Date.now()
    console.error(
      `[cache-warmer] ping failed for ${sessionID} (${meta.failedPings}/${MAX_FAILED_PINGS}):`,
      error,
    )

    if (meta.failedPings >= MAX_FAILED_PINGS) {
      console.warn(`[cache-warmer] session ${sessionID} circuit-breaker opened`)
    }
  }
}
```

### revert 方案：parentID 为主，command /undo 为 fallback

| 顺序 | 方法 | 说明 |
|------|------|------|
| 1 (首选) | `session.revert({ messageID: parentID })` | `prompt()` 返回的 `AssistantMessage.info.parentID` 就是用户 ping 消息 ID。传入它意味着"撤销该用户消息及之后所有消息" = 整轮 exchange |
| 2 (fallback) | `session.command({ command: "/undo" })` | 若 parentID 不可用 |

**注意**：SDK types 中 revert 的 body 参数名为 `messageID`（大写 D），不是 `messageId`。

## 插件生命周期 & 清理

```typescript
// 插件主函数
export const CacheWarmer = async ({ client, directory, worktree }) => {
  const ac = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  let firstScanDone = false

  // 读取配置、初始化、启动定时器...

  // 首次定时器回调中额外补扫（仅一次）
  // scheduleNext() 中：if (!firstScanDone) { await initSessions(1, 1000); firstScanDone = true }

  // opencode 当前不提供 plugin dispose 回调。
  // AbortController 已嵌入 scheduleNext 开关 和 scanAndPing 循环内检查。
  // timer.unref() 在 Node.js 中防止阻止进程退出（Bun 默认 unref，不需要）。
  // 如果未来 opencode 支持 deactivate hook，在其中执行：
  //   ac.abort()
  //   if (timer) clearTimeout(timer)
  //   activeSessions.clear()
}
```

## 配置

### 文件位置

`.opencode/plugins/cache-warmer.json`（通过 `path.join(worktree, ".opencode", "plugins", "cache-warmer.json")` 读取）

本插件**仅读取独立配置文件**，不读取 `opencode.json` 中的 plugincfg 字段。修改配置后需重启 opencode 生效。

### 配置项

```json
{
  "idle_threshold_minutes": 60,
  "check_interval_minutes": 10,
  "ping_message": "hi",
  "max_failed_pings": 3,
  "enabled": true
}
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `idle_threshold_minutes` | number | 60 | 会话空闲多久后触发 ping |
| `check_interval_minutes` | number | 10 | 检测间隔 |
| `ping_message` | string | `"hi"` | ping 时发送的消息文本（纯 ASCII） |
| `max_failed_pings` | number | 3 | 连续失败多少次后熔断（用户新消息自动复位） |
| `enabled` | boolean | true | 插件启用开关（false 时不启动 timer） |

**说明**：`idle_threshold_minutes` 默认 60 分钟不是为匹配 Claude 5 分钟 TTL，而是匹配用户"长时间不操作"的语义。每次 ping 本身就能刷新 5 分钟缓存。

### 配置容错

读取失败（文件不存在、格式错误）时回退到以上默认值，插件不崩溃。

## 文件清单

```
.opencode/plugins/
  cache-warmer.ts          ← 主插件代码
  cache-warmer.json        ← 配置文件
```

无需额外 npm 依赖。仅使用 opencode 内置 SDK `client` 与 Node.js/Bun 内置模块（`fs`、`path`、`timers`）。

## 风险与缓解

| 风险 | 严重度 | 缓解 |
|------|--------|------|
| timer 链静默断裂 | 高 | `setTimeout(() => scanAndPing().finally(() => scheduleNext()))` —— finally 保证链永不断 |
| 事件 payload 字段名不匹配 | 高 | v3 已逐字段验证 SDK types：`session.status` 用 `sessionID` + `status.type`；`created/deleted` 用 `info.id` |
| 熔断后永不恢复 | 中 | `message.updated`（用户发消息）时 `failedPings = 0`，用户活跃即复位 |
| AbortController 形同虚设 | 中 | `scheduleNext()` 检查 `signal.aborted`；`scanAndPing()` 循环内每轮检查；`executePing()` prompt 返回后检查 |
| ping 期间用户发消息被误判 | 低 | 仅 `lastUserMessageTime`（role===user）参与竞态判断，不受 AI 流式输出干扰 |
| revert 撤销错误轮次 | 中 | 使用 `parentID`（精确匹配用户 ping 消息 ID）而非扫描 messages；fallback `/undo` |
| 启动时 server 未 ready | 中 | 指数退避重试 + 首轮补扫 + 后续事件渐进补全 |
| 孤儿 ping 残留 | 中 | 启动时模式匹配清理（最后 N 条消息）；运行时每轮扫描前先检查并清理 |
| 已废弃会话永驻 Map | 低 | 熔断后 `failedPings >= max` → 永久跳过；后续可加 TTL 淘汰 |
| opencode 无 dispose 回调 | 低 | AbortController 嵌入各处检查点；`timer.unref()` 防止阻止退出 |

## 变更记录

### v3 (基于四代理复审修订)

- **事件 payload 路径全面修正**：`session.status` 用 `sessionID` + `status.type`（对象 union）；`created/deleted` 用 `info.id`
- **timer 链断裂修复**：`await scanAndPing(); scheduleNext()` → `.finally(() => scheduleNext())`
- **竞态判断修正**：区分 `lastUserMessageTime`（仅用户消息）与 AI 流式输出，防止误判
- **revert 方案简化**：利用 `AssistantMessage.parentID` 直接获取用户消息 ID，无需扫描 messages
- **熔断复位**：`message.updated` 事件中用户消息时复位 `failedPings = 0`
- **AbortController 实质化**：循环内每轮 + prompt 返回后均检查 `signal.aborted`
- **孤儿清理增强**：检查最后 N 条消息的 pattern 匹配；每个会话独立 try/catch
- **配置容错**：读取失败回退默认值；`enabled=false` 时不启动 timer；增加首轮补扫
- **sleep 函数定义**：`const sleep = ms => new Promise(r => setTimeout(r, ms))`
- **事件 handler 入口 try/catch**：防止单事件异常中断整个 event stream
- 默认 `ping_message` 改为纯 ASCII `"hi"`

### v2 (基于四代理初审修订)

- `setInterval` → `setTimeout` 递归自调度 + `isScanning` 互斥 + `AbortController`
- API 字段名修正、事件 payload 路径明确化、`session.created` 事件处理
- 启动重试、熔断、isBusy 保守初始化、孤儿 ping 清理、revert 决策树
