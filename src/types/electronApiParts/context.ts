import type {
  ContextAnalysisResult,
  ContextStateCompact,
  ContextThresholdsCompact,
  PromptDiagnosticsRecordCompact,
} from '../workspaceModels'

export interface ElectronContextApi {
  getState: (conversationId?: string) => Promise<ContextStateCompact>
  getPromptDiagnostics: (
    payload?: { limit?: number; conversationId?: string } | number,
  ) => Promise<PromptDiagnosticsRecordCompact[]>
  renderBaselineReport: (payload: {
    title?: string
    prompt: string
    notes?: string
    limit?: number
    conversationId?: string
  }) => Promise<string>
  renderBaselineComparison: (payload: {
    title?: string
    baselineLabel?: string
    currentLabel?: string
    baseline: Array<Record<string, unknown>>
    current: Array<Record<string, unknown>>
  }) => Promise<string>
  getThresholds: () => Promise<ContextThresholdsCompact>
  setThresholds: (thresholds: Partial<ContextThresholdsCompact>) => Promise<{ success: boolean }>
  reset: (payload?: { conversationId?: string }) => Promise<{ success: boolean }>
  analyze: (input: {
    model: string
    systemPrompt: string
    messages: Array<Record<string, unknown>>
    toolDefinitions?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>
    memoryTokens?: number
    skillTokens?: number
  }) => Promise<ContextAnalysisResult>
  analyzeFormatted: (input: {
    model: string
    systemPrompt: string
    messages: Array<Record<string, unknown>>
    toolDefinitions?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>
    memoryTokens?: number
    skillTokens?: number
  }) => Promise<string>
  analyzeLive: () => Promise<ContextAnalysisResult | null>
  analyzeLiveFormatted: () => Promise<string>
  onDisplayUpdated: (
    callback: (payload: { conversationId: string | null }) => void,
  ) => () => void
  /** Renderer pushes the `providerRegistry.contextWindow` map at app boot. */
  setRegistryWindows: (
    map: Record<string, number>,
  ) => Promise<{ success: boolean; count?: number; error?: string }>
  getRegistryWindows: () => Promise<Record<string, number>>
  getUserWindowOverrides: () => Promise<Record<string, number>>
  setUserWindowOverride: (
    payload: { modelId: string; tokens: number },
  ) => Promise<{ success: boolean; error?: string }>
  clearUserWindowOverride: (
    payload: { modelId: string },
  ) => Promise<{ success: boolean; error?: string }>
}
