/**
 * Memory + retrieval slice.
 *
 * Groups every setting that feeds the memory-recall pipeline (auto-memory,
 * hybrid scoring, LLM side-query) plus the embedding / reranker
 * configuration shared between attachment RAG and semantic memory recall.
 * Embedding + rerank are kept here (not in their own slice) because every
 * use-case that reads `memoryHybridRecallEnabled` also needs the active
 * embedding config — splitting them would force every consumer to merge
 * two selector subscriptions.
 */
import type { StateCreator } from 'zustand'
import { persistFromState } from '../persistSnapshot'
import type { SettingsState } from '../types'

export type MemorySlice = Pick<SettingsState,
  | 'autoMemoryEnabled' | 'autoMemoryDirectory'
  | 'agentExperienceMemoryEnabled' | 'memoryAiRecallEnabled'
  | 'memoryHybridRecallEnabled' | 'memoryFreshnessWeight'
  | 'memoryRecallMinScore' | 'memoryRecallSkipShortQueryChars'
  | 'memoryRecallTopK' | 'memoryRecallMaxBytes'
  | 'memoryRecallSessionBudgetBytes'
  | 'workspaceContextEnabled' | 'workspaceContextTopK' | 'workspaceContextMinScore'
  | 'attachmentContextTopK' | 'attachmentContextMinScore'
  | 'embeddingProviderId' | 'embeddingModel' | 'embeddingApiKey'
  | 'embeddingBaseUrl' | 'embeddingDimensions'
  | 'embeddingMode' | 'embeddingLocalModelId'
  | 'rerankProviderId' | 'rerankModel' | 'rerankApiKey' | 'rerankBaseUrl'
  | 'setAutoMemoryEnabled' | 'setAutoMemoryDirectory'
  | 'setMemoryAiRecallEnabled' | 'setAgentExperienceMemoryEnabled'
  | 'setMemoryHybridRecallEnabled' | 'setMemoryFreshnessWeight'
  | 'setRecallTuning'
  | 'setEmbeddingConfig' | 'setRerankConfig'
>

export const createMemorySlice: StateCreator<
  SettingsState, [], [], MemorySlice
> = (set, get) => ({
  autoMemoryEnabled: false,
  autoMemoryDirectory: '',
  agentExperienceMemoryEnabled: false,
  memoryAiRecallEnabled: true,
  memoryHybridRecallEnabled: true,
  memoryFreshnessWeight: 0.5,
  // Defaults must mirror electron/memory/recallTuning.ts DEFAULTS — that
  // module is the runtime source of truth (it clamps + falls back to the
  // same constants), but the slice needs its own literal copy because the
  // renderer never imports from electron/.
  memoryRecallMinScore: 0.30,
  memoryRecallSkipShortQueryChars: 8,
  memoryRecallTopK: 5,
  memoryRecallMaxBytes: 24_000,
  memoryRecallSessionBudgetBytes: 32_000,
  workspaceContextEnabled: true,
  workspaceContextTopK: 6,
  workspaceContextMinScore: 0.30,
  attachmentContextTopK: 6,
  attachmentContextMinScore: 0.30,
  embeddingProviderId: '',
  embeddingModel: '',
  embeddingApiKey: '',
  embeddingBaseUrl: '',
  embeddingDimensions: null,
  embeddingMode: 'auto',
  embeddingLocalModelId: '',
  rerankProviderId: '',
  rerankModel: '',
  rerankApiKey: '',
  rerankBaseUrl: '',

  setAutoMemoryEnabled: (autoMemoryEnabled) => {
    const update = { autoMemoryEnabled }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setAutoMemoryDirectory: (autoMemoryDirectory) => {
    const update = { autoMemoryDirectory }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setMemoryAiRecallEnabled: (memoryAiRecallEnabled) => {
    const update = { memoryAiRecallEnabled }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setAgentExperienceMemoryEnabled: (agentExperienceMemoryEnabled) => {
    const update = { agentExperienceMemoryEnabled }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setMemoryHybridRecallEnabled: (memoryHybridRecallEnabled) => {
    const update = { memoryHybridRecallEnabled }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setMemoryFreshnessWeight: (weight) => {
    const update = { memoryFreshnessWeight: Math.max(0, Math.min(1, weight)) }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setRecallTuning: (patch) => {
    // Range-clamp on the renderer side too so the persisted JSON never
    // contains nonsense; the main process re-clamps via getRecallTuning()
    // so even hand-edited settings.json stays bounded.
    const norm: Partial<MemorySlice> = {}
    if (typeof patch.memoryRecallMinScore === 'number') {
      norm.memoryRecallMinScore = Math.max(0, Math.min(1, patch.memoryRecallMinScore))
    }
    if (typeof patch.memoryRecallSkipShortQueryChars === 'number') {
      norm.memoryRecallSkipShortQueryChars = Math.max(
        0, Math.min(200, Math.floor(patch.memoryRecallSkipShortQueryChars)),
      )
    }
    if (typeof patch.memoryRecallTopK === 'number') {
      norm.memoryRecallTopK = Math.max(1, Math.min(50, Math.floor(patch.memoryRecallTopK)))
    }
    if (typeof patch.memoryRecallMaxBytes === 'number') {
      norm.memoryRecallMaxBytes = Math.max(
        1_000, Math.min(200_000, Math.floor(patch.memoryRecallMaxBytes)),
      )
    }
    if (typeof patch.memoryRecallSessionBudgetBytes === 'number') {
      norm.memoryRecallSessionBudgetBytes = Math.max(
        1_000, Math.min(1_000_000, Math.floor(patch.memoryRecallSessionBudgetBytes)),
      )
    }
    if (typeof patch.workspaceContextEnabled === 'boolean') {
      norm.workspaceContextEnabled = patch.workspaceContextEnabled
    }
    if (typeof patch.workspaceContextTopK === 'number') {
      norm.workspaceContextTopK = Math.max(1, Math.min(50, Math.floor(patch.workspaceContextTopK)))
    }
    if (typeof patch.workspaceContextMinScore === 'number') {
      norm.workspaceContextMinScore = Math.max(0, Math.min(1, patch.workspaceContextMinScore))
    }
    if (typeof patch.attachmentContextTopK === 'number') {
      norm.attachmentContextTopK = Math.max(1, Math.min(50, Math.floor(patch.attachmentContextTopK)))
    }
    if (typeof patch.attachmentContextMinScore === 'number') {
      norm.attachmentContextMinScore = Math.max(0, Math.min(1, patch.attachmentContextMinScore))
    }
    set(norm as MemorySlice)
    persistFromState({ ...get(), ...norm })
  },

  setEmbeddingConfig: (patch) => {
    const update = { ...patch }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setRerankConfig: (patch) => {
    const update = { ...patch }
    set(update)
    persistFromState({ ...get(), ...update })
  },
})
