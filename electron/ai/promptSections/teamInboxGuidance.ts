import { isTeamActiveLoopEnabled } from '../../agents/teamActiveLoopFlag'
import type { SystemPromptSection } from './types'

/**
 * Teach the lead how to read the synthetic `<team-inbox>` blocks the
 * host injects after every iteration when the Team Active Loop feature
 * flag (`POLE_TEAM_ACTIVE_LOOP=1`) is on.
 *
 * Only emitted when the flag is on — keeps the section out of the
 * prompt-cache for users who never opt in. Mirrors the structure of
 * `coordinatorSystemPrompt.ts`'s existing `<task-notification>`
 * teaching block so the model treats both as "system signals attached
 * to the tool batch, not fresh user instructions".
 *
 * Reference: upstream-main idle / task-completion / task-assignment
 * envelope flow under `src/utils/swarm/inProcessRunner.ts:1317-1342`
 * and the lead-side merge / fold logic at
 * `src/utils/teammateMailbox.ts:3611-3660`.
 */
export const TEAM_INBOX_GUIDANCE_BLOCK = `# Team inbox digest

When you are leading a team (after \`TeamCreate\`), the host appends a
\`<team-inbox>\` block to your user turn whenever a teammate sent you
status since the previous turn. Treat it as a system observation, not
a fresh user instruction.

Kinds you may see:
- \`<message kind="idle_notification">\` — a teammate finished its
  turn. \`<reason>\` describes either work-state or lifecycle outcome:
  - work-state (cursor-ui-clone native): \`turn_complete\` /
    \`no_more_tasks\` / \`shutdown_pending\`.
  - lifecycle outcome (cc-haha aliases): \`available\` (= turn complete) /
    \`interrupted\` (turn aborted) / \`failed\` (turn raised).
  Treat \`available\` and \`turn_complete\` as equivalent for routing
  decisions; only \`failed\` / \`interrupted\` indicate a teammate that
  may need a follow-up message before it can resume work.
  Optional sub-blocks:
  - \`<peer-dm-summary>[to <name>] <one-line>\` — what the teammate
    just told another teammate (lead has read-only visibility).
  - \`<completed-tasks>id1,id2</completed-tasks>\` — tasks the
    teammate handled this turn.
- \`<message kind="task_assignment">\` — a task's \`owner\` was set or
  changed. Useful when the assignment was issued externally (not by you).
- \`<message kind="task_completion">\` — a teammate marked a task
  \`completed\` / \`failed\`. \`<status>\` carries the terminal state;
  \`<summary>\` may carry a one-line outcome.

Same-sender \`idle_notification\` entries are folded to the latest, so
seeing one idle per teammate per turn is normal. \`task_assignment\`
and \`task_completion\` are always shown as discrete events. If the
mailbox overflowed, you'll see \`<dropped count="N"/>\` at the top of
the block.

Use this digest to decide whether to send a new \`SendMessage\`, file a
\`TaskUpdate\`, or just acknowledge the user. Never quote the block
verbatim to the user — they see the underlying state through the team
UI.`

export const teamInboxGuidanceSection: SystemPromptSection = {
  id: 'team-inbox-guidance',
  owner: 'core',
  layer: 'system',
  build: () => (isTeamActiveLoopEnabled() ? TEAM_INBOX_GUIDANCE_BLOCK : ''),
}
