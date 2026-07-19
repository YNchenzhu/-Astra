/**
 * teamTaskAutoClaim — once a teammate's turn ends, scan the V2 TaskManager
 * for a task that a still-busy teammate should pick up next:
 *
 *   1. tasks already `owner == teammateName && status == 'pending'`
 *   2. otherwise unowned `status == 'pending'` tasks, ordered by `taskId`
 *      (lexicographic — matches upstream-main "id order" intent)
 *
 * Blocked tasks (any `blockedBy` entry that isn't completed yet) are
 * always skipped. The claim is atomic by virtue of {@link taskManager}
 * being an in-process singleton — multiple teammates run in the same
 * Electron main process / event loop, so JS scheduling guarantees no
 * two claims see the same "pending unowned" snapshot.
 *
 * Why no file-lock here (deviation from the plan)? upstream-main stores
 * each task as its own JSON file, hence a per-task `proper-lockfile`
 * scope at `[ref:upstream:src/utils/swarm/inProcessRunner.ts:595-652]`.
 * Here, tasks are in the {@link TaskManager} singleton's `Map`; the
 * scan-then-update sequence is purely synchronous JS, so the race
 * window from upstream-main literally cannot open. The disk snapshot
 * is debounced and irrelevant to the claim itself.
 *
 * The runner is responsible for the consecutive-claim cap (death-spiral
 * guard) — pass {@link TryClaimArgs.alreadyClaimedThisRun} and the
 * helper short-circuits to `null` once the cap is reached.
 */

import { taskManager, type Task } from '../tools/TaskManager'

/** Default consecutive claim cap per teammate turn. */
export const DEFAULT_MAX_CONSECUTIVE_CLAIMS = 8

export interface TryClaimArgs {
  /** Owner identity to write into the claimed task. */
  teammateName: string
  /**
   * Number of claims already serviced in this teammate run; the next call
   * is the `alreadyClaimedThisRun + 1`-th claim. The helper returns
   * `null` immediately when this counter is `>=` {@link maxConsecutiveClaims},
   * so the runner cannot livelock by claiming forever.
   */
  alreadyClaimedThisRun?: number
  /** Override the consecutive-claim ceiling. Defaults to 8. */
  maxConsecutiveClaims?: number
}

export interface ClaimedTask {
  taskId: string
  subject: string
  description?: string
  /** True when the task was already owned by this teammate (resume vs fresh). */
  wasOwnedAlready: boolean
}

/**
 * Atomically pick the next task for `teammateName` and flip it to
 * `in_progress`. Returns `null` when nothing is claimable or the
 * consecutive-claim cap has been reached.
 */
export function tryClaimNextTask(args: TryClaimArgs): ClaimedTask | null {
  const teammateName = args.teammateName?.trim()
  if (!teammateName) return null
  const cap = args.maxConsecutiveClaims ?? DEFAULT_MAX_CONSECUTIVE_CLAIMS
  if ((args.alreadyClaimedThisRun ?? 0) >= cap) return null

  const all = taskManager.listTasks()
  if (all.length === 0) return null

  // Precompute the set of completed task ids so blockedBy can be cheaply
  // evaluated. A task is "blocked" if it has at least one `blockedBy`
  // dep that has not yet reached `completed`.
  const completedIds = new Set<string>()
  for (const t of all) {
    if (t.status === 'completed') completedIds.add(t.taskId)
  }

  const isBlocked = (t: Task): boolean => {
    if (!t.blockedBy || t.blockedBy.length === 0) return false
    for (const dep of t.blockedBy) {
      if (!completedIds.has(dep)) return true
    }
    return false
  }

  // Priority 1: pending task already owned by this teammate (resume).
  // Multiple such tasks → lexicographic taskId.
  const owned = all
    .filter(
      (t) =>
        t.status === 'pending' &&
        typeof t.owner === 'string' &&
        t.owner.trim() === teammateName &&
        !isBlocked(t),
    )
    .sort((a, b) => a.taskId.localeCompare(b.taskId))

  // Priority 2: unowned pending tasks, lexicographic taskId.
  const unowned = all
    .filter(
      (t) =>
        t.status === 'pending' &&
        (t.owner === undefined || t.owner === null || t.owner.trim() === '') &&
        !isBlocked(t),
    )
    .sort((a, b) => a.taskId.localeCompare(b.taskId))

  const chosen = owned[0] ?? unowned[0]
  if (!chosen) return null

  const wasOwnedAlready = chosen.owner?.trim() === teammateName
  // Synchronous update — atomic at the JS event-loop level.
  const result = taskManager.update(chosen.taskId, {
    status: 'in_progress',
    owner: teammateName,
  })
  if (!result.task) return null

  return {
    taskId: result.task.taskId,
    subject: result.task.subject,
    ...(result.task.description ? { description: result.task.description } : {}),
    wasOwnedAlready,
  }
}

/**
 * Render a claimed task into a self-contained user-role prompt for the
 * next agentic-loop iteration. The format intentionally mirrors a normal
 * human task hand-off so the model treats it as new work rather than as
 * a system notification.
 *
 * Kept inline (vs. a system reminder) because that's the path with the
 * least friction for existing teammate system prompts — the teammate
 * already knows how to interpret user prompts; teaching it a new
 * structured envelope would be a bigger PR.
 */
export function formatClaimPromptText(claim: ClaimedTask): string {
  const verb = claim.wasOwnedAlready ? 'Resuming' : 'New assignment'
  const desc = claim.description?.trim()
  const lines = [
    `${verb}: task ${claim.taskId} — ${claim.subject}`,
    desc ? `\nTask description:\n${desc}` : '',
    `\nWhen you finish, call TaskUpdate with status="completed" (or "failed" plus a short error) for ${claim.taskId}.`,
  ]
  return lines.filter(Boolean).join('').trim()
}
