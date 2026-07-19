/**
 * Bundle renderer store.
 *
 * Mirrors the main-process `bundleRegistry` state to the renderer and
 * exposes a small imperative API for UI components (activate, reload,
 * observe load errors). Activation is always routed through IPC — we
 * never maintain a divergent "pending" state on the renderer side, so
 * the store is a near-1:1 projection of main's truth.
 *
 * Lifecycle:
 *   - `initialize()` is called once at app boot (see `main.tsx`).
 *     It runs the initial fetch AND subscribes to the
 *     `bundle:activated` broadcast for multi-window / hot-reload support.
 *   - `dispose()` tears down the subscription; in practice the app is
 *     single-window so this is only useful for tests.
 */

import { create } from 'zustand'
import type { Bundle } from '../../electron/agents/bundles/types'
import { useChatStore } from './useChatStore'

interface BundleLoadError {
  filePath: string
  error: string
}

// ─── Chat-hydrate fan-in ─────────────────────────────────────────────
//
// Bug-1/2/3 共同根因:`activeBundleId` 除了"用户在本窗口点 BundleSwitcher
// 切换"这条主路径之外,还会通过以下被动路径变化:
//
//   • `deleteBundle()` 删掉当前激活包后,主进程自动激活 fallback,
//     `bundle:activated` 广播回到本窗口
//   • `reload()` 重扫盘符后,active id 可能已经被换掉
//   • 多窗口/外部进程触发 `bundle:activated` 广播
//
// 这些路径里,原本只有 `activate()` 内部做了 `hydrateAfterWorkspaceChange`
// (取消流、清消息、按新 bundle 分区重拉会话)。其它路径只更新
// `activeBundleId` 的镜像,而 chat 仍展示上一 bundle 的消息——一旦用户
// 保存就会被持久化到新 bundle 的分区,形成跨包串扰。
//
// 解决办法:用一个 module-level 的"上一次已为之 hydrate 过的 bundle id"
// 作 dedupe key,所有路径在 set 完新 active id 之后都调一次
// `rehydrateChatForBundleIfChanged(nextId)`。
//
//   - boot 首次(`initialize`)只记录初始 id,不触发 hydrate——chat 自己
//     在 App / workspace 挂载时已经走过自身的 hydrate 路径。
//   - 同一 id 重复进入(`activate` 早已 early-return,加上广播的双触发等
//     竞态)直接 no-op,不会重复取消流。
//   - 真正 id 变化时,统一调用 chat 的 hydrate。
//
// 此处与 `useChatStore` 互为静态环:
//   bundleStore → useChatStore → storeCompose
//     → conversationSlice / sendSlice / flushAllConversations / conversationPersistence
//     → bundleStore.getActiveBundleId / getActiveBundlePrimaryAgent / ...
//
// 这条环在 ESM 下安全:链路上所有回边引用的 bundleStore 导出都是
// `export function`(声明被 hoist,即使 partial-namespace 也已经有 binding),
// 而 `useBundleStore` / `getActiveBundleId()` 的实际调用全都发生在 action
// method / 异步 handler 内,没有任何模块顶层求值期间会读取它们。所以
// 之前为打破环用的 `await import('./useChatStore')` 既不能做 code-splitting
// (Rolldown INEFFECTIVE_DYNAMIC_IMPORT warning),也不是必要的;改成顶层
// 静态 import 后,bundleStore 这条 `rehydrate` 路径就是普通同步函数调用。
const BUNDLE_ID_UNINITIALIZED = Symbol('bundle-hydrate-uninitialized')
let lastChatHydratedBundleId: string | null | typeof BUNDLE_ID_UNINITIALIZED =
  BUNDLE_ID_UNINITIALIZED

async function rehydrateChatForBundleIfChanged(nextId: string | null): Promise<void> {
  if (lastChatHydratedBundleId === BUNDLE_ID_UNINITIALIZED) {
    // First observation of active id (boot). Chat is hydrated by its own
    // workspace-mount path; just record the baseline so future transitions
    // are correctly detected as changes.
    lastChatHydratedBundleId = nextId
    return
  }
  if (lastChatHydratedBundleId === nextId) return
  lastChatHydratedBundleId = nextId
  try {
    await useChatStore.getState().hydrateAfterWorkspaceChange()
  } catch (err) {
    console.warn('[bundleStore] chat hydrate after bundle change failed:', err)
  }
}

interface BundleStoreState {
  /** Known bundles (merged preset + user + project), keyed by `meta.id`. */
  bundles: Bundle[]
  /** `meta.id` of the currently active bundle, or null before boot. */
  activeBundleId: string | null
  /** Latest load errors surfaced for UI. */
  loadErrors: BundleLoadError[]
  /** True while a reload is in flight — used to disable the Bundle
   *  switcher while we refresh. */
  loading: boolean
  /** Unsubscribe handles. Torn down in `dispose()`. */
  _unsub: (() => void) | null
  _unsubChanged: (() => void) | null
  _unsubDeleted: (() => void) | null

  // ── Actions ──────────────────────────────────────────────────────

  /** One-shot boot — fetch current state + subscribe to broadcasts. */
  initialize: () => Promise<void>

  /** Activate a bundle; no-op when `id` equals the current active id. */
  activate: (id: string) => Promise<void>

  /** Force a full rescan of preset / user / project directories. */
  reload: () => Promise<void>

  /**
   * Persist a patch against one agent inside a bundle. Returns the
   * fresh Bundle so Workbench callers can react (e.g. clear the draft
   * on success). Throws the underlying IPC error on failure — callers
   * should catch and surface via `workbenchDraftStore.setError`.
   *
   * Patch values are the editable agent field shape OR `null` (the
   * wire-level "clear this field" sentinel — see
   * `workbenchDraftStore.computePatchToSend`). `Record<string, unknown>`
   * is used so the compile-time type matches what goes on the wire
   * verbatim; the backend's Zod schema is the runtime gatekeeper.
   */
  saveAgent: (
    bundleId: string,
    agentType: string,
    patch: Record<string, unknown>,
  ) => Promise<Bundle>

  /**
   * Sprint 2c.1: Persist a patch against one team inside a bundle.
   * Same semantics as `saveAgent` (preset auto-fork, null-sentinel
   * clear, throws on IPC error).
   */
  saveTeam: (
    bundleId: string,
    teamId: string,
    patch: Record<string, unknown>,
  ) => Promise<Bundle>

  /**
   * Sprint 2c.2: Persist a patch against a bundle's top-level fields
   * (meta / welcomeMessage / initialContext). Shape matches the Zod
   * schema on the main side.
   */
  saveBundleMeta: (
    bundleId: string,
    patch: Record<string, unknown>,
  ) => Promise<Bundle>

  /**
   * Sprint 2c.2: Create a new bundle. Returns the freshly-created
   * bundle; does NOT auto-activate it (the caller may choose to).
   */
  createBundle: (params: {
    id: string
    name?: string
    description?: string
    domain?: string
    author?: string
    copyFromId?: string
  }) => Promise<Bundle>

  /**
   * Sprint 2c.2: Delete a non-preset bundle. If the deleted bundle
   * was active, the main process auto-activates a fallback; the store
   * observes that via the `bundle:activated` broadcast and updates
   * `activeBundleId` accordingly.
   */
  deleteBundle: (bundleId: string) => Promise<{
    deletedOnDisk: boolean
    newActiveId: string | null
    deletedId: string
  }>

  /** Sprint 2c.2b: append an agent to a bundle. */
  addAgent: (
    bundleId: string,
    seed: {
      agentType: string
      displayName?: string
      whenToUse?: string
      capability?: string
      systemPromptRaw?: string
      isPrimary?: boolean
    },
  ) => Promise<Bundle>

  /** Sprint 2c.2b: remove an agent from a bundle. Throws when it's
   *  the last one or a team member references it. */
  removeAgent: (bundleId: string, agentType: string) => Promise<Bundle>

  /** Sprint 2c.2b: append a team (empty members) to a bundle. */
  addTeam: (
    bundleId: string,
    seed: {
      id: string
      name?: string
      description?: string
      coordination?: 'solo' | 'parallel' | 'sequential' | 'swarm' | 'coordinator'
    },
  ) => Promise<Bundle>

  /** Sprint 2c.2b: remove a team from a bundle. */
  removeTeam: (bundleId: string, teamId: string) => Promise<Bundle>

  /**
   * Sprint 2c.3b: export a bundle to a user-chosen JSON file. The
   * native save-dialog is driven from the main process so the caller
   * just awaits the returned outcome and handles success/cancel/
   * error in UI. Returns the raw `window.electronAPI.bundle.exportBundle`
   * payload verbatim.
   */
  exportBundle: (bundleId: string) =>
    Promise<
      | { ok: true; filePath: string }
      | { ok: false; canceled: true }
      | { ok: false; canceled: false; error: string }
    >

  /**
   * Sprint 2c.3b: import a bundle JSON file. Pass empty options to
   * let the user pick a file; pass `filePath` + `newId` / `replaceExisting`
   * to retry after an id-conflict without re-opening the dialog.
   *
   * The local bundles[] list is NOT eagerly updated here — the main
   * process fires `bundle:changed` on success which the existing
   * listener picks up and does the upsert. Eager update would fight
   * the broadcast (duplicate entry during race).
   */
  importBundle: (options?: {
    filePath?: string
    newId?: string
    replaceExisting?: boolean
  }) =>
    Promise<
      | { ok: true; bundle: Bundle; usedId: string; replaced: boolean }
      | { ok: false; canceled: true }
      | {
          ok: false
          canceled: false
          reason: 'parse-error' | 'id-conflict' | 'preset-conflict' | 'write-error'
          error: string
          attemptedId?: string
          suggestedId?: string
          filePath?: string
        }
    >

  /** Tear down broadcast subscriptions. */
  dispose: () => void
}

type BundleBridge = NonNullable<Window['electronAPI']['bundle']>

/**
 * Retrieve the renderer IPC bridge exposed by preload. Safe to call
 * under SSR / unit tests — returns null when the bridge isn't present,
 * and callers short-circuit. The global `Window['electronAPI'].bundle`
 * is declared optional at the top-level type so legacy renderer
 * environments without preload wiring don't fail to type-check.
 */
function getBridge(): BundleBridge | null {
  if (typeof window === 'undefined') return null
  const api = (window as unknown as { electronAPI?: Window['electronAPI'] }).electronAPI
  return api?.bundle ?? null
}

export const useBundleStore = create<BundleStoreState>((set, get) => ({
  bundles: [],
  activeBundleId: null,
  loadErrors: [],
  loading: false,
  _unsub: null,
  _unsubChanged: null,
  _unsubDeleted: null,

  initialize: async () => {
    const bridge = getBridge()
    if (!bridge) {
      // Non-electron / test environment — leave empty state.
      return
    }
    // Prevent double-subscription on React StrictMode double-effect.
    if (get()._unsub) return

    set({ loading: true })
    let initialActiveId: string | null = null
    try {
      const result = await bridge.list()
      initialActiveId = result.activeId
      set({
        bundles: result.bundles,
        activeBundleId: result.activeId,
        loadErrors: result.errors,
        loading: false,
      })
    } catch (err) {
      console.warn('[bundleStore] initial list failed:', err)
      set({ loading: false })
    }
    // Record the boot baseline. This is a no-op hydrate (sentinel transition)
    // so chat boots from its own workspace-mount path without being yanked.
    await rehydrateChatForBundleIfChanged(initialActiveId)

    // Subscribe to activation broadcasts. Handler does NOT call
    // `activate()` — it just mirrors the new state, since main has
    // already updated itself before emitting.
    //
    // Bug-1/3 fix: every broadcast-driven id change must also trigger the
    // chat hydrate. Routes that hit this listener include delete-fallback
    // auto-activation, multi-window cross-activation, and reload-induced
    // activeId rewrites — none of which used to refresh the chat UI on
    // their own, leaving stale messages bound to the new bundle's partition.
    const unsub = bridge.onActivated((payload) => {
      set((state) => {
        const nextBundles = payload.bundle
          ? upsertBundle(state.bundles, payload.bundle)
          : state.bundles
        return {
          bundles: nextBundles,
          activeBundleId: payload.activeId,
        }
      })
      void rehydrateChatForBundleIfChanged(payload.activeId)
    })

    // Phase 2 Sprint 2a: subscribe to content-change broadcasts so
    // saves from any window (and future multi-instance edits) reflect
    // into the local store immediately without a `list()` round-trip.
    // Safe to use optional chaining here — older preloads without
    // `onChanged` simply skip this subscription.
    const unsubChanged = bridge.onChanged?.((payload) => {
      set((state) => ({
        bundles: upsertBundle(state.bundles, payload.bundle),
      }))
    }) ?? null

    // Sprint 2c.2: subscribe to deletion broadcasts. Remove the bundle
    // from the local list when main tells us it's gone (whether the
    // delete was initiated by this window or another).
    const unsubDeleted = bridge.onDeleted?.((payload) => {
      set((state) => ({
        bundles: state.bundles.filter((b) => b.meta.id !== payload.deletedId),
        // activeBundleId is kept in sync by the `bundle:activated`
        // broadcast that main also fires when the active bundle is
        // deleted, so we don't touch it here.
      }))
    }) ?? null

    set({ _unsub: unsub, _unsubChanged: unsubChanged, _unsubDeleted: unsubDeleted })
  },

  activate: async (id) => {
    const current = get().activeBundleId
    if (id === current) return
    const bridge = getBridge()
    if (!bridge) return
    set({ loading: true })
    try {
      const result = await bridge.activate(id)
      set((state) => ({
        bundles: upsertBundle(state.bundles, result.bundle),
        activeBundleId: result.activeId,
        loading: false,
      }))

      // Plan §4.5.4 E3: after the active bundle id changes, rebuild the
      // chat UI from whatever the NEW bundle partition has on disk. We
      // route through `rehydrateChatForBundleIfChanged` so the same dedupe
      // key suppresses the redundant hydrate that the immediately-following
      // `bundle:activated` broadcast (same id) would otherwise trigger via
      // the listener installed in `initialize()`.
      await rehydrateChatForBundleIfChanged(result.activeId)
    } catch (err) {
      console.warn(`[bundleStore] activate("${id}") failed:`, err)
      set({ loading: false })
    }
  },

  reload: async () => {
    const bridge = getBridge()
    if (!bridge) return
    set({ loading: true })
    let nextActiveId: string | null | undefined
    try {
      const result = await bridge.reload()
      nextActiveId = result.activeId
      set({
        bundles: result.bundles,
        loadErrors: result.errors,
        activeBundleId: result.activeId,
        loading: false,
      })
    } catch (err) {
      console.warn('[bundleStore] reload failed:', err)
      set({ loading: false })
    }
    // Bug-2 fix: rescanning preset/user/project tiers can move the active
    // id (the previously-active bundle's JSON was deleted on disk, the user
    // edited its `id` field, etc.). The renderer used to just mirror the
    // new id without rebuilding the chat UI — leaving stale messages bound
    // to a partition the user no longer owns.
    if (nextActiveId !== undefined) {
      await rehydrateChatForBundleIfChanged(nextActiveId)
    }
  },

  saveAgent: async (bundleId, agentType, patch) => {
    const bridge = getBridge()
    if (!bridge) {
      throw new Error('Bundle bridge unavailable (not running inside Electron?)')
    }
    // Upsert the fresh bundle locally even though `bundle:changed`
    // broadcast will do the same — this guarantees the Promise
    // resolves to a state the caller can immediately rely on without
    // racing the event loop.
    const result = await bridge.saveAgent({
      bundleId,
      agentType,
      patch,
    })
    set((state) => ({
      bundles: upsertBundle(state.bundles, result.bundle),
      activeBundleId: result.activeId ?? state.activeBundleId,
    }))
    return result.bundle
  },

  saveTeam: async (bundleId, teamId, patch) => {
    const bridge = getBridge()
    if (!bridge) {
      throw new Error('Bundle bridge unavailable (not running inside Electron?)')
    }
    const result = await bridge.saveTeam({ bundleId, teamId, patch })
    set((state) => ({
      bundles: upsertBundle(state.bundles, result.bundle),
      activeBundleId: result.activeId ?? state.activeBundleId,
    }))
    return result.bundle
  },

  saveBundleMeta: async (bundleId, patch) => {
    const bridge = getBridge()
    if (!bridge) {
      throw new Error('Bundle bridge unavailable (not running inside Electron?)')
    }
    const result = await bridge.saveMeta({ bundleId, patch })
    set((state) => ({
      bundles: upsertBundle(state.bundles, result.bundle),
      activeBundleId: result.activeId ?? state.activeBundleId,
    }))
    return result.bundle
  },

  createBundle: async (params) => {
    const bridge = getBridge()
    if (!bridge) {
      throw new Error('Bundle bridge unavailable (not running inside Electron?)')
    }
    const result = await bridge.create(params)
    // The `bundle:changed` broadcast will also upsert, but doing it
    // eagerly here lets the caller (e.g. a CreateBundleDialog) await
    // and navigate to the new bundle in the same tick.
    set((state) => ({
      bundles: upsertBundle(state.bundles, result.bundle),
    }))
    return result.bundle
  },

  addAgent: async (bundleId, seed) => {
    const bridge = getBridge()
    if (!bridge) {
      throw new Error('Bundle bridge unavailable (not running inside Electron?)')
    }
    const result = await bridge.addAgent({ bundleId, seed })
    set((state) => ({
      bundles: upsertBundle(state.bundles, result.bundle),
      activeBundleId: result.activeId ?? state.activeBundleId,
    }))
    return result.bundle
  },

  removeAgent: async (bundleId, agentType) => {
    const bridge = getBridge()
    if (!bridge) {
      throw new Error('Bundle bridge unavailable (not running inside Electron?)')
    }
    const result = await bridge.removeAgent({ bundleId, agentType })
    set((state) => ({
      bundles: upsertBundle(state.bundles, result.bundle),
      activeBundleId: result.activeId ?? state.activeBundleId,
    }))
    return result.bundle
  },

  addTeam: async (bundleId, seed) => {
    const bridge = getBridge()
    if (!bridge) {
      throw new Error('Bundle bridge unavailable (not running inside Electron?)')
    }
    const result = await bridge.addTeam({ bundleId, seed })
    set((state) => ({
      bundles: upsertBundle(state.bundles, result.bundle),
      activeBundleId: result.activeId ?? state.activeBundleId,
    }))
    return result.bundle
  },

  removeTeam: async (bundleId, teamId) => {
    const bridge = getBridge()
    if (!bridge) {
      throw new Error('Bundle bridge unavailable (not running inside Electron?)')
    }
    const result = await bridge.removeTeam({ bundleId, teamId })
    set((state) => ({
      bundles: upsertBundle(state.bundles, result.bundle),
      activeBundleId: result.activeId ?? state.activeBundleId,
    }))
    return result.bundle
  },

  exportBundle: async (bundleId) => {
    const bridge = getBridge()
    if (!bridge) {
      throw new Error('Bundle bridge unavailable (not running inside Electron?)')
    }
    return bridge.exportBundle({ bundleId })
  },

  importBundle: async (options) => {
    const bridge = getBridge()
    if (!bridge) {
      throw new Error('Bundle bridge unavailable (not running inside Electron?)')
    }
    const result = await bridge.importBundle(options ?? {})
    // Success path: main broadcasts `bundle:changed` → our existing
    // onChanged listener upserts. Eager upsert here would race the
    // event and double-render.
    return result
  },

  deleteBundle: async (bundleId) => {
    const bridge = getBridge()
    if (!bridge) {
      throw new Error('Bundle bridge unavailable (not running inside Electron?)')
    }
    const previousActiveId = get().activeBundleId
    const result = await bridge.delete(bundleId)
    // The `bundle:deleted` + `bundle:activated` broadcasts will also
    // update the store, but we eagerly apply the removal here so the
    // caller can synchronously flip selection without racing events.
    set((state) => ({
      bundles: state.bundles.filter((b) => b.meta.id !== result.deletedId),
      activeBundleId:
        state.activeBundleId === result.deletedId
          ? result.newActiveId ?? null
          : state.activeBundleId,
    }))

    // Bug-1 fix: when the deleted bundle was the active one, main
    // auto-activates a fallback. The chat UI was previously left
    // dangling — `activeBundleId` flipped to the fallback but
    // `messages` / `currentConversationId` still belonged to the
    // (now-deleted) bundle, so the very next save persisted those
    // messages into the fallback partition.
    //
    // Routing through the shared dedupe helper means: (a) when this
    // path runs first, the chat is rebuilt synchronously before
    // `deleteBundle` resolves; (b) the trailing `bundle:activated`
    // broadcast collapses to a no-op via the dedupe key.
    if (previousActiveId === result.deletedId) {
      await rehydrateChatForBundleIfChanged(result.newActiveId ?? null)
    }
    return result
  },

  dispose: () => {
    const { _unsub, _unsubChanged, _unsubDeleted } = get()
    for (const fn of [_unsub, _unsubChanged, _unsubDeleted]) {
      if (!fn) continue
      try {
        fn()
      } catch {
        /* ignore */
      }
    }
    set({ _unsub: null, _unsubChanged: null, _unsubDeleted: null })
    // Reset the chat-hydrate dedupe baseline so a subsequent
    // `initialize()` (test re-entry / hot-reload) re-establishes its
    // own "no-hydrate-on-boot" sentinel and tracks fresh transitions.
    lastChatHydratedBundleId = BUNDLE_ID_UNINITIALIZED
  },
}))

/** Insert-or-replace a bundle in the array, keyed by `meta.id`. */
function upsertBundle(bundles: Bundle[], next: Bundle): Bundle[] {
  const idx = bundles.findIndex((b) => b.meta.id === next.meta.id)
  if (idx < 0) return [...bundles, next]
  const copy = bundles.slice()
  copy[idx] = next
  return copy
}

// ─── Convenient selectors ────────────────────────────────────────────

/** Subscribe to the currently active bundle (nullable). */
export function useActiveBundle(): Bundle | null {
  return useBundleStore((s) =>
    s.activeBundleId ? s.bundles.find((b) => b.meta.id === s.activeBundleId) ?? null : null,
  )
}

/** Subscribe to a map of bundles by id — useful for the switcher UI. */
export function useBundleList(): Bundle[] {
  return useBundleStore((s) => s.bundles)
}

// ─── Non-reactive helpers for non-component callers ──────────────────

/**
 * Read the currently active bundle id outside a React component (e.g.
 * from zustand store actions that need to scope persistence writes, or
 * service-layer code that can't use hooks).
 *
 * Returns `undefined` when no bundle is active yet — callers should
 * treat that as "default bundle" which, on the main-process side,
 * maps to the legacy `code-dev` partition (plan §4.5.4 zero-migration
 * default).
 */
export function getActiveBundleId(): string | undefined {
  return useBundleStore.getState().activeBundleId ?? undefined
}

/**
 * Non-reactive lookup of the currently active bundle (full object).
 * Returns `null` when no bundle is active, or the active id points to
 * a bundle that isn't loaded yet.
 */
export function getActiveBundle(): Bundle | null {
  const s = useBundleStore.getState()
  if (!s.activeBundleId) return null
  return s.bundles.find((b) => b.meta.id === s.activeBundleId) ?? null
}

/**
 * Non-reactive lookup of the primary agent inside the active bundle —
 * the one that drives the main chat panel's system prompt and `agentType`.
 *
 * Falls back to the first agent when no entry is flagged `isPrimary`.
 * Returns `null` when no bundle is active or the bundle has zero agents
 * (the latter shouldn't happen because `bundleSerialize.normalizeBundle`
 * enforces at least one agent, but we guard just in case).
 */
export function getActiveBundlePrimaryAgent(): Bundle['agents'][number] | null {
  const bundle = getActiveBundle()
  if (!bundle) return null
  const primary = bundle.agents.find((a) => a.isPrimary === true)
  return primary ?? bundle.agents[0] ?? null
}

/**
 * Compose a plain-string system prompt for one bundle agent, mirroring
 * the main-process {@link composeSystemPrompt} in `bundleSerialize.ts`.
 *
 * Returns:
 *   - joined `promptSections` when defined and non-empty (preferred shape);
 *   - `systemPromptRaw` when defined and non-empty;
 *   - empty string otherwise.
 *
 * Built-in agents (code-dev / general-assistant / writing-assistant's
 * preset entries without overrides) may return an empty string — callers
 * should pass `systemPrompt: undefined` in that case so the main process
 * falls back to its default layered prompt instead of replacing it with
 * an empty string. See `orchestrationContext.ts` — an empty `custom`
 * bypasses the custom branch and defaults kick in naturally, but passing
 * an empty **non-undefined** string would still be safe; we treat empty
 * as "no override" to stay explicit.
 */
export function composeSystemPromptFromBundleAgent(
  agent: Bundle['agents'][number] | null | undefined,
): string {
  if (!agent) return ''
  const sections = agent.promptSections
  if (Array.isArray(sections) && sections.length > 0) {
    return sections
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((s) =>
        s.title && s.title.trim().length > 0 ? `## ${s.title}\n\n${s.body}` : s.body,
      )
      .join('\n\n')
      .trim()
  }
  const raw = agent.systemPromptRaw
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw
  }
  return ''
}
