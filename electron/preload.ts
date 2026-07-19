/**
 * Electron preload entry — exposes `window.electronAPI` via `contextBridge`.
 *
 * Kept deliberately thin. Every domain API (types + factory) lives in
 * `electron/preload/<domain>.ts`; this file only composes them into the
 * final `ElectronAPI` object and wires the one side-effect bridge that
 * must run at load time (before-quit flush).
 */
import { contextBridge } from 'electron'

import {
  installBeforeQuitFlushBridge,
  buildLifecycleApi,
  buildOnLifecycleLog,
  type LifecycleApi,
  type OnLifecycleLog,
} from './preload/lifecycle'
import {
  buildAiApi,
  buildOutputApi,
  type AiApi,
  type OutputApi,
} from './preload/ai'
import { buildAgentsApi, type AgentsApi } from './preload/agents'
import { buildOrchestrationApi, type OrchestrationApi } from './preload/orchestration'
import { buildBundleApi, type BundleApi } from './preload/bundle'
import {
  buildMemoryApi,
  buildContextApi,
  buildSessionApi,
  buildConversationApi,
  buildTelemetryApi,
  type MemoryApi,
  type ContextApi,
  type SessionApi,
  type ConversationApi,
  type TelemetryApi,
} from './preload/conversations'
import { buildDiffTxApi, type DiffTxApi } from './preload/diffTx'
import {
  buildAttachmentsApi,
  buildEmbeddingApi,
  buildVectorApi,
  buildWorkspaceIndexApi,
  type AttachmentsApi,
  type EmbeddingApi,
  type VectorApi,
  type WorkspaceIndexApi,
} from './preload/embedding'
import {
  buildFsApi,
  buildGitApi,
  buildTasksApi,
  buildTerminalApi,
  buildWorkspaceTrustApi,
  type FsApi,
  type GitApi,
  type TasksApi,
  type TerminalApi,
  type WorkspaceTrustApi,
} from './preload/workspace'
import {
  buildDiagnosticsApi,
  buildLspApi,
  type DiagnosticsApi,
  type LspApi,
} from './preload/lsp'
import { buildMcpApi, type McpApi } from './preload/mcp'
import { buildPlanningApi, type PlanningApi } from './preload/planning'
import { buildSettingsApi, type SettingsApi } from './preload/settings'
import { buildH5Api, type H5Api } from './preload/h5'
import { buildImApi, type ImApi } from './preload/im'
import {
  buildHooksApi,
  buildPluginApi,
  buildSkillsApi,
  buildToolsApi,
  type HooksApi,
  type PluginApi,
  type SkillsApi,
  type ToolsApi,
} from './preload/tools'
import {
  buildBuddyApi,
  buildClipboardApi,
  buildDebugSessionLog,
  buildRendererPrefsApi,
  buildSystemApi,
  buildTabAutocompleteApi,
  buildWindowApi,
  type BuddyApi,
  type ClipboardApi,
  type DebugSessionLog,
  type RendererPrefsApi,
  type SystemApi,
  type TabAutocompleteApi,
  type WindowApi,
} from './preload/system'

installBeforeQuitFlushBridge()

export interface ElectronAPI {
  platform: string
  clipboard?: ClipboardApi
  /** Writes NDJSON to repo-root debug-e88e1a.log via main process. */
  debugSessionLog: DebugSessionLog
  ai: AiApi
  /**
   * Generic output channel broadcast hook. Consumers can listen for
   * `output:append` events (channelId/message/type) which are then routed
   * into the renderer "Output" panel. Currently unused but wired so
   * TerminalPanel's subscription never hits `undefined`.
   */
  output: OutputApi
  plugin: PluginApi
  settings: SettingsApi
  /** H5 / remote-access (LAN / reverse-proxy) server control. See `electron/h5/`. */
  h5: H5Api
  /** IM adapter config (WeChat credentials + pairing) in `~/.claude/adapters.json`. */
  im: ImApi
  fs: FsApi
  tasks: TasksApi
  window: WindowApi
  terminal: TerminalApi
  tools: ToolsApi
  mcp: McpApi
  /**
   * Active-plan status (counts + plan file path) so the chat header can
   * render the `计划 N/M` indicator. `null` when no plan is active.
   */
  planning: PlanningApi
  memory: MemoryApi
  context: ContextApi
  session: SessionApi
  conversation: ConversationApi
  /**
   * Personal-workspace Bundle system (see plan §4.5.10). Renderer uses
   * this to list / switch / reload bundles and subscribe to activation
   * broadcasts from main. Safe to call before main has finished
   * bootstrap — handlers return empty lists until the registry is ready.
   */
  bundle: BundleApi
  skills: SkillsApi
  tabAutocomplete: TabAutocompleteApi
  hooks: HooksApi
  lsp: LspApi
  workspaceTrust: WorkspaceTrustApi
  git: GitApi
  buddy: BuddyApi
  agents: AgentsApi
  /**
   * Stage 2.3 — OrchestrationKernel checkpoint + persistence control surface.
   * Pause/resume of the kernel itself lives on {@link agents} (keyed on
   * agentId) because the renderer's "stop button" already has the agentId;
   * the checkpoint API operates on `conversationId` because the kernel
   * registry is keyed on it.
   */
  orchestration: OrchestrationApi
  system: SystemApi
  onLifecycleLog: OnLifecycleLog
  lifecycle: LifecycleApi
  rendererPrefs: RendererPrefsApi
  diagnostics: DiagnosticsApi
  attachments: AttachmentsApi
  embedding: EmbeddingApi
  vector: VectorApi
  workspaceIndex: WorkspaceIndexApi
  diffTx: DiffTxApi
  /**
   * Telemetry ring buffer (context events + provider errors). Renderer never
   * writes — only reads for Settings / debug panels and bug-report export.
   * See `electron/telemetry/handlers.ts` for the full event schema.
   */
  telemetry: TelemetryApi
}

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  clipboard: buildClipboardApi(),
  debugSessionLog: buildDebugSessionLog(),
  onLifecycleLog: buildOnLifecycleLog(),
  lifecycle: buildLifecycleApi(),
  rendererPrefs: buildRendererPrefsApi(),
  ai: buildAiApi(),
  output: buildOutputApi(),
  plugin: buildPluginApi(),
  settings: buildSettingsApi(),
  h5: buildH5Api(),
  im: buildImApi(),
  fs: buildFsApi(),
  tasks: buildTasksApi(),
  window: buildWindowApi(),
  terminal: buildTerminalApi(),
  tools: buildToolsApi(),
  mcp: buildMcpApi(),
  planning: buildPlanningApi(),
  memory: buildMemoryApi(),
  context: buildContextApi(),
  session: buildSessionApi(),
  conversation: buildConversationApi(),
  bundle: buildBundleApi(),
  skills: buildSkillsApi(),
  tabAutocomplete: buildTabAutocompleteApi(),
  hooks: buildHooksApi(),
  lsp: buildLspApi(),
  workspaceTrust: buildWorkspaceTrustApi(),
  git: buildGitApi(),
  buddy: buildBuddyApi(),
  agents: buildAgentsApi(),
  orchestration: buildOrchestrationApi(),
  system: buildSystemApi(),
  diagnostics: buildDiagnosticsApi(),
  attachments: buildAttachmentsApi(),
  embedding: buildEmbeddingApi(),
  vector: buildVectorApi(),
  workspaceIndex: buildWorkspaceIndexApi(),
  diffTx: buildDiffTxApi(),
  telemetry: buildTelemetryApi(),
} satisfies ElectronAPI)
