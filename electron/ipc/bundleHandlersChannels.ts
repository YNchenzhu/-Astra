/**
 * IPC channel names for Bundle lifecycle.
 *
 * Kept as exported constants so renderer-side code (preload / stores)
 * can import them if desired, avoiding string drift.
 */

export const BUNDLE_IPC_CHANNELS = {
  list: 'bundle:list',
  getActive: 'bundle:get-active',
  activate: 'bundle:activate',
  reload: 'bundle:reload',
  getLoadErrors: 'bundle:get-load-errors',
  /** Broadcast from main → all renderers on activation change. */
  activated: 'bundle:activated',
  /** Phase 2 Sprint 2a: persist an agent patch. */
  saveAgent: 'bundle:save-agent',
  /** Phase 2 Sprint 2c.1: persist a team patch. */
  saveTeam: 'bundle:save-team',
  /** Phase 2 Sprint 2c.2: update bundle-level meta/layout/capabilities. */
  saveMeta: 'bundle:save-meta',
  /** Phase 2 Sprint 2c.2: create a new bundle (blank or forked). */
  create: 'bundle:create',
  /** Phase 2 Sprint 2c.2: delete a non-preset bundle. */
  delete: 'bundle:delete',
  /** Phase 2 Sprint 2c.2b: add an agent to a bundle. */
  addAgent: 'bundle:add-agent',
  /** Phase 2 Sprint 2c.2b: remove an agent from a bundle. */
  removeAgent: 'bundle:remove-agent',
  /** Phase 2 Sprint 2c.2b: add a team to a bundle. */
  addTeam: 'bundle:add-team',
  /** Phase 2 Sprint 2c.2b: remove a team from a bundle. */
  removeTeam: 'bundle:remove-team',
  /** Phase 2 Sprint 2c.3b: export bundle to a user-chosen JSON file. */
  export: 'bundle:export',
  /** Phase 2 Sprint 2c.3b: import a bundle JSON file chosen by the user. */
  import: 'bundle:import',
  /** Phase 3 Sprint 2d.a: kick off a one-shot LLM call to preview an agent's behavior. */
  tryRun: 'bundle:try-run-agent',
  /** Phase 3 Sprint 2d.a: cancel an in-flight try-run by runId. */
  tryRunCancel: 'bundle:try-run-cancel',
  /** Phase 3 Sprint 2d.a: streaming deltas (renderer ← main). */
  tryRunDelta: 'bundle:try-run-delta',
  /** Phase 3 Sprint 2d.a: terminal "end" event with usage. */
  tryRunEnd: 'bundle:try-run-end',
  /** Phase 3 Sprint 2d.a: terminal "error" event. */
  tryRunError: 'bundle:try-run-error',
  /** Phase 2 Sprint 2b.1: fetch the built-in runtime prompt for an
   *  agent, pre-split into structured sections so the Workbench can
   *  turn it into an editable draft. */
  getBuiltinPrompt: 'bundle:get-builtin-prompt',
  /** Phase 2 Sprint 2b.2: return catalogs of all registered tools,
   *  loaded skills, and configured MCP servers — feeds the Workbench
   *  capability multi-select editors. */
  getCapabilityCatalog: 'bundle:get-capability-catalog',
  /** Phase 3 Sprint 3.3: runtime orchestrator status for Workbench. */
  getOrchestratorStatus: 'bundle:get-orchestrator-status',
  /** Broadcast from main → all renderers on any bundle content change
   *  (edit, fork, create). Renderer bundle store listens and replaces
   *  its local copy without a full reload. */
  changed: 'bundle:changed',
  /** Broadcast from main → all renderers when a bundle is deleted.
   *  Payload: `{ deletedId: string }`. */
  deleted: 'bundle:deleted',
} as const
