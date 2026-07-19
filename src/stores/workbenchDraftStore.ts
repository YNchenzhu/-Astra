/**
 * Workbench draft store — holds in-flight agent edits before persist.
 *
 * Design rationale (Phase 2 Sprint 2a):
 *   - Edits never mutate `bundleStore` directly. That store is a
 *     read-only mirror of the main-process registry; mutating it
 *     would drift renderer state from disk until the next save.
 *   - Each (bundleId, agentType) keeps its own `Partial<AgentBundleEntry>`
 *     draft. Switching selection keeps the other agent's draft alive
 *     so users can context-switch without losing unsaved work.
 *   - `dirty` is derived by diffing draft against the baseline bundle
 *     entry. Empty string vs `undefined` is intentionally treated as
 *     **not** dirty, so toggling a field and restoring it back clears
 *     the indicator without a manual Reset click.
 *
 * Save flow:
 *   Editor ─ setField ─► draftStore
 *                          │
 *              Save click  ▼
 *                     bundleStore.saveAgent(...)
 *                          │
 *                   IPC:bundle:save-agent
 *                          │
 *              returns fresh Bundle
 *                          ▼
 *                  replace in bundleStore
 *                          ▼
 *                  clear this draft
 *
 * Reset flow: just `clearAgent(key)` — editor re-reads from the baseline.
 */

import { create } from 'zustand'
import type {
  AgentBundleEntry,
  BundleMetadata,
  TeamTemplate,
} from '../../electron/agents/bundles/types'

/** The subset of AgentBundleEntry that the workbench can edit. Must
 *  stay aligned with the Zod schema in `electron/ipc/bundleHandlers.ts`.
 *
 *  Sprint 2a covered scalar fields; Sprint 2b.1 adds the prompt
 *  override fields (`promptSections[]`, `systemPromptRaw`). Sprint 2b.2
 *  will add the remaining array fields (tools / skills / mcpServers /
 *  disallowedTools / agentHooks). */
export type EditableAgentPatch = Partial<
  Pick<
    AgentBundleEntry,
    | 'displayName'
    | 'tagline'
    | 'capability'
    | 'whenToUse'
    | 'icon'
    | 'color'
    | 'isPrimary'
    | 'model'
    | 'maxTurns'
    | 'maxTokenBudget'
    | 'timeout'
    | 'thinkingBudgetTokens'
    | 'effort'
    | 'permissionMode'
    | 'parentPolicy'
    | 'isReadOnly'
    | 'omitClaudeMd'
    | 'memory'
    | 'isolation'
    | 'background'
    | 'initialPrompt'
    | 'criticalReminder'
    | 'coordinatorPhase'
    | 'subagentToolProfile'
    | 'orchestrationRole'
    // Sprint 2b.1:
    | 'promptSections'
    | 'systemPromptRaw'
    // Sprint 2b.2:
    | 'tools'
    | 'disallowedTools'
    | 'skills'
    // Note: `mcpServers` on AgentBundleEntry is
    // `AgentMcpServerRef[] = (string | {name, config?})[]`.
    // We only accept the string-name form through the Workbench until
    // a dedicated MCP config UI lands, so this slot is typed wider
    // than it needs to be for now. Zod on the main side narrows to
    // `string[]`, keeping the on-disk shape clean.
    | 'mcpServers'
    // Sprint 2b.3:
    | 'agentHooks'
  >
>

export type EditableAgentField = keyof EditableAgentPatch

/**
 * Sprint 2c.1: Team draft subset. Kept separate from agent patch
 * to avoid shape collisions (both have `displayName`, `whenToUse`
 * etc. at different meanings). Must stay aligned with the Zod schema
 * for `bundle:save-team`.
 */
export type EditableTeamPatch = Partial<
  Pick<TeamTemplate, 'name' | 'description' | 'coordination' | 'members'>
>

export type EditableTeamField = keyof EditableTeamPatch

/** Sprint 2c.2: editable bundle-meta fields. `id` / `createdAt` /
 *  `source` are intentionally excluded — they're controlled by the
 *  registry, not the user. */
export type EditableBundleMetaPatch = Partial<
  Pick<BundleMetadata, 'name' | 'description' | 'icon' | 'domain' | 'author' | 'version'>
>

export type EditableBundleMetaField = keyof EditableBundleMetaPatch

/** Composite key: one draft per (bundle, agent) pair. Using `::` so
 *  legitimate bundle-ids with `:` don't collide (not that current
 *  normalization allows `:` in bundle ids, but cheap to be safe). */
export function draftKey(bundleId: string, agentType: string): string {
  return `${bundleId}::${agentType}`
}

/** Team-draft key, distinct namespace so `agentType === teamId` doesn't
 *  cause cross-talk. */
export function teamDraftKey(bundleId: string, teamId: string): string {
  return `${bundleId}::team::${teamId}`
}

/** Bundle-meta draft key — one per bundle. */
export function bundleMetaDraftKey(bundleId: string): string {
  return `${bundleId}::meta`
}

interface WorkbenchDraftState {
  /** Agent draft patches keyed by `draftKey(bundleId, agentType)`. */
  drafts: Record<string, EditableAgentPatch>
  /** Team draft patches keyed by `teamDraftKey(bundleId, teamId)`.
   *  Separate map from agent drafts so saving / clearing one type
   *  doesn't leak into the other. */
  teamDrafts: Record<string, EditableTeamPatch>
  /** Bundle-meta draft patches keyed by `bundleMetaDraftKey(bundleId)`. */
  metaDrafts: Record<string, EditableBundleMetaPatch>
  /** Per-draft "saving" flag so the UI can disable the Save button.
   *  Shared key-space across draft kinds (keys include a type-specific
   *  literal segment so they never collide). */
  saving: Record<string, boolean>
  /** Per-draft last error message; cleared on successful save or
   *  field change. */
  errors: Record<string, string | null>

  setField: <K extends EditableAgentField>(
    bundleId: string,
    agentType: string,
    field: K,
    value: EditableAgentPatch[K],
  ) => void

  setTeamField: <K extends EditableTeamField>(
    bundleId: string,
    teamId: string,
    field: K,
    value: EditableTeamPatch[K],
  ) => void

  setMetaField: <K extends EditableBundleMetaField>(
    bundleId: string,
    field: K,
    value: EditableBundleMetaPatch[K],
  ) => void

  clearAgent: (bundleId: string, agentType: string) => void
  clearTeam: (bundleId: string, teamId: string) => void
  clearMeta: (bundleId: string) => void
  clearAll: () => void

  setSaving: (key: string, saving: boolean) => void
  setError: (key: string, error: string | null) => void
}

export const useWorkbenchDraftStore = create<WorkbenchDraftState>((set) => ({
  drafts: {},
  teamDrafts: {},
  metaDrafts: {},
  saving: {},
  errors: {},

  setField: (bundleId, agentType, field, value) =>
    set((state) => {
      const key = draftKey(bundleId, agentType)
      const existing = state.drafts[key] ?? {}
      // Deliberately store the value even when it equals baseline —
      // `isAgentDirty` handles the comparison. Otherwise we'd need a
      // baseline lookup inside this action and couple draft/bundle stores.
      const nextDraft: EditableAgentPatch = { ...existing, [field]: value }
      return {
        drafts: { ...state.drafts, [key]: nextDraft },
        errors:
          state.errors[key] != null
            ? { ...state.errors, [key]: null }
            : state.errors,
      }
    }),

  setTeamField: (bundleId, teamId, field, value) =>
    set((state) => {
      const key = teamDraftKey(bundleId, teamId)
      const existing = state.teamDrafts[key] ?? {}
      const nextDraft: EditableTeamPatch = { ...existing, [field]: value }
      return {
        teamDrafts: { ...state.teamDrafts, [key]: nextDraft },
        errors:
          state.errors[key] != null
            ? { ...state.errors, [key]: null }
            : state.errors,
      }
    }),

  setMetaField: (bundleId, field, value) =>
    set((state) => {
      const key = bundleMetaDraftKey(bundleId)
      const existing = state.metaDrafts[key] ?? {}
      const nextDraft: EditableBundleMetaPatch = { ...existing, [field]: value }
      return {
        metaDrafts: { ...state.metaDrafts, [key]: nextDraft },
        errors:
          state.errors[key] != null
            ? { ...state.errors, [key]: null }
            : state.errors,
      }
    }),

  clearAgent: (bundleId, agentType) =>
    set((state) => {
      const key = draftKey(bundleId, agentType)
      if (!(key in state.drafts) && !(key in state.saving) && !(key in state.errors)) {
        return state
      }
      const { [key]: _dropDraft, ...restDrafts } = state.drafts
      const { [key]: _dropSaving, ...restSaving } = state.saving
      const { [key]: _dropError, ...restErrors } = state.errors
      return {
        drafts: restDrafts,
        saving: restSaving,
        errors: restErrors,
      }
    }),

  clearTeam: (bundleId, teamId) =>
    set((state) => {
      const key = teamDraftKey(bundleId, teamId)
      if (!(key in state.teamDrafts) && !(key in state.saving) && !(key in state.errors)) {
        return state
      }
      const { [key]: _dropDraft, ...restTeamDrafts } = state.teamDrafts
      const { [key]: _dropSaving, ...restSaving } = state.saving
      const { [key]: _dropError, ...restErrors } = state.errors
      return {
        teamDrafts: restTeamDrafts,
        saving: restSaving,
        errors: restErrors,
      }
    }),

  clearMeta: (bundleId) =>
    set((state) => {
      const key = bundleMetaDraftKey(bundleId)
      if (!(key in state.metaDrafts) && !(key in state.saving) && !(key in state.errors)) {
        return state
      }
      const { [key]: _dropDraft, ...restMetaDrafts } = state.metaDrafts
      const { [key]: _dropSaving, ...restSaving } = state.saving
      const { [key]: _dropError, ...restErrors } = state.errors
      return {
        metaDrafts: restMetaDrafts,
        saving: restSaving,
        errors: restErrors,
      }
    }),

  clearAll: () =>
    set({ drafts: {}, teamDrafts: {}, metaDrafts: {}, saving: {}, errors: {} }),

  setSaving: (key, saving) =>
    set((state) => ({
      saving: { ...state.saving, [key]: saving },
    })),

  setError: (key, error) =>
    set((state) => ({
      errors: { ...state.errors, [key]: error },
    })),
}))

// ─── Selectors ─────────────────────────────────────────────────────

/** Get the draft for one (bundle, agent). Returns `undefined` when no
 *  edits have been made. Use with a Zustand selector to subscribe
 *  only to changes in that single draft. */
export function selectDraft(
  bundleId: string | undefined,
  agentType: string | undefined,
) {
  return (state: WorkbenchDraftState): EditableAgentPatch | undefined => {
    if (!bundleId || !agentType) return undefined
    return state.drafts[draftKey(bundleId, agentType)]
  }
}

/** Merge baseline + draft into the "effective" agent the editor
 *  should render. Callers pass the baseline pulled from bundleStore.
 *
 *  Note: fields with `undefined` in the draft are intentionally not
 *  overlaid, so baseline values persist unless explicitly overwritten.
 *  This matters when the Zod schema allows `undefined` (optional) but
 *  the draft chose to "leave it alone". */
export function applyDraft(
  baseline: AgentBundleEntry,
  draft: EditableAgentPatch | undefined,
): AgentBundleEntry {
  if (!draft) return baseline
  const merged: AgentBundleEntry = { ...baseline }
  for (const [key, value] of Object.entries(draft)) {
    if (value !== undefined) {
      ;(merged as unknown as Record<string, unknown>)[key] = value
    }
  }
  return merged
}

/** Is the given draft "different from baseline" in any editable field?
 *  Returns true only when at least one draft value differs from the
 *  baseline value AND the draft key is a known editable field. */
export function isAgentDirty(
  baseline: AgentBundleEntry,
  draft: EditableAgentPatch | undefined,
): boolean {
  if (!draft) return false
  const baseAsRec = baseline as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(draft)) {
    const baselineValue = baseAsRec[key]
    if (value === undefined) continue
    if (!shallowEqual(baselineValue, value)) return true
  }
  return false
}

/**
 * Compute the minimal patch to send to IPC: only fields that differ
 * from baseline.
 *
 * **Null sentinel for "clear" semantics** — when the draft explicitly
 * sets a field to `undefined` while baseline has a defined value, we
 * emit `null` in the outgoing patch. This is required because:
 *   1. Electron's IPC structured clone drops `undefined` values from
 *      objects; the main process would see the key as absent.
 *   2. The registry's shallow merge (`{...current, ...patch}`) treats
 *      absent keys as "leave alone".
 *
 * Backends that understand the null sentinel (Sprint 2b.1+) delete
 * the key from the merged entry, achieving the user's intent.
 *
 * Empty string and empty array are preserved as-is (they're legitimate
 * values the user may have typed).
 */
export function computePatchToSend(
  baseline: AgentBundleEntry,
  draft: EditableAgentPatch | undefined,
): Record<string, unknown> {
  if (!draft) return {}
  const baseAsRec = baseline as unknown as Record<string, unknown>
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(draft)) {
    const baselineValue = baseAsRec[key]
    if (value === undefined) {
      // Only emit clear-sentinel when baseline had a value; otherwise
      // the field was never set and clearing is a no-op.
      if (baselineValue !== undefined) {
        patch[key] = null
      }
      continue
    }
    if (!shallowEqual(baselineValue, value)) {
      patch[key] = value
    }
  }
  return patch
}

/**
 * Deep equality for the values we carry in draft patches.
 *
 * Handles:
 *   - primitives (===)
 *   - two undefineds
 *   - plain object values (key-by-key recursion)
 *   - arrays (index-by-index recursion)
 *
 * Anything fancier (Maps, Sets, functions, class instances) doesn't
 * belong in a bundle patch — if one shows up, we bail to `false`.
 */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return false

  // Arrays
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!shallowEqual(a[i], b[i])) return false
    }
    return true
  }
  if (Array.isArray(b)) return false

  // Plain objects
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const aKeys = Object.keys(ao)
  const bKeys = Object.keys(bo)
  if (aKeys.length !== bKeys.length) return false
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false
    if (!shallowEqual(ao[k], bo[k])) return false
  }
  return true
}
