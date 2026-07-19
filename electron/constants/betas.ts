/**
 * Anthropic API Beta Header 常量
 *
 * 定义所有 API Beta 功能的请求头标识符。
 * 作为 anthropicBetaHeaderLatch.ts 的常量源。
 */

/** upstream 基础 Beta */
export const CLAUDE_CODE_20250219_BETA_HEADER = "claude-code-20250219";

/** 交错思考 Beta */
export const INTERLEAVED_THINKING_BETA_HEADER = "interleaved-thinking-2025-05-14";

/** 1M 上下文 Beta */
export const CONTEXT_1M_BETA_HEADER = "context-1m-2025-08-07";

/** 上下文管理 Beta */
export const CONTEXT_MANAGEMENT_BETA_HEADER = "context-management-2025-06-27";

/** 结构化输出 Beta */
export const STRUCTURED_OUTPUTS_BETA_HEADER = "structured-outputs-2025-12-15";

/** 网络搜索 Beta */
export const WEB_SEARCH_BETA_HEADER = "web-search-2025-03-05";

/** 工具搜索 Beta（第一方 API: Claude API/Foundry） */
export const TOOL_SEARCH_BETA_HEADER_1P = "advanced-tool-use-2025-11-20";

/** 工具搜索 Beta（第三方 API: Vertex AI/Bedrock） */
export const TOOL_SEARCH_BETA_HEADER_3P = "tool-search-tool-2025-10-19";

/** 输出努力 Beta */
export const EFFORT_BETA_HEADER = "effort-2025-11-24";

/** 任务预算 Beta */
export const TASK_BUDGETS_BETA_HEADER = "task-budgets-2026-03-13";

/** Prompt 缓存范围 Beta */
export const PROMPT_CACHING_SCOPE_BETA_HEADER = "prompt-caching-scope-2026-01-05";

/** Fast Mode Beta */
export const FAST_MODE_BETA_HEADER = "fast-mode-2026-02-01";

/** 审查思考 Beta */
export const REDACT_THINKING_BETA_HEADER = "redact-thinking-2026-02-12";

/** Token 高效工具 Beta */
export const TOKEN_EFFICIENT_TOOLS_BETA_HEADER = "token-efficient-tools-2026-03-28";

/** 顾问工具 Beta */
export const ADVISOR_BETA_HEADER = "advisor-tool-2026-03-01";

/** Bedrock 额外参数允许的 Beta 集合 */
export const BEDROCK_EXTRA_PARAMS_HEADERS = new Set([
  INTERLEAVED_THINKING_BETA_HEADER,
  CONTEXT_1M_BETA_HEADER,
  TOOL_SEARCH_BETA_HEADER_3P,
]);

/** Vertex countTokens API 允许的 Beta 列表 */
export const VERTEX_COUNT_TOKENS_ALLOWED_BETAS = new Set([
  CLAUDE_CODE_20250219_BETA_HEADER,
  INTERLEAVED_THINKING_BETA_HEADER,
  CONTEXT_MANAGEMENT_BETA_HEADER,
]);
