/**
 * Buddy state revision counter.
 *
 * Tracks "the buddy's identity / appearance / settings have changed
 * since the last observation". A monotonically increasing integer,
 * bumped by the buddy service's mutating functions (`hatchBuddy`,
 * `setBuddySpecies`, `updateBuddySettings`).
 *
 * ## Why a separate counter rather than a saved-state field
 *
 * The buddy state is loaded from both companion config and a legacy
 * `buddy-state.json`; mixing a revision counter into the persisted
 * struct would force a schema migration and create write-ordering
 * concerns vs the two storage backends. The counter is **runtime-
 * scoped** (resets to 1 on process restart) which matches its
 * consumer: the `buddy_state_change` host-attachment collector
 * surfaces deltas WITHIN a session, not across sessions.
 *
 * Cross-restart "buddy was renamed since last app launch" is a
 * separate concern handled by `companion_intro`-style UX (which
 * we're not currently implementing).
 */

let revision = 1

/** Current revision number. Starts at 1, monotonic. */
export function getBuddyStateRevision(): number {
  return revision
}

/**
 * Increment after any buddy state mutation that should surface to
 * the model. Called by:
 *
 *   - `hatchBuddy` — new buddy hatched (identity change)
 *   - `setBuddySpecies` — species changed
 *   - `updateBuddySettings` — name / persona / mood / enabled flag
 *
 * NOT called by `petBuddy` / `tickBuddy` — those are user-visible
 * UI events without semantic impact on the model.
 */
export function bumpBuddyStateRevision(): void {
  revision++
}

/** Test seam. */
export function __resetBuddyStateRevisionForTests(): void {
  revision = 1
}
