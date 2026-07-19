/**
 * upstream report §3.1 step 9 — best-effort cleanup after a sub-agent run.
 * MCP: servers **opened during this run** are released via refcount + disconnect when last lease ends.
 * Pre-existing shared MCP sessions (user/UI connected before the run) are not in `mcpLeaseReleaseNames`.
 */

import { taskRuntimeStore } from '../tools/TaskRuntimeStore'
import type { AgentId } from '../tools/ids'
import { resetTodos } from '../tools/TodoWriteTool'
import { taskManager } from '../tools/TaskManager'
import { isTodoV2Enabled } from '../tools/todoMode'
import { killShellTasksForAgent } from '../tools/tasks/ShellTaskManager'
import { getWorkspacePath } from '../tools/workspaceState'
import { getActiveAgent } from './activeAgentRegistry'
import { getSubAgentSidechainTranscript, clearSubAgentSidechain } from './subAgentSidechainTranscript'
import { persistSubAgentSidechainSnapshot } from './subAgentSidechainDisk'
import { logAsyncAgentPhase } from './asyncAgentLifecycle'
import { releaseSubAgentMcpLease } from '../mcp/subAgentMcpLease'
import { drainProcessCommandQueueForAgent } from './processCommandQueue'
import { clearInvokedSkillsForAgent } from '../skills/invokedSkillsRegistry'

export type SubAgentFinalizeMeta = {
  streamConversationId?: string | null
  /** Servers first connected in this run’s {@link ensureMcpServersConnected}; released with refcount. */
  mcpLeaseReleaseNames?: string[]
}

export async function finalizeSubAgentLifecycle(
  agentId: AgentId,
  meta?: SubAgentFinalizeMeta,
): Promise<void> {
  try {
    await killShellTasksForAgent(agentId)
  } catch (e) {
    console.warn('[SubAgent] killShellTasksForAgent failed:', e)
  }
  try {
    taskRuntimeStore.unlinkAlias(agentId)
  } catch {
    /* ignore */
  }
  try {
    taskRuntimeStore.removeRecord(agentId)
  } catch {
    /* ignore */
  }
  try {
    resetTodos(agentId)
  } catch {
    /* ignore */
  }
  // upstream parity (`unassignTeammateTasks`): in V2 mode the V1
  // todo store is empty; the equivalent state to clean up is open
  // V2 tasks structurally bound to this agent. We release ownership
  // rather than delete the rows — the V2 task list is persistent
  // across agent death by design (a future agent / claim path can
  // pick them up). V1 mode skips this — V2 tools never registered.
  if (isTodoV2Enabled()) {
    try {
      taskManager.unassignTasksForAgent(agentId)
    } catch {
      /* ignore */
    }
  }
  // Keep read_file receipts after the sub-agent ends. Sibling sub-agents launched
  // later in the same conversation use these receipts to avoid re-reading the same
  // files; staleness is still guarded by mtime/content-hash checks.
  try {
    const entries = getSubAgentSidechainTranscript(agentId)
    const ws = getWorkspacePath()?.trim()
    if (ws && entries.length > 0) {
      const ag = getActiveAgent(agentId)
      const lastComplete = [...entries].reverse().find((e) => e.kind === 'complete')
      persistSubAgentSidechainSnapshot(ws, {
        agentId,
        agentType: ag?.agentType ?? 'general-purpose',
        name: ag?.name,
        teamName: ag?.teamName,
        streamConversationId:
          ag?.streamConversationId ??
          (typeof meta?.streamConversationId === 'string' ? meta.streamConversationId : undefined),
        parentAgentId: ag?.parentAgentId,
        endedAt: Date.now(),
        lastRunLikelySuccess:
          typeof lastComplete?.summary === 'string' && lastComplete.summary.includes('success=true'),
        entries,
      })
    }
  } catch (e) {
    console.warn('[SubAgent] sidechain disk persist failed:', e)
  }
  clearSubAgentSidechain(agentId)
  if (meta?.mcpLeaseReleaseNames?.length) {
    try {
      await releaseSubAgentMcpLease(meta.mcpLeaseReleaseNames)
    } catch (e) {
      console.warn('[SubAgent] MCP lease release failed:', e)
    }
  }
  try {
    await drainProcessCommandQueueForAgent(agentId)
  } catch (e) {
    console.warn('[SubAgent] process command queue drain failed:', e)
  }
  // upstream parity (SkillTool.ts:285-288, AgentTool.tsx:1028/1183) — drop
  // invoked-skill entries scoped to this agent. Their only consumer is
  // post-compact reinjection on the main thread; for sub-agents that path
  // never fires, so without this clear the registry grows unbounded.
  try {
    clearInvokedSkillsForAgent(agentId)
  } catch {
    /* ignore */
  }
  logAsyncAgentPhase(agentId, 'cleanup_done')
}
