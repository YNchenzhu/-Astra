import type { Bundle } from '../../../electron/agents/bundles/types'

/**
 * Personal-workspace Bundle system (see plan §4.5.10). Optional
 * at the declaration level — legacy renderer code that pre-dates
 * the bundle wiring simply ignores it. Shape mirrors the preload
 * `ElectronAPI.bundle` definition.
 */
export interface ElectronBundleApi {
  list: () => Promise<{
    bundles: Bundle[]
    activeId: string | null
    errors: Array<{ filePath: string; error: string }>
  }>
  getActive: () => Promise<{
    bundle: Bundle | null
    activeId: string | null
  }>
  activate: (id: string) => Promise<{
    bundle: Bundle
    activeId: string
  }>
  reload: () => Promise<{
    bundles: Bundle[]
    errors: Array<{ filePath: string; error: string }>
    activeId: string | null
  }>
  getLoadErrors: () => Promise<Array<{ filePath: string; error: string }>>
  /**
   * Persist scalar agent fields. Preset-sourced bundles are
   * auto-forked to the user tier. Throws on validation failure.
   * Phase 2 Sprint 2a — complex fields (promptSections / hooks
   * / tool arrays) rejected server-side until Sprint 2b.
   */
  saveAgent: (payload: {
    bundleId: string
    agentType: string
    patch: Record<string, unknown>
  }) => Promise<{
    bundle: Bundle
    activeId: string | null
  }>
  /** Sprint 2c.1: 团队字段保存。 */
  saveTeam: (payload: {
    bundleId: string
    teamId: string
    patch: Record<string, unknown>
  }) => Promise<{
    bundle: Bundle
    activeId: string | null
  }>
  /** Sprint 2c.2: 工作包顶层字段(meta/上下文/欢迎语)保存。 */
  saveMeta: (payload: {
    bundleId: string
    patch: Record<string, unknown>
  }) => Promise<{
    bundle: Bundle
    activeId: string | null
  }>
  /** Sprint 2c.2: 新建工作包(空白 / 复制自 copyFromId)。 */
  create: (params: {
    id: string
    name?: string
    description?: string
    domain?: string
    author?: string
    copyFromId?: string
  }) => Promise<{
    bundle: Bundle
    activeId: string | null
  }>
  /** Sprint 2c.2: 删除用户/项目级工作包。 */
  delete: (bundleId: string) => Promise<{
    deletedOnDisk: boolean
    newActiveId: string | null
    deletedId: string
  }>
  /** Sprint 2c.2b: 向工作包追加一个智能体。 */
  addAgent: (payload: {
    bundleId: string
    seed: {
      agentType: string
      displayName?: string
      whenToUse?: string
      capability?: string
      systemPromptRaw?: string
      isPrimary?: boolean
    }
  }) => Promise<{
    bundle: Bundle
    activeId: string | null
  }>
  /** Sprint 2c.2b: 从工作包移除一个智能体(不可移除最后一个;
   *  若被团队引用也会被拒绝)。 */
  removeAgent: (payload: { bundleId: string; agentType: string }) => Promise<{
    bundle: Bundle
    activeId: string | null
  }>
  /** Sprint 2c.2b: 向工作包追加一个团队(成员初始为空)。 */
  addTeam: (payload: {
    bundleId: string
    seed: {
      id: string
      name?: string
      description?: string
      coordination?: 'solo' | 'parallel' | 'sequential' | 'swarm' | 'coordinator'
    }
  }) => Promise<{
    bundle: Bundle
    activeId: string | null
  }>
  /** Sprint 2c.2b: 从工作包移除一个团队。 */
  removeTeam: (payload: { bundleId: string; teamId: string }) => Promise<{
    bundle: Bundle
    activeId: string | null
  }>
  /** Sprint 2c.3b: 导出工作包到用户选择的 JSON 文件。 */
  exportBundle: (payload: { bundleId: string }) => Promise<
    | { ok: true; filePath: string }
    | { ok: false; canceled: true }
    | { ok: false; canceled: false; error: string }
  >
  /** Sprint 2c.3b: 导入工作包 JSON。冲突时返回
   *  `id-conflict` / `preset-conflict`,调用方可用 newId 或
   *  replaceExisting 重试。 */
  importBundle: (options: {
    filePath?: string
    newId?: string
    replaceExisting?: boolean
  }) => Promise<
    | {
        ok: true
        bundle: Bundle
        usedId: string
        replaced: boolean
      }
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
  /** Sprint 2d.a: 发起试跑(单次 LLM 调用,无工具、无多轮 agentic 循环)。 */
  tryRunAgent: (payload: {
    bundleId: string
    agentType: string
    messages: Array<{ role: 'user' | 'assistant'; content: string }>
    modelOverride?: string
    systemPromptOverride?: string
  }) => Promise<
    | { ok: true; runId: string; model: string; systemPromptLength: number }
    | { ok: false; error: string }
  >
  /** Sprint 2d.a: 中止正在进行的试跑。 */
  tryRunCancel: (payload: { runId: string }) => Promise<{ ok: boolean }>
  /** Sprint 2d.a: 订阅试跑流式 token。 */
  onTryRunDelta: (
    handler: (payload: { runId: string; text: string }) => void,
  ) => () => void
  /** Sprint 2d.a: 订阅试跑结束事件。 */
  onTryRunEnd: (
    handler: (payload: { runId: string; usage: unknown }) => void,
  ) => () => void
  /** Sprint 2d.a: 订阅试跑错误事件。 */
  onTryRunError: (
    handler: (payload: { runId: string; error: string }) => void,
  ) => () => void
  /** Sprint 2b.1: 载入内置智能体的运行时提示词并按 `##` 拆段,
   *  供工作台「载入并转为可编辑」动作使用。*/
  getBuiltinPrompt: (payload: {
    bundleId: string
    agentType: string
  }) => Promise<
    | {
        ok: true
        raw: string
        sections: Array<{
          id: string
          title: string
          hint?: string
          body: string
          order: number
          required?: boolean
        }>
      }
    | { ok: false; error: string }
  >
  /** Sprint 2b.2: 列举所有可选的工具/技能/MCP 服务器名称。 */
  getCapabilityCatalog: () => Promise<{
    tools: string[]
    skills: string[]
    mcpServers: string[]
  }>
  onActivated: (
    handler: (payload: {
      activeId: string | null
      bundle: Bundle | null
    }) => void,
  ) => () => void
  /** Subscribe to bundle content-change broadcasts. */
  onChanged: (
    handler: (payload: {
      bundle: Bundle
      reason: string
    }) => void,
  ) => () => void
  /** Sprint 2c.2: subscribe to deletion broadcasts. */
  onDeleted: (
    handler: (payload: { deletedId: string }) => void,
  ) => () => void
}
