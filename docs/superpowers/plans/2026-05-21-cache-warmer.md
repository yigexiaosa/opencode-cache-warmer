# cache-warmer 插件实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 opencode cache-warmer 插件，周期性检测活跃会话空闲时间，自动发送轻量消息维持 LLM API prompt cache，随后撤回消息保持对话上下文干净。

**Architecture:** 单文件 TS 插件 + JSON 配置文件。通过 event hook 监听会话生命周期维护内存中的活跃会话 Map，用 setTimeout 递归自调度实现定时扫描，SDK client 发送 prompt 并用 parentID 精确 revert 撤回。

**Tech Stack:** TypeScript, opencode Plugin API (`@opencode-ai/plugin` types), opencode SDK client, Node.js/Bun 内置模块 (`fs`, `path`, `timers`)

**Spec:** `docs/superpowers/specs/2026-05-21-cache-warmer-design.md`

---

## 文件结构

```
.opencode/plugins/
  cache-warmer.ts          ← 主插件代码（~300 行）
  cache-warmer.json        ← 配置文件（5 个字段）
```

- `cache-warmer.ts`：插件入口、配置加载、事件处理、定时扫描、ping 执行、孤儿清理
- `cache-warmer.json`：用户可配置项（idle_threshold、check_interval、ping_message、max_failed_pings、enabled）

> **注意**：opencode 插件在 `.opencode/plugins/` 下的 TS 文件会被自动加载，无需在 `opencode.json` 中声明（但也可加 `"plugin": [".opencode/plugins/cache-warmer.ts"]` 显式引用）。

---

### Task 1: 创建配置文件

**Files:**
- Create: `.opencode/plugins/cache-warmer.json`

- [ ] **Step 1: 写入默认配置**

```json
{
  "idle_threshold_minutes": 60,
  "check_interval_minutes": 10,
  "ping_message": "hi",
  "max_failed_pings": 3,
  "enabled": true
}
```

- [ ] **Step 2: 验证文件存在**

```powershell
Test-Path ".opencode/plugins/cache-warmer.json"
```
Expected: `True`

- [ ] **Step 3: Commit**

```bash
git add .opencode/plugins/cache-warmer.json
git commit -m "feat: add cache-warmer config file"
```

---

### Task 2: 插件骨架 + 配置加载

**Files:**
- Create: `.opencode/plugins/cache-warmer.ts`

- [ ] **Step 1: 写入 TypeScript 类型定义和默认配置**

```typescript
import type { Plugin } from "@opencode-ai/plugin"
import * as path from "path"
import * as fs from "fs"

interface CacheWarmerConfig {
  idle_threshold_minutes: number
  check_interval_minutes: number
  ping_message: string
  max_failed_pings: number
  enabled: boolean
}

const DEFAULT_CONFIG: CacheWarmerConfig = {
  idle_threshold_minutes: 60,
  check_interval_minutes: 10,
  ping_message: "hi",
  max_failed_pings: 3,
  enabled: true,
}

interface SessionMeta {
  lastUserMessageTime: number
  lastPingTime: number
  isBusy: boolean
  failedPings: number
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export const CacheWarmer: Plugin = async ({ client, directory, worktree }) => {
  // 加载配置（含容错回退）
  let config: CacheWarmerConfig
  try {
    const configPath = path.join(worktree, ".opencode", "plugins", "cache-warmer.json")
    config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath, "utf-8")) }
  } catch {
    config = { ...DEFAULT_CONFIG }
  }

  if (!config.enabled) return {}

  console.log("[cache-warmer] plugin started with config:", config)

  return {
    event: async () => {},
  }
}
```

- [ ] **Step 2: 验证 TypeScript 编译通过**

```powershell
# 如果有 tsc
npx tsc --noEmit .opencode/plugins/cache-warmer.ts
```
如果失败：修复类型错误后重新验证。

- [ ] **Step 3: Commit**

```bash
git add .opencode/plugins/cache-warmer.ts
git commit -m "feat: add cache-warmer plugin skeleton with config loading"
```

---

### Task 3: activeSessions Map + 事件处理

**Files:**
- Modify: `.opencode/plugins/cache-warmer.ts`

- [ ] **Step 1: 在插件主函数中加入 activeSessions Map 和事件 handler**

在 `if (!config.enabled) return {}` 之后、`return` 之前插入：

```typescript
  const activeSessions = new Map<string, SessionMeta>()
  const MAX_FAILED_PINGS = config.max_failed_pings
  const IDLE_THRESHOLD_MS = config.idle_threshold_minutes * 60 * 1000
  const CHECK_INTERVAL_MS = config.check_interval_minutes * 60 * 1000
  const PING_MESSAGE = config.ping_message
```

替换 `return { event: async () => {}, }` 为：

```typescript
  return {
    event: async (input) => {
      try {
        const { event: evt } = input

        if (evt.type === "session.created") {
          const sessionID = (evt.properties as any).info?.id
          if (!sessionID) return
          activeSessions.set(sessionID, {
            lastUserMessageTime: Date.now(),
            lastPingTime: 0,
            isBusy: true,
            failedPings: 0,
          })
        }

        else if (evt.type === "session.status") {
          const sessionID = (evt.properties as any).sessionID
          if (!sessionID) return
          const meta = activeSessions.get(sessionID)
          if (!meta) return
          const status = (evt.properties as any).status
          meta.isBusy = !(status && status.type === "idle")
        }

        else if (evt.type === "message.updated") {
          const info = (evt.properties as any).info
          if (!info) return
          const sessionID = info.sessionID as string | undefined
          if (!sessionID) return
          const role = info.role as string | undefined

          const meta = activeSessions.get(sessionID)
          if (meta) {
            if (role === "user") {
              meta.lastUserMessageTime = Date.now()
              meta.failedPings = 0 // 用户活跃即熔断复位
            }
          }
        }

        else if (evt.type === "session.deleted") {
          const sessionID = (evt.properties as any).info?.id
          if (!sessionID) return
          activeSessions.delete(sessionID)
        }
      } catch (err) {
        console.error("[cache-warmer] event handler error:", err)
      }
    },
  }
```

- [ ] **Step 2: Commit**

```bash
git add .opencode/plugins/cache-warmer.ts
git commit -m "feat: add activeSessions map and event handlers"
```

---

### Task 4: 启动初始化 + 孤儿清理

**Files:**
- Modify: `.opencode/plugins/cache-warmer.ts`

- [ ] **Step 1: 在 config 加载之后、return 之前加入 initSessions 函数**

```typescript
  // 启动初始化：带指数退避重试的 session.list()
  async function initSessions(retries = 3, baseDelayMs = 5000): Promise<void> {
    for (let i = 0; i <= retries; i++) {
      try {
        const sessions = await client.session.list()
        const list = (sessions as any).data ?? []
        for (const s of list) {
          if (!s.id) continue
          activeSessions.set(s.id, {
            lastUserMessageTime: Date.now(),
            lastPingTime: 0,
            isBusy: true,
            failedPings: 0,
          })
        }
        await cleanupOrphanPings(list)
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

  // 孤儿 ping 清理：扫描会话最后 N 条消息
  async function cleanupOrphanPings(sessions: any[]): Promise<void> {
    for (const s of sessions) {
      if (!s.id) continue
      try {
        const msgs = await client.session.messages({ path: { id: s.id } })
        const list = (msgs as any).data ?? []
        if (list.length < 2) continue

        const recent = list.slice(-4)
        for (let i = 0; i < recent.length - 1; i++) {
          const curr = recent[i]
          const next = recent[i + 1]
          const currParts = curr.parts ?? []
          const currText = currParts
            .filter((p: any) => p.type === "text")
            .map((p: any) => p.text)
            .join("")

          if (
            curr.info?.role === "user" &&
            currText === PING_MESSAGE &&
            next.info?.role === "assistant"
          ) {
            // 检查该消息之后是否有更新用户消息
            const afterIdx = list.findIndex(
              (m: any) => m.info?.id === curr.info?.id
            )
            const hasNewerUserMsg = list.slice(afterIdx + 1).some(
              (m: any) => m.info?.role === "user" && m.info?.id !== curr.info?.id
            )
            if (hasNewerUserMsg) continue

            await client.session.revert({
              path: { id: s.id },
              body: { messageID: curr.info.id },
            })
            console.log(`[cache-warmer] cleaned up orphan ping in session ${s.id}`)
            break
          }
        }
      } catch (e) {
        console.error(`[cache-warmer] orphan cleanup failed for ${s.id}:`, e)
      }
    }
  }

  // 启动初始化
  initSessions()
```

- [ ] **Step 2: Commit**

```bash
git add .opencode/plugins/cache-warmer.ts
git commit -m "feat: add start init with retry and orphan cleanup"
```

---

### Task 5: 定时扫描 + setTimeout 递归自调度

**Files:**
- Modify: `.opencode/plugins/cache-warmer.ts`

- [ ] **Step 1: 在 initSessions 调用之后、return 之前加入 scanAndPing 和 scheduleNext**

```typescript
  // 定时扫描
  let timer: ReturnType<typeof setTimeout> | null = null
  let isScanning = false
  let firstScanDone = false
  const ac = new AbortController()

  async function checkAndCleanOrphan(sessionID: string): Promise<boolean> {
    try {
      const msgs = await client.session.messages({ path: { id: sessionID } })
      const list = (msgs as any).data ?? []
      if (list.length < 2) return false

      const recent = list.slice(-4)
      for (let i = 0; i < recent.length - 1; i++) {
        const curr = recent[i]
        const next = recent[i + 1]
        const currParts = curr.parts ?? []
        const currText = currParts
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .join("")

        if (
          curr.info?.role === "user" &&
          currText === PING_MESSAGE &&
          next.info?.role === "assistant"
        ) {
          const afterIdx = list.findIndex((m: any) => m.info?.id === curr.info?.id)
          const hasNewerUserMsg = list.slice(afterIdx + 1).some(
            (m: any) => m.info?.role === "user" && m.info?.id !== curr.info?.id
          )
          if (hasNewerUserMsg) continue

          await client.session.revert({
            path: { id: sessionID },
            body: { messageID: curr.info.id },
          })
          console.log(`[cache-warmer] runtime orphan cleanup in session ${sessionID}`)
          return true
        }
      }
    } catch (e) {
      console.error(`[cache-warmer] checkOrphan failed for ${sessionID}:`, e)
    }
    return false
  }

  async function scanAndPing(): Promise<void> {
    if (isScanning || ac.signal.aborted) return
    isScanning = true
    try {
      // 首轮补扫
      if (!firstScanDone) {
        await initSessions(1, 1000)
        firstScanDone = true
      }

      const now = Date.now()
      const snapshot = new Map(activeSessions)

      for (const [id, meta] of snapshot) {
        if (ac.signal.aborted) break
        if (meta.isBusy) continue
        if (meta.failedPings >= MAX_FAILED_PINGS) continue

        const effective = Math.max(meta.lastUserMessageTime, meta.lastPingTime)
        if (now - effective < IDLE_THRESHOLD_MS) continue

        // 先清理残留孤儿
        await checkAndCleanOrphan(id)

        // 执行 ping（注意：这里复用 executePing 函数，定义见 Task 6）
        // 暂时留空，Task 6 补充
      }
    } catch (unexpected) {
      console.error("[cache-warmer] scanAndPing unhandled:", unexpected)
    } finally {
      isScanning = false
    }
  }

  function scheduleNext(): void {
    if (ac.signal.aborted) return
    timer = setTimeout(() => {
      scanAndPing().finally(() => scheduleNext())
    }, CHECK_INTERVAL_MS)
  }

  // 启动定时器
  scheduleNext()
```

> **注意**：`scanAndPing` 中 `executePing` 调用将在 Task 6 补充。当前循环内 `checkAndCleanOrphan` 之后暂时为空（仅清理孤儿）。

- [ ] **Step 2: Commit**

```bash
git add .opencode/plugins/cache-warmer.ts
git commit -m "feat: add setTimeout-based scan loop and runtime orphan cleanup"
```

---

### Task 6: executePing + parentID revert

**Files:**
- Modify: `.opencode/plugins/cache-warmer.ts`

- [ ] **Step 1: 在 scanAndPing 函数上方插入 executePing 函数**

在 `async function scanAndPing` 之前插入：

```typescript
  async function executePing(
    sessionID: string,
    meta: SessionMeta,
    signal: AbortSignal,
  ): Promise<void> {
    const pingStartTime = Date.now()

    try {
      const result = await client.session.prompt({
        path: { id: sessionID },
        body: {
          parts: [{ type: "text", text: PING_MESSAGE }],
        },
      })

      if (signal.aborted) return

      // 竞态检查：仅检查用户消息时间戳
      if (meta.lastUserMessageTime > pingStartTime) {
        console.warn(`[cache-warmer] user msg during ping for ${sessionID}, skip revert`)
        meta.lastPingTime = Date.now()
        return
      }

      // 撤回整轮对话：使用 parentID
      const parentID = (result as any).data?.info?.parentID as string | undefined
      if (parentID) {
        await client.session.revert({
          path: { id: sessionID },
          body: { messageID: parentID },
        })
      } else {
        // fallback
        await (client.session as any).command({
          path: { id: sessionID },
          body: { command: "/undo" },
        })
      }

      meta.lastPingTime = Date.now()
      meta.failedPings = 0
      console.log(`[cache-warmer] ping + revert success for ${sessionID}`)
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

- [ ] **Step 2: 在 scanAndPing 的 for 循环中补上 executePing 调用**

在 `for (const [id, meta] of snapshot)` 循环内，`await checkAndCleanOrphan(id)` 之后添加：

```typescript
        await executePing(id, meta, ac.signal)
```

- [ ] **Step 3: Commit**

```bash
git add .opencode/plugins/cache-warmer.ts
git commit -m "feat: add executePing with parentID revert and circuit breaker"
```

---

### Task 7: 完整性验证

**Files:**
- Read: `.opencode/plugins/cache-warmer.ts`

- [ ] **Step 1: 检查所有导入/类型/函数完整性**

确认文件包含以下所有内容且无缺失：

```typescript
// 导入
import type { Plugin } from "@opencode-ai/plugin"
import * as path from "path"
import * as fs from "fs"

// 类型
interface CacheWarmerConfig { ... }
interface SessionMeta { ... }

// 常量
const DEFAULT_CONFIG: CacheWarmerConfig = { ... }
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// 导出
export const CacheWarmer: Plugin = async ({ client, directory, worktree }) => {
  // 配置加载（try/catch）
  // enabled 检查（!config.enabled → return {}）
  // activeSessions Map + 常量
  // initSessions() 定义（指数退避 + cleanupOrphanPings）
  // cleanupOrphanPings() 定义（模式匹配 + 独立 try/catch）
  // checkAndCleanOrphan() 定义（运行时孤儿清理）
  // executePing() 定义（parentID revert + 竞态 + 熔断）
  // scanAndPing() 定义（快照 + AbortSignal + 首轮补扫）
  // scheduleNext() 定义（.finally 防断链 + AbortController 守卫）
  // 启动：initSessions(); scheduleNext()
  // return { event: async (input) => { try/catch + 4 事件类型窄化 } }
}
```

- [ ] **Step 2: 对照 spec 关键点逐项确认**

| spec 要求 | 实现对应 |
|-----------|---------|
| 事件 payload 路径 `sessionID`/`info.id`/`status.type` | `event` handler 中各类型分支 |
| timer 链 .finally 不中断 | `scheduleNext` 中 `.finally(() => scheduleNext())` |
| 竞态只查 `lastUserMessageTime` | `executePing` 中 `meta.lastUserMessageTime > pingStartTime` |
| revert 用 `parentID` | `executePing` 中 `result.data?.info?.parentID` |
| 熔断复位 | `message.updated` 中 `role==="user"` → `failedPings=0` |
| 配置容错 | 顶层 `try/catch` 回退 `DEFAULT_CONFIG` |
| 孤儿清理 pattern 匹配 | `cleanupOrphanPings` + `checkAndCleanOrphan` |
| `enabled=false` 不启动 | 配置加载后 `if (!config.enabled) return {}` |

- [ ] **Step 3: 验证文件语法（可选，取决于是否有 tsc）**

```powershell
# 确认文件没有明显的语法错误
Get-Content ".opencode/plugins/cache-warmer.ts" | Select-Object -First 5
```

- [ ] **Step 4: Commit**

```bash
git add .opencode/plugins/cache-warmer.ts
git commit -m "chore: finalize cache-warmer plugin implementation"
```

---

### Task 8: 提交最终版本标记

- [ ] **Step 1: 确认所有文件已提交**

```bash
git status
```
Expected: `nothing to commit, working tree clean`（或仅有未跟踪的非相关文件）

- [ ] **Step 2: 查看最终 diff**

```bash
git diff HEAD~7 --stat
```
Expected: 显示 2 个文件的变更统计。

- [ ] **Step 3: 轻量标签（可选）**

```bash
git tag v0.1.0-cache-warmer
```

---

## 实现检查清单

| # | 组件 | 状态 |
|---|------|------|
| 1 | 配置文件 cache-warmer.json | `[ ]` |
| 2 | 插件骨架 + config 加载 | `[ ]` |
| 3 | activeSessions Map + 4 事件处理 | `[ ]` |
| 4 | 启动初始化 + 孤儿清理 | `[ ]` |
| 5 | 定时扫描 + setTimeout 递归 | `[ ]` |
| 6 | executePing + parentID revert | `[ ]` |
| 7 | 完整性验证 | `[ ]` |
| 8 | 最终提交 | `[ ]` |
