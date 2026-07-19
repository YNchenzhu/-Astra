/**
 * upstream 报告 §8.9 — 插件 / MCP / LSP / 市场错误码（常量 + 文案）。
 */

export const PluginMcpErrorCodes = {
  PATH_NOT_FOUND: 'path-not-found',
  GIT_AUTH_FAILED: 'git-auth-failed',
  GIT_TIMEOUT: 'git-timeout',
  NETWORK_ERROR: 'network-error',
  MANIFEST_PARSE_ERROR: 'manifest-parse-error',
  MANIFEST_VALIDATION_ERROR: 'manifest-validation-error',
  PLUGIN_NOT_FOUND: 'plugin-not-found',
  MARKETPLACE_NOT_FOUND: 'marketplace-not-found',
  MARKETPLACE_LOAD_FAILED: 'marketplace-load-failed',
  MCP_CONFIG_INVALID: 'mcp-config-invalid',
  MCP_SERVER_SUPPRESSED_DUPLICATE: 'mcp-server-suppressed-duplicate',
  LSP_CONFIG_INVALID: 'lsp-config-invalid',
  LSP_SERVER_START_FAILED: 'lsp-server-start-failed',
  LSP_SERVER_CRASHED: 'lsp-server-crashed',
  LSP_REQUEST_TIMEOUT: 'lsp-request-timeout',
  LSP_REQUEST_FAILED: 'lsp-request-failed',
  HOOK_LOAD_FAILED: 'hook-load-failed',
  COMPONENT_LOAD_FAILED: 'component-load-failed',
  MCPB_DOWNLOAD_FAILED: 'mcpb-download-failed',
  MCPB_EXTRACT_FAILED: 'mcpb-extract-failed',
  MCPB_INVALID_MANIFEST: 'mcpb-invalid-manifest',
  MARKETPLACE_BLOCKED_BY_POLICY: 'marketplace-blocked-by-policy',
  DEPENDENCY_UNSATISFIED: 'dependency-unsatisfied',
  PLUGIN_CACHE_MISS: 'plugin-cache-miss',
  GENERIC_ERROR: 'generic-error',
} as const

export type PluginMcpErrorCode = (typeof PluginMcpErrorCodes)[keyof typeof PluginMcpErrorCodes]

const MESSAGES: Record<PluginMcpErrorCode, string> = {
  [PluginMcpErrorCodes.PATH_NOT_FOUND]: '路径不存在或不可读。',
  [PluginMcpErrorCodes.GIT_AUTH_FAILED]: 'Git 认证失败。',
  [PluginMcpErrorCodes.GIT_TIMEOUT]: 'Git 操作超时。',
  [PluginMcpErrorCodes.NETWORK_ERROR]: '网络错误。',
  [PluginMcpErrorCodes.MANIFEST_PARSE_ERROR]: '清单 JSON 解析失败。',
  [PluginMcpErrorCodes.MANIFEST_VALIDATION_ERROR]: '清单字段不符合预期。',
  [PluginMcpErrorCodes.PLUGIN_NOT_FOUND]: '未找到插件。',
  [PluginMcpErrorCodes.MARKETPLACE_NOT_FOUND]: '未找到市场源。',
  [PluginMcpErrorCodes.MARKETPLACE_LOAD_FAILED]: '市场索引加载失败。',
  [PluginMcpErrorCodes.MCP_CONFIG_INVALID]: 'MCP 服务器配置无效。',
  [PluginMcpErrorCodes.MCP_SERVER_SUPPRESSED_DUPLICATE]: '已忽略重复的 MCP 服务器定义。',
  [PluginMcpErrorCodes.LSP_CONFIG_INVALID]: 'LSP 配置无效。',
  [PluginMcpErrorCodes.LSP_SERVER_START_FAILED]: 'LSP 服务器启动失败。',
  [PluginMcpErrorCodes.LSP_SERVER_CRASHED]: 'LSP 服务器崩溃。',
  [PluginMcpErrorCodes.LSP_REQUEST_TIMEOUT]: 'LSP 请求超时。',
  [PluginMcpErrorCodes.LSP_REQUEST_FAILED]: 'LSP 请求失败。',
  [PluginMcpErrorCodes.HOOK_LOAD_FAILED]: 'Hook 加载失败。',
  [PluginMcpErrorCodes.COMPONENT_LOAD_FAILED]: '组件加载失败。',
  [PluginMcpErrorCodes.MCPB_DOWNLOAD_FAILED]: 'MCP Bundle 下载失败。',
  [PluginMcpErrorCodes.MCPB_EXTRACT_FAILED]: 'MCP Bundle 解压失败。',
  [PluginMcpErrorCodes.MCPB_INVALID_MANIFEST]: 'MCP Bundle 内 manifest 无效。',
  [PluginMcpErrorCodes.MARKETPLACE_BLOCKED_BY_POLICY]: '市场源被策略禁止。',
  [PluginMcpErrorCodes.DEPENDENCY_UNSATISFIED]: '插件依赖未满足。',
  [PluginMcpErrorCodes.PLUGIN_CACHE_MISS]: '插件缓存未命中。',
  [PluginMcpErrorCodes.GENERIC_ERROR]: '未知错误。',
}

export function describePluginMcpError(code: PluginMcpErrorCode, detail?: string): string {
  const base = MESSAGES[code] ?? MESSAGES[PluginMcpErrorCodes.GENERIC_ERROR]
  return detail ? `${base} ${detail}` : base
}

export const PLUGIN_MCP_ERROR_CODE_COUNT = Object.keys(PluginMcpErrorCodes).length
