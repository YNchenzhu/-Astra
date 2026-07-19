/**
 * Bundle registry mutations — save agent/team/meta and add/remove entries.
 */

import type { App } from 'electron'
import type { AgentBundleEntry, Bundle, TeamTemplate } from './types'
import { getBundlePaths } from './paths'
import { normalizeBundle, validateBundleSemantics } from './bundleSerialize'
import { persistBundle, resolveWriteTarget } from './bundleIO'
import { state, emitBundleChange, emitActiveChange } from './bundleRegistryState'

// ─── Mutation: save agent fields ─────────────────────────────────────

/**
 * Apply a partial update to one agent inside a bundle, persist the
 * change, and install the fresh Bundle into the registry.
 *
 * Preset fork semantics: when the affected bundle's current tier is
 * `preset`, `persistBundle` lands the write into the `user` tier and
 * this function transparently replaces the in-memory entry to match.
 * The preset JSON on disk stays untouched; subsequent reloads will
 * surface the user copy because user > preset in tier priority.
 *
 * Validation: the patched bundle is re-`normalizeBundle`d and
 * `validateBundleSemantics`-checked before hitting disk, so the
 * on-disk file is guaranteed to round-trip through `loadBundleFromFile`.
 * Invalid patches throw — callers surface the error via IPC.
 *
 * @returns The freshly persisted bundle (replace your in-memory copy).
 */
/**
 * Patch values can be the editable field shape, `undefined` (absent),
 * or `null` (wire-level "clear" sentinel — see
 * `workbenchDraftStore.computePatchToSend`). The Zod schema on the
 * IPC boundary ensures values match their expected Agent field type.
 */
type AgentPatch = Record<string, unknown>

export function saveAgentEntry(
  bundleId: string,
  agentType: string,
  patch: AgentPatch,
  app: App,
  workspacePath?: string | undefined | null,
): Bundle {
  const existingEntry = state.entries.get(bundleId)
  if (!existingEntry) {
    throw new Error(`[bundleRegistry] Cannot save: bundle "${bundleId}" not found`)
  }

  // Refresh paths each write — workspace may have changed mid-session.
  const paths = getBundlePaths(app, workspacePath ?? undefined)
  state.paths = paths

  const currentBundle = existingEntry.bundle
  const agentIdx = currentBundle.agents.findIndex((a) => a.agentType === agentType)
  if (agentIdx < 0) {
    throw new Error(
      `[bundleRegistry] Cannot save: agent "${agentType}" not found in bundle "${bundleId}"`,
    )
  }

  // Defensive: disallow renaming agentType via patch (would break
  // team references and require wider migration).
  if (typeof patch.agentType === 'string' && patch.agentType !== agentType) {
    throw new Error(
      `[bundleRegistry] Cannot rename agentType via saveAgentEntry (got "${String(patch.agentType)}"; was "${agentType}")`,
    )
  }

  // Shallow merge with null-sentinel clear semantics.
  //
  // The renderer sends `{foo: null}` when the user explicitly cleared
  // a field (see workbenchDraftStore.computePatchToSend). We need to
  // DELETE those keys from the merged agent rather than set them to
  // null, otherwise the persisted JSON would carry stray nulls the
  // Zod loader may reject. Real `null` values never come from the
  // Workbench UI because no AgentBundleEntry field is legitimately
  // null-typed.
  const mergedAgent = { ...currentBundle.agents[agentIdx] } as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete mergedAgent[key]
    } else {
      mergedAgent[key] = value
    }
  }
  mergedAgent.agentType = agentType
  const mergedAgentTyped = mergedAgent as unknown as AgentBundleEntry

  const nextAgents = currentBundle.agents.slice()
  nextAgents[agentIdx] = mergedAgentTyped

  // Primary coordination: if this save promotes the agent to primary,
  // demote any sibling currently holding that flag. Otherwise
  // `normalizeBundle` would pick the FIRST primary (by array order)
  // and silently demote the user's new choice — surprising behavior.
  // We only touch this when the patch explicitly promotes (true);
  // a patch that leaves isPrimary unchanged or demotes does not
  // disturb siblings.
  if (patch.isPrimary === true) {
    for (let i = 0; i < nextAgents.length; i++) {
      if (i === agentIdx) continue
      if (nextAgents[i].isPrimary) {
        nextAgents[i] = { ...nextAgents[i], isPrimary: false }
      }
    }
  }

  // Re-resolve target tier upfront so `normalizeBundle` can see the
  // correct `meta.source` and we don't double-normalize later.
  const target = resolveWriteTarget(currentBundle, paths)

  const draftBundle: Bundle = {
    ...currentBundle,
    agents: nextAgents,
    meta: { ...currentBundle.meta, source: target.tier, updatedAt: Date.now() },
  }

  const normalized = normalizeBundle(draftBundle, target.tier)
  const semanticError = validateBundleSemantics(normalized)
  if (semanticError !== null) {
    throw new Error(`[bundleRegistry] Save rejected: ${semanticError}`)
  }

  const previousTier = existingEntry.tier
  const { filePath, tier, persisted } = persistBundle(normalized, paths)

  // Install the freshly persisted bundle.
  state.entries.set(bundleId, { bundle: persisted, filePath, tier })

  emitBundleChange(persisted, {
    reason: 'agent-saved',
    previousTier,
    nextTier: tier,
    filePath,
  })

  // If the saved bundle is the active one, emit an activation-change
  // event too so downstream subsystems (conversation partition,
  // running-agent menus) observe the new agents[] without polling.
  if (state.activeId === bundleId) {
    emitActiveChange(persisted, currentBundle)
  }

  return persisted
}

// ─── Mutation: save team fields ──────────────────────────────────────

/** Patch values for a team may be scalars, undefined, or the null
 *  clear-sentinel (see `workbenchDraftStore.computePatchToSend`). */
type TeamPatch = Record<string, unknown>

/**
 * Apply a partial update to one team inside a bundle, persist the
 * change, and install the fresh Bundle into the registry.
 *
 * Mirrors `saveAgentEntry`'s semantics:
 *   - preset → user fork is automatic
 *   - null-valued fields are deleted from the merged team entry
 *   - normalizeBundle + validateBundleSemantics gate the write, so
 *     invalid patches (e.g. a member referencing an unknown agent)
 *     throw before touching disk
 *
 * Team id renaming is rejected for the same reason agentType rename
 * is rejected — other team members / coordination metadata may
 * reference the id.
 */
export function saveTeamEntry(
  bundleId: string,
  teamId: string,
  patch: TeamPatch,
  app: App,
  workspacePath?: string | undefined | null,
): Bundle {
  const existingEntry = state.entries.get(bundleId)
  if (!existingEntry) {
    throw new Error(`[bundleRegistry] Cannot save: bundle "${bundleId}" not found`)
  }

  const paths = getBundlePaths(app, workspacePath ?? undefined)
  state.paths = paths

  const currentBundle = existingEntry.bundle
  const teamIdx = currentBundle.teams.findIndex((t) => t.id === teamId)
  if (teamIdx < 0) {
    throw new Error(
      `[bundleRegistry] Cannot save: team "${teamId}" not found in bundle "${bundleId}"`,
    )
  }

  if (typeof patch.id === 'string' && patch.id !== teamId) {
    throw new Error(
      `[bundleRegistry] Cannot rename team id via saveTeamEntry (got "${String(patch.id)}"; was "${teamId}")`,
    )
  }

  // Shallow merge with null-sentinel clear semantics.
  const mergedTeam = { ...currentBundle.teams[teamIdx] } as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete mergedTeam[key]
    } else {
      mergedTeam[key] = value
    }
  }
  mergedTeam.id = teamId
  const mergedTeamTyped = mergedTeam as unknown as TeamTemplate

  const nextTeams = currentBundle.teams.slice()
  nextTeams[teamIdx] = mergedTeamTyped

  const target = resolveWriteTarget(currentBundle, paths)
  const draftBundle: Bundle = {
    ...currentBundle,
    teams: nextTeams,
    meta: { ...currentBundle.meta, source: target.tier, updatedAt: Date.now() },
  }

  const normalized = normalizeBundle(draftBundle, target.tier)
  const semanticError = validateBundleSemantics(normalized)
  if (semanticError !== null) {
    throw new Error(`[bundleRegistry] Save rejected: ${semanticError}`)
  }

  const previousTier = existingEntry.tier
  const { filePath, tier, persisted } = persistBundle(normalized, paths)

  state.entries.set(bundleId, { bundle: persisted, filePath, tier })

  emitBundleChange(persisted, {
    reason: 'agent-saved',
    previousTier,
    nextTier: tier,
    filePath,
  })

  if (state.activeId === bundleId) {
    emitActiveChange(persisted, currentBundle)
  }

  return persisted
}

// ─── Mutation: save bundle-level fields (meta) ───────────────────────

/**
 * Apply a partial update to a bundle's **top-level** fields — `meta`,
 * `capabilities`, `layout`, `initialContext`, `welcomeMessage`.
 *
 * Does NOT allow patching `agents[]` / `teams[]` through here; use
 * `saveAgentEntry` / `saveTeamEntry` (or the Sprint 2c.2b `add/remove`
 * helpers landing next). Reason: adding/removing array members has
 * cross-cutting concerns (primary agent coordination, defaultAgent
 * resolution, team member references) that a generic shallow merge
 * would paper over.
 *
 * Patch semantics match `saveAgentEntry`:
 *   - null-valued keys → delete (only meaningful for optional meta
 *     fields like `icon` / `domain` / `author`)
 *   - preset-source bundles auto-fork to user tier
 */
export function saveBundleMeta(
  bundleId: string,
  patch: Record<string, unknown>,
  app: App,
  workspacePath?: string | undefined | null,
): Bundle {
  const existingEntry = state.entries.get(bundleId)
  if (!existingEntry) {
    throw new Error(`[bundleRegistry] Cannot save meta: bundle "${bundleId}" not found`)
  }

  const paths = getBundlePaths(app, workspacePath ?? undefined)
  state.paths = paths

  const currentBundle = existingEntry.bundle

  // Build the next bundle by merging patch keys one by one. Unknown
  // keys silently skipped — the Zod schema on the IPC boundary is the
  // real gatekeeper.
  const nextMeta = { ...currentBundle.meta }
  const nextBundle: Bundle = { ...currentBundle, meta: nextMeta }
  const nextBundleRec = nextBundle as unknown as Record<string, unknown>

  const applyMetaKey = (key: string, value: unknown): void => {
    if (value === null) {
      // id / createdAt / source / version must not be cleared — they're
      // required fields. Anything else is a nullable hint.
      if (key === 'id' || key === 'createdAt' || key === 'source' || key === 'version' || key === 'name') {
        return
      }
      delete (nextMeta as unknown as Record<string, unknown>)[key]
    } else {
      ;(nextMeta as unknown as Record<string, unknown>)[key] = value
    }
  }

  for (const [key, value] of Object.entries(patch)) {
    if (key === 'meta' && value && typeof value === 'object') {
      for (const [mk, mv] of Object.entries(value as Record<string, unknown>)) {
        // Reject id changes — references (activeId, conversations, etc)
        // key on the bundle id.
        if (mk === 'id') continue
        applyMetaKey(mk, mv)
      }
      continue
    }
    // Top-level bundle fields (capabilities / layout / initialContext / welcomeMessage).
    if (value === null) {
      delete nextBundleRec[key]
    } else {
      nextBundleRec[key] = value
    }
  }

  const target = resolveWriteTarget(currentBundle, paths)
  const draftBundle: Bundle = {
    ...nextBundle,
    meta: { ...nextBundle.meta, source: target.tier, updatedAt: Date.now() },
  }

  const normalized = normalizeBundle(draftBundle, target.tier)
  const semanticError = validateBundleSemantics(normalized)
  if (semanticError !== null) {
    throw new Error(`[bundleRegistry] Save rejected: ${semanticError}`)
  }

  const previousTier = existingEntry.tier
  const { filePath, tier, persisted } = persistBundle(normalized, paths)
  state.entries.set(bundleId, { bundle: persisted, filePath, tier })

  emitBundleChange(persisted, {
    reason: 'agent-saved',
    previousTier,
    nextTier: tier,
    filePath,
  })
  if (state.activeId === bundleId) {
    emitActiveChange(persisted, currentBundle)
  }
  return persisted
}

// ─── Mutation: add / remove entries inside a bundle ─────────────────

/**
 * Shared machinery for "mutate a bundle's agents[] or teams[] then
 * persist + broadcast". Invoked by the four public helpers below
 * (addAgent / removeAgent / addTeam / removeTeam). Centralizing keeps
 * fork-on-preset / normalize / validate / persist / emit logic in one
 * place; each caller just describes the mutation.
 *
 * `mutate` receives a mutable *copy* of the bundle (agents/teams
 * already cloned) and is free to push/splice. It must not mutate
 * `currentBundle` directly — we pass a shallow-cloned next bundle.
 */
function mutateBundleAndPersist(
  bundleId: string,
  mutate: (next: Bundle) => void,
  app: App,
  workspacePath?: string | undefined | null,
): Bundle {
  const existingEntry = state.entries.get(bundleId)
  if (!existingEntry) {
    throw new Error(`[bundleRegistry] Cannot mutate: bundle "${bundleId}" not found`)
  }

  const paths = getBundlePaths(app, workspacePath ?? undefined)
  state.paths = paths

  const currentBundle = existingEntry.bundle
  const nextBundle: Bundle = {
    ...currentBundle,
    agents: currentBundle.agents.slice(),
    teams: currentBundle.teams.slice(),
    meta: { ...currentBundle.meta },
    capabilities: { ...currentBundle.capabilities },
    layout: { ...currentBundle.layout },
  }

  mutate(nextBundle)

  const target = resolveWriteTarget(currentBundle, paths)
  const draftBundle: Bundle = {
    ...nextBundle,
    meta: {
      ...nextBundle.meta,
      source: target.tier,
      updatedAt: Date.now(),
    },
  }

  const normalized = normalizeBundle(draftBundle, target.tier)
  const semanticError = validateBundleSemantics(normalized)
  if (semanticError !== null) {
    throw new Error(`[bundleRegistry] Mutation rejected: ${semanticError}`)
  }

  const previousTier = existingEntry.tier
  const { filePath, tier, persisted } = persistBundle(normalized, paths)

  state.entries.set(bundleId, { bundle: persisted, filePath, tier })

  emitBundleChange(persisted, {
    reason: 'agent-saved',
    previousTier,
    nextTier: tier,
    filePath,
  })
  if (state.activeId === bundleId) {
    emitActiveChange(persisted, currentBundle)
  }
  return persisted
}

/** Seed for a newly-added agent. Only `agentType` is required;
 *  everything else is filled with reasonable defaults before persist. */
export interface AddAgentSeed {
  agentType: string
  displayName?: string
  whenToUse?: string
  capability?: string
  /** If neither `systemPromptRaw` nor `promptSections` is provided,
   *  we inject a minimal systemPromptRaw so the agent is immediately
   *  runnable (and so `composeSystemPrompt` has something to return). */
  systemPromptRaw?: string
  isPrimary?: boolean
}

export function addAgent(
  bundleId: string,
  seed: AddAgentSeed,
  app: App,
  workspacePath?: string | undefined | null,
): Bundle {
  const agentType = String(seed.agentType ?? '').trim()
  if (agentType.length === 0) {
    throw new Error('[bundleRegistry] addAgent: agentType is required')
  }

  return mutateBundleAndPersist(
    bundleId,
    (next) => {
      if (next.agents.some((a) => a.agentType === agentType)) {
        throw new Error(
          `[bundleRegistry] addAgent: agentType "${agentType}" already exists in bundle "${bundleId}"`,
        )
      }

      const hasPrompt =
        typeof seed.systemPromptRaw === 'string' && seed.systemPromptRaw.trim().length > 0
      const defaultPrompt = `你是 ${seed.displayName || agentType}。请根据用户的指令完成任务;在需要澄清时主动询问。`

      const newAgent: AgentBundleEntry = {
        agentType,
        displayName: seed.displayName?.trim() || undefined,
        whenToUse:
          seed.whenToUse?.trim() ||
          `通用助手,在工作包 "${next.meta.name}" 中执行任务。`,
        capability: seed.capability?.trim() || undefined,
        systemPromptRaw: hasPrompt ? seed.systemPromptRaw : defaultPrompt,
        isPrimary: seed.isPrimary === true,
      }

      // 若调用方要求设为 primary,主动 demote 其他 primary。
      if (newAgent.isPrimary) {
        for (let i = 0; i < next.agents.length; i++) {
          if (next.agents[i].isPrimary) {
            next.agents[i] = { ...next.agents[i], isPrimary: false }
          }
        }
      }

      next.agents.push(newAgent)

      // 如果当前 bundle 没有 primary(极少见,但防御性处理),让新加的成为 primary。
      if (!next.agents.some((a) => a.isPrimary)) {
        next.agents[next.agents.length - 1] = {
          ...next.agents[next.agents.length - 1],
          isPrimary: true,
        }
      }
    },
    app,
    workspacePath,
  )
}

export function removeAgent(
  bundleId: string,
  agentType: string,
  app: App,
  workspacePath?: string | undefined | null,
): Bundle {
  return mutateBundleAndPersist(
    bundleId,
    (next) => {
      const idx = next.agents.findIndex((a) => a.agentType === agentType)
      if (idx < 0) {
        throw new Error(
          `[bundleRegistry] removeAgent: "${agentType}" not found in bundle "${bundleId}"`,
        )
      }
      if (next.agents.length <= 1) {
        throw new Error(
          `[bundleRegistry] removeAgent: cannot remove the last agent (工作包必须至少保留一个智能体)`,
        )
      }
      // 检查是否有 team 引用它(我们不自动删除成员,让用户先明确处理)。
      const referencingTeams = next.teams.filter((t) =>
        t.members.some((m) => m.agentType === agentType),
      )
      if (referencingTeams.length > 0) {
        const names = referencingTeams.map((t) => t.name || t.id).join('、')
        throw new Error(
          `[bundleRegistry] removeAgent: 以下团队引用了该智能体,请先在团队编辑器中移除对应成员:${names}`,
        )
      }

      const wasPrimary = next.agents[idx].isPrimary === true
      const wasDefault = next.defaultAgent === agentType

      next.agents.splice(idx, 1)

      // 若删的是 primary,把第一个剩下的设为 primary。
      if (wasPrimary && next.agents.length > 0 && !next.agents.some((a) => a.isPrimary)) {
        next.agents[0] = { ...next.agents[0], isPrimary: true }
      }
      // 若删的是 defaultAgent,切到第一个剩下的(normalizeBundle 也会兜底修)。
      if (wasDefault && next.agents.length > 0) {
        next.defaultAgent = next.agents[0].agentType
      }
    },
    app,
    workspacePath,
  )
}

export interface AddTeamSeed {
  id: string
  name?: string
  description?: string
  coordination?: TeamTemplate['coordination']
}

export function addTeam(
  bundleId: string,
  seed: AddTeamSeed,
  app: App,
  workspacePath?: string | undefined | null,
): Bundle {
  const teamId = String(seed.id ?? '').trim()
  if (teamId.length === 0) {
    throw new Error('[bundleRegistry] addTeam: id is required')
  }

  return mutateBundleAndPersist(
    bundleId,
    (next) => {
      if (next.teams.some((t) => t.id === teamId)) {
        throw new Error(
          `[bundleRegistry] addTeam: id "${teamId}" already exists in bundle "${bundleId}"`,
        )
      }
      next.teams.push({
        id: teamId,
        name: seed.name?.trim() || teamId,
        description: seed.description?.trim() ?? '',
        coordination: seed.coordination ?? 'solo',
        members: [],
      })
    },
    app,
    workspacePath,
  )
}

export function removeTeam(
  bundleId: string,
  teamId: string,
  app: App,
  workspacePath?: string | undefined | null,
): Bundle {
  return mutateBundleAndPersist(
    bundleId,
    (next) => {
      const idx = next.teams.findIndex((t) => t.id === teamId)
      if (idx < 0) {
        throw new Error(
          `[bundleRegistry] removeTeam: "${teamId}" not found in bundle "${bundleId}"`,
        )
      }
      next.teams.splice(idx, 1)
    },
    app,
    workspacePath,
  )
}
