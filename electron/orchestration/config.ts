/**
 * Feature flags for orchestration gates (disk settings + env override).
 */

import { readDiskSettings } from '../settings/settingsAccess'

/**
 * Audit fix L-1 — outer-turn loop ceiling for `OrchestrationKernel.runDriveMainChat`.
 *
 * The outer `for` terminates after a single iteration in ~99% of turns (inbox
 * empty after PrepareContext); >1 only happens on mid-turn inbox injection
 * (slash command / mailbox draft / synthetic user text). The cap is the
 * pathological-producer backstop. Previously hardcoded to 16; now tunable via
 * `POLE_ORCHESTRATION_MAX_OUTER_ITERATIONS` so operators can raise it for
 * heavy scripted-IPC sessions or lower it to fail faster in tests. Invalid /
 * non-positive values fall back to the default.
 */
export const DEFAULT_MAX_OUTER_ITERATIONS = 16

export function getMaxOuterIterations(): number {
  const raw = process.env.POLE_ORCHESTRATION_MAX_OUTER_ITERATIONS
  const n = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_OUTER_ITERATIONS
}

/** When true, Coordinator sessions enforce research → implementation → verification spawn order. */
export function isOrchestrationStrictMode(): boolean {
  const e = process.env.ASTRA_ORCHESTRATION_STRICT
  if (e === '1' || e === 'true') return true
  try {
    const s = readDiskSettings().orchestrationStrictMode
    return s === true
  } catch {
    return false
  }
}
