/**
 * activeAgentHistory —— Phase 3 Sprint 3.4:跨进程可查的 agent 历史。
 *
 * 当前的 activeAgentRegistry 只在内存里保留终止记录(默认 500 条,
 * 进程重启即清空)。许多运维场景需要回看"昨天那个 Plan agent 跑成什么样?"
 *
 * 方案:终止时把 agent 序列化到 JSONL 单文件(append-only),启动时
 * 一次性读进内存缓存;超过 `MAX_HISTORY_RECORDS` 时文件被 rotate
 * (只保留最后 N 条重写回去)。
 *
 * 为什么 JSONL 而不是 sqlite / IndexedDB:
 *   - 量小(5000 条约 1-2 MB),没必要引入查询引擎
 *   - append-only 即便中途崩溃也不会毁掉已持久化的条目
 *   - 纯文本,用户可以 `tail` / grep 诊断
 *
 * 敏感字段过滤:
 *   - 不序列化 `messages` / `pendingMessages` 内容(对话文本含敏感
 *     数据;只记 `pendingMessageCount` 计数)
 *   - 不序列化 `agentDef`(含 closures + system prompt 可能含密钥)
 *   - 其它 ActiveAgent 字段按现有 `agents:list-active` 的
 *     serialization 规则(只暴露 UI 需要的)
 */

import fs from 'node:fs'
import path from 'node:path'
import type { ActiveAgent, AgentDefinitionPermissionMode } from './types'
import { DEFAULT_AGENT_TIMEOUT_MS, DEFAULT_MAX_AGENT_TOKEN_BUDGET } from './activeAgentRegistry'

export interface AgentHistoryRecord {
  agentId: string
  agentType: string
  description: string
  name?: string
  teamName?: string
  status: 'completed' | 'failed' | 'killed'
  startTime: number
  endedAt: number
  tokenCount: number
  maxTokenBudget: number
  tokenBudgetExceeded: boolean
  timeoutMs: number
  pendingMessageCount: number
  parentAgentId?: string
  streamConversationId?: string
  background: boolean
  model?: string
  /**
   * P1-1: spawn-time permission mode snapshot. Optional — older history
   * lines pre-P1-1 won't carry it, and forward-compat upgrades may add
   * permission modes the consumer doesn't recognize. Renderer treats
   * unknown / missing values as "no badge".
   */
  permissionMode?: AgentDefinitionPermissionMode
  /** 方便后续"历史 vs 实时"区分 —— renderer 可以给历史条目加淡色标记。 */
  fromDisk: true
}

/**
 * 环境变量上限 —— 默认 5000 条约 1-2MB JSON 文本。实际用户量达到
 * 这个级别的很少;超上限时保留最新 N 条。
 */
const MAX_HISTORY_RECORDS = Math.max(
  100,
  Math.min(100_000, Number(process.env.POLE_AGENT_HISTORY_MAX ?? '5000')),
)

let historyFilePath: string | null = null
/** In-memory mirror of disk. Avoids reading JSONL on every IPC call. */
let memoryCache: AgentHistoryRecord[] = []
/** Dedupe guard: agentId that have already been appended. Cleared
 *  after rotate. */
const appendedIds = new Set<string>()

/**
 * Initialize at app boot. Reads the existing file into memory and
 * primes the dedupe set. Safe to call before the dir exists.
 */
export function initAgentHistoryStore(userDataPath: string): void {
  try {
    const dir = path.join(userDataPath, 'agent-history')
    fs.mkdirSync(dir, { recursive: true })
    historyFilePath = path.join(dir, 'records.jsonl')
  } catch (err) {
    console.warn('[agentHistory] init failed:', err)
    historyFilePath = null
    return
  }
  loadFromDisk()
}

function loadFromDisk(): void {
  if (!historyFilePath || !fs.existsSync(historyFilePath)) {
    memoryCache = []
    appendedIds.clear()
    return
  }
  try {
    const raw = fs.readFileSync(historyFilePath, 'utf-8')
    const lines = raw.split('\n')
    const records: AgentHistoryRecord[] = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const obj = JSON.parse(trimmed) as AgentHistoryRecord
        // Minimal shape validation — reject entries that lost required
        // fields from forward-incompatible upgrades rather than crash.
        if (
          typeof obj.agentId === 'string' &&
          typeof obj.agentType === 'string' &&
          typeof obj.startTime === 'number'
        ) {
          records.push({ ...obj, fromDisk: true })
        }
      } catch {
        /* tolerate line-level corruption */
      }
    }
    // If we've drifted over the cap on disk, rotate on the way in.
    if (records.length > MAX_HISTORY_RECORDS) {
      const kept = records.slice(records.length - MAX_HISTORY_RECORDS)
      memoryCache = kept
      appendedIds.clear()
      for (const r of kept) appendedIds.add(r.agentId)
      rewriteFile()
    } else {
      memoryCache = records
      appendedIds.clear()
      for (const r of records) appendedIds.add(r.agentId)
    }
  } catch (err) {
    console.warn('[agentHistory] loadFromDisk failed:', err)
    memoryCache = []
    appendedIds.clear()
  }
}

/** Rewrite the file from memoryCache — used after rotate. */
function rewriteFile(): void {
  if (!historyFilePath) return
  try {
    const content = memoryCache.map((r) => JSON.stringify(r)).join('\n') + '\n'
    fs.writeFileSync(historyFilePath, content, 'utf-8')
  } catch (err) {
    console.warn('[agentHistory] rewriteFile failed:', err)
  }
}

/**
 * Serialize an in-memory ActiveAgent into the disk shape. Called right
 * before the registry drops the row (in `unregisterActiveAgent` or
 * within the capacity cleanup path).
 *
 * Safe to call even if init never ran — we just skip disk IO and
 * keep the in-memory cache. Renderer still sees the record via
 * `agents:list-active` because it's in `memoryCache`.
 */
export function recordAgentTerminal(agent: ActiveAgent): void {
  if (agent.status === 'running') return
  if (appendedIds.has(agent.agentId as unknown as string)) return

  const rec: AgentHistoryRecord = {
    agentId: agent.agentId as unknown as string,
    agentType: agent.agentType,
    description: agent.description,
    name: agent.name,
    teamName: agent.teamName,
    status: agent.status,
    startTime: agent.startTime,
    endedAt: agent.endedAt ?? Date.now(),
    tokenCount: agent.tokenCount ?? 0,
    maxTokenBudget: agent.agentDef.maxTokenBudget ?? DEFAULT_MAX_AGENT_TOKEN_BUDGET,
    tokenBudgetExceeded: agent.tokenBudgetExceeded === true,
    timeoutMs: agent.agentDef.timeout ?? DEFAULT_AGENT_TIMEOUT_MS,
    pendingMessageCount: agent.pendingMessages.length,
    parentAgentId: agent.parentAgentId,
    streamConversationId: agent.streamConversationId,
    background: agent.agentDef.background === true,
    model: agent.agentDef.model,
    ...(agent.permissionModeSnapshot !== undefined
      ? { permissionMode: agent.permissionModeSnapshot }
      : {}),
    fromDisk: true,
  }

  memoryCache.push(rec)
  appendedIds.add(rec.agentId)

  if (historyFilePath) {
    try {
      fs.appendFileSync(historyFilePath, JSON.stringify(rec) + '\n', 'utf-8')
    } catch (err) {
      console.warn('[agentHistory] append failed:', err)
    }
  }

  // Rotate when overshoot. Keep most-recent N; the "drop old" policy
  // matches the in-memory registry's FIFO terminal eviction.
  if (memoryCache.length > MAX_HISTORY_RECORDS) {
    const kept = memoryCache.slice(memoryCache.length - MAX_HISTORY_RECORDS)
    // Rebuild dedupe set from the kept slice (the evicted ids are
    // free to be re-appended if they somehow appear again — rare).
    memoryCache = kept
    appendedIds.clear()
    for (const r of kept) appendedIds.add(r.agentId)
    rewriteFile()
  }
}

/** Snapshot of the current in-memory mirror. Renderer reads via
 *  `agents:list-active` which merges this with live agents. */
export function getAgentHistorySnapshot(): AgentHistoryRecord[] {
  return memoryCache.slice()
}

/** Clear all history (test / admin utility). Not wired to UI yet. */
export function clearAgentHistory(): void {
  memoryCache = []
  appendedIds.clear()
  if (historyFilePath) {
    try {
      fs.writeFileSync(historyFilePath, '', 'utf-8')
    } catch {
      /* ignore */
    }
  }
}
