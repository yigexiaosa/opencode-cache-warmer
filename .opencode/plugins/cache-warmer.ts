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
  lastMessageTime: number
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

  const activeSessions = new Map<string, SessionMeta>()
  const MAX_FAILED_PINGS = config.max_failed_pings
  const IDLE_THRESHOLD_MS = config.idle_threshold_minutes * 60 * 1000
  const CHECK_INTERVAL_MS = config.check_interval_minutes * 60 * 1000
  const PING_MESSAGE = config.ping_message

  // 启动初始化：带指数退避重试的 session.list()
  async function initSessions(retries = 3, baseDelayMs = 5000): Promise<void> {
    for (let i = 0; i <= retries; i++) {
      try {
        const sessions = await client.session.list()
        const list = (sessions as any).data ?? []
        for (const s of list) {
          if (!s.id) continue
          activeSessions.set(s.id, {
            lastMessageTime: Date.now(),
            lastPingTime: 0,
            isBusy: true,
            failedPings: 0,
          })
        }
        return
      } catch (e) {
        if (i === retries) {
          return
        }
        await sleep(baseDelayMs * (2 ** i))
      }
    }
  }

  // 启动初始化
  initSessions()

  // 定时扫描
  let timer: ReturnType<typeof setTimeout> | null = null
  let isScanning = false
  let firstScanDone = false
  const ac = new AbortController()

  async function executePing(
    sessionID: string,
    meta: SessionMeta,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      // 发送 ping 前：检查最近一条用户消息是否为上次的 ping → 是则 undo
      try {
        const msgs = await client.session.messages({ path: { id: sessionID } })
        const list = (msgs as any).data ?? []
        let lastUserMsg: any = null
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].info?.role === "user") {
            lastUserMsg = list[i]
            break
          }
        }
        if (lastUserMsg) {
          const parts = lastUserMsg.parts ?? []
          const text = parts
            .filter((p: any) => p.type === "text")
            .map((p: any) => p.text)
            .join("")
          if (text === PING_MESSAGE) {
            await client.session.revert({
              path: { id: sessionID },
              body: { messageID: lastUserMsg.info.id },
            })
          }
        }
      } catch (e) {
      }

      if (signal.aborted) return

      // 发送新 ping
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          parts: [{ type: "text", text: PING_MESSAGE }],
        },
      })

      meta.lastPingTime = Date.now()
      meta.failedPings = 0
    } catch (error) {
      meta.failedPings++
      meta.lastPingTime = Date.now()
      if (meta.failedPings >= MAX_FAILED_PINGS) {
      }
    }
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

        const effective = Math.max(meta.lastMessageTime, meta.lastPingTime)
        if (now - effective < IDLE_THRESHOLD_MS) continue

        await executePing(id, meta, ac.signal)
      }
    } catch (unexpected) {
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

  return {
    event: async (input) => {
      try {
        const evt = input.event

        if (evt.type === "session.created") {
          const sessionID = (evt.properties as any).info?.id
          if (!sessionID) return
          activeSessions.set(sessionID, {
            lastMessageTime: Date.now(),
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

          const meta = activeSessions.get(sessionID)
          if (meta) {
            meta.lastMessageTime = Date.now()
            meta.failedPings = 0
          }
        }

        else if (evt.type === "session.deleted") {
          const sessionID = (evt.properties as any).info?.id
          if (!sessionID) return
          activeSessions.delete(sessionID)
        }
      } catch (err) {
      }
    },
  }
}
