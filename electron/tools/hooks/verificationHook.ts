/**
 * Verification-related helpers — what's left after the audit cleanup.
 *
 * ## History (audit, 2026-05)
 *
 * This file previously hosted a `evaluateTodoWriteCompletionGate`
 * PreToolUse hook that tried to gate TodoWrite `completed` transitions
 * on TaskManager-recorded verification evidence (Verification agent
 * run / `npm test`-style bash / `autoMemo` skill task).
 *
 * The whole gate keyed on `taskManager.listTasks().find(t =>
 * t.source === 'todo_sync' && t.subject === <todo content>)`. But
 * **nothing in the codebase ever created `source: 'todo_sync'`
 * tasks** — a TodoWrite call did not mirror itself into a TaskManager
 * row, so the gate's `matched` lookup always returned `undefined`
 * and the function fell through (`continue`) for every todo.
 *
 * Net effect: the gate was a no-op pass-through.
 *
 * The audit (plan §"范围外") gave two choices: implement the
 * `TodoWrite → todo_sync` mirror, or delete the dead branch. upstream
 * does not have this mechanism either, so we picked deletion. The
 * surviving helpers below have independent users (config-driven
 * custom hooks, future verifier-after-N-completed nudge, etc.) and
 * are kept on purpose.
 */

import { taskManager } from '../TaskManager'

/**
 * Subject text that should NOT require a verification evidence step
 * before being marked completed — research / exploration / docs /
 * config / simple-fix work where running tests is meaningless.
 *
 * Covers Chinese and English phrasings. Used by:
 *   - The (future) verifier-after-N-completed nudge to decide
 *     whether a completed todo "counts" toward the verifier trigger.
 *   - Custom config-driven hooks that may want to differentiate
 *     low-risk completions from heavy implementation work.
 */
const RESEARCH_PHASE_SUBJECT_RE =
  /探索|调研|梳理|只读|阅读代码|熟悉.*代码|了解.*(项目|结构|架构)|架构.*(梳理|分析|调研)|入口(点)?|协议.*(分析|梳理)|codebase|code base|investigat|read[-\s]?only|\bexplore\s|\bsurvey\s|map\s+the\s+arch|familiariz|修复|fix|bug.{0,5}fix|config|配置|文档|doc|rename|重命名|format|格式化|lint|style|typo|拼写/i

export function isResearchPhaseTodoSubject(subject: string): boolean {
  const s = subject.trim()
  if (!s) return false
  return RESEARCH_PHASE_SUBJECT_RE.test(s)
}

/**
 * Returns `true` when at least one `Skill` task has reached the
 * `completed` state since `anchorCreatedAt`. Optionally narrowed
 * to a specific skill name. Exposed for config-driven extension
 * hooks that want to gate on "did the agent actually run the
 * matching workflow before claiming done?".
 */
export function hasSkillTaskCompletedSince(anchorCreatedAt: number, skillName?: string): boolean {
  for (const t of taskManager.listTasks()) {
    if (t.createdAt < anchorCreatedAt) continue
    if (t.runtimeKind !== 'skill' || t.status !== 'completed') continue
    if (skillName) {
      const meta = t.metadata?.skillName
      if (meta !== skillName) continue
    }
    return true
  }
  return false
}
