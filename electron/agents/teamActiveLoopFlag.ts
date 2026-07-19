/**
 * Feature flag for the "Team Active Loop" series (idle notifications,
 * task_assignment notifications, auto-claim, lead inbox attachment).
 *
 * **S3 (upstream alignment)**: this flag is now ON by default. upstream
 * has no equivalent flag — its lead inbox poller / idle notifier always
 * run when a team is active, and the loss of those signals was the
 * single biggest "team feels broken" complaint in cursor-ui-clone runs
 * before the alignment pass. Operators who still want the previous
 * silent-team behaviour can set `POLE_TEAM_ACTIVE_LOOP=0` (or any of
 * `false` / `no` / `off` / `disabled`) explicitly.
 *
 * Reading the env on every call is intentional: tests routinely toggle
 * the flag mid-run, and the cost is a property lookup + lower-case.
 *
 * The implementation follows the upstream reference behaviour that this
 * flag gates on.
 */

const FALSY = new Set<string>(['0', 'false', 'no', 'n', 'off', 'disabled'])

export function isTeamActiveLoopEnabled(): boolean {
  const raw = process.env.POLE_TEAM_ACTIVE_LOOP
  if (typeof raw !== 'string') return true
  // Empty string from `set POLE_TEAM_ACTIVE_LOOP=` (Windows shell
  // habits) shouldn't accidentally disable the loop — only explicit
  // falsy spellings opt out.
  const v = raw.trim().toLowerCase()
  if (v.length === 0) return true
  return !FALSY.has(v)
}
