/**
 * Model behavior + editor UX + notifications slice.
 *
 * Houses every boolean / enum that describes *how* the main AI chat runs or
 * how the editor reacts to external events. Fields here never change the
 * persisted API credentials — those live in `apiConfigsSlice`.
 */
import type { StateCreator } from 'zustand'
import { DEFAULT_SHELL } from '../defaults'
import { persistFromState } from '../persistSnapshot'
import type { SettingsState } from '../types'

export type BehaviorSlice = Pick<SettingsState,
  | 'effortLevel' | 'fastMode' | 'alwaysThinking' | 'thinkingBudgetTokens'
  | 'showThinkingSummaries' | 'compactThinkingOnSave'
  | 'thinkingAutoCollapseThreshold'
  | 'tabAutocompleteEnabled' | 'inlineDiffsEnabled'
  | 'defaultDiffViewMode' | 'externalDiskChangeRefreshMode' | 'defaultShell'
  | 'prefersReducedMotion' | 'promptSuggestionEnabled' | 'autoTaskRouting'
  | 'spinnerTipsEnabled' | 'desktopNotificationMode'
  | 'notifyOnAskUserQuestion' | 'notifyOnSubagentCompleted'
  | 'notifyOnSubagentFailed' | 'notifyOnSubagentStopped'
  | 'setEffortLevel' | 'setFastMode' | 'setAlwaysThinking'
  | 'setThinkingBudgetTokens' | 'setShowThinkingSummaries'
  | 'setCompactThinkingOnSave'
  | 'setThinkingAutoCollapseThreshold'
  | 'setTabAutocompleteEnabled' | 'setInlineDiffsEnabled'
  | 'setDefaultDiffViewMode' | 'setExternalDiskChangeRefreshMode'
  | 'setDefaultShell' | 'setPrefersReducedMotion'
  | 'setPromptSuggestionEnabled' | 'setAutoTaskRouting'
  | 'setSpinnerTipsEnabled' | 'setDesktopNotificationMode'
  | 'setNotifyOnAskUserQuestion' | 'setNotifyOnSubagentCompleted'
  | 'setNotifyOnSubagentFailed' | 'setNotifyOnSubagentStopped'
>

export const createBehaviorSlice: StateCreator<
  SettingsState, [], [], BehaviorSlice
> = (set, get) => ({
  // 2026-07 quality uplift — raised from 'low' back to 'medium', and
  // extended thinking now defaults ON. The earlier 'low' default (adopted
  // to avoid ~8k thinking tokens on trivial questions) measurably degraded
  // plan/implement/verify quality on real tasks: with thinking off and
  // effort low, the model considers far fewer edge cases at every phase.
  // 'medium' + alwaysThinking keeps latency reasonable on simple turns
  // (the adaptive throttle in `adaptiveThinkingBudget.ts` still trims
  // routine iterations) while restoring depth where it matters. Users who
  // prioritize speed can switch to 'low' / toggle thinking off in
  // Settings → Behavior.
  effortLevel: 'medium',
  fastMode: false,
  alwaysThinking: true,
  thinkingBudgetTokens: 0,
  showThinkingSummaries: false,
  compactThinkingOnSave: false,
  // 长会话兜底默认 8：经验值，超过 8 个 thinking 块时整页基本就是默认展开的
  // 厚重 markdown，开始挡用户视线；用户可以在 Settings 把它调到 0（关闭）或
  // 更大的值。
  thinkingAutoCollapseThreshold: 8,
  tabAutocompleteEnabled: true,
  inlineDiffsEnabled: true,
  defaultDiffViewMode: 'inline' as const,
  externalDiskChangeRefreshMode: 'skip_if_dirty',
  defaultShell: DEFAULT_SHELL,
  prefersReducedMotion: false,
  promptSuggestionEnabled: true,
  autoTaskRouting: true,
  spinnerTipsEnabled: true,
  desktopNotificationMode: 'minimized',
  notifyOnAskUserQuestion: true,
  notifyOnSubagentCompleted: true,
  notifyOnSubagentFailed: true,
  notifyOnSubagentStopped: true,

  setEffortLevel: (effortLevel) => {
    const update = { effortLevel }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setFastMode: (fastMode) => {
    const update = { fastMode }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setAlwaysThinking: (alwaysThinking) => {
    const update = { alwaysThinking }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setThinkingBudgetTokens: (thinkingBudgetTokens) => {
    const n =
      typeof thinkingBudgetTokens === 'number' && Number.isFinite(thinkingBudgetTokens)
        ? Math.min(Math.max(0, Math.floor(thinkingBudgetTokens)), 32768)
        : 0
    const update = { thinkingBudgetTokens: n }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setShowThinkingSummaries: (showThinkingSummaries) => {
    const update = { showThinkingSummaries }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setCompactThinkingOnSave: (compactThinkingOnSave) => {
    const update = { compactThinkingOnSave }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setThinkingAutoCollapseThreshold: (thinkingAutoCollapseThreshold) => {
    // 防御性夹紧：负数 / NaN / 非整数 → 0（关闭）；上限 9999 防误填超大值。
    const n =
      typeof thinkingAutoCollapseThreshold === 'number' &&
      Number.isFinite(thinkingAutoCollapseThreshold)
        ? Math.min(Math.max(0, Math.floor(thinkingAutoCollapseThreshold)), 9999)
        : 0
    const update = { thinkingAutoCollapseThreshold: n }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setTabAutocompleteEnabled: (tabAutocompleteEnabled) => {
    const update = { tabAutocompleteEnabled }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setInlineDiffsEnabled: (inlineDiffsEnabled) => {
    const update = { inlineDiffsEnabled }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setDefaultDiffViewMode: (defaultDiffViewMode) => {
    const update = { defaultDiffViewMode }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setExternalDiskChangeRefreshMode: (externalDiskChangeRefreshMode) => {
    const update = { externalDiskChangeRefreshMode }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setDefaultShell: (defaultShell) => {
    const update = { defaultShell }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setPrefersReducedMotion: (prefersReducedMotion) => {
    const update = { prefersReducedMotion }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setPromptSuggestionEnabled: (promptSuggestionEnabled) => {
    const update = { promptSuggestionEnabled }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setAutoTaskRouting: (autoTaskRouting) => {
    const update = { autoTaskRouting }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setSpinnerTipsEnabled: (spinnerTipsEnabled) => {
    const update = { spinnerTipsEnabled }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setDesktopNotificationMode: (desktopNotificationMode) => {
    const update = { desktopNotificationMode }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setNotifyOnAskUserQuestion: (notifyOnAskUserQuestion) => {
    const update = { notifyOnAskUserQuestion }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setNotifyOnSubagentCompleted: (notifyOnSubagentCompleted) => {
    const update = { notifyOnSubagentCompleted }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setNotifyOnSubagentFailed: (notifyOnSubagentFailed) => {
    const update = { notifyOnSubagentFailed }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setNotifyOnSubagentStopped: (notifyOnSubagentStopped) => {
    const update = { notifyOnSubagentStopped }
    set(update)
    persistFromState({ ...get(), ...update })
  },
})
