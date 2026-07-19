/**
 * 常量系统 barrel export
 *
 * 依赖-free 以防止循环导入。
 * 所有常量模块必须保持无外部业务逻辑依赖。
 */

export {
  E_TOOL_USE_SUMMARY_GENERATION_FAILED,
  E_CONTEXT_COMPACT_FAILED,
  E_STREAM_TIMEOUT,
  E_RATE_LIMIT_EXCEEDED,
  E_PROVIDER_SERVER_ERROR,
  E_CONTEXT_LENGTH_EXCEEDED,
  E_AGENT_TIMEOUT,
  E_AGENT_TOKEN_BUDGET_EXCEEDED,
  E_AGENT_MAX_CONCURRENT_REACHED,
  E_TOOL_EXECUTION_FAILED,
  E_TOOL_RESULT_TOO_LARGE,
  E_TOOL_PARALLEL_LIMIT_REACHED,
  E_FILE_READ_BLOCKED,
  E_FILE_WRITE_BLOCKED,
  E_BINARY_FILE_NOT_SUPPORTED,
} from "./errorIds";

export { NO_CONTENT_MESSAGE, EMPTY_TOOL_RESULT_MESSAGE } from "./messages";

export { SPINNER_VERBS, getSpinnerVerbs } from "./spinnerVerbs";
export type { SpinnerVerb } from "./spinnerVerbs";

export { TURN_COMPLETION_VERBS } from "./turnCompletionVerbs";
export type { TurnCompletionVerb } from "./turnCompletionVerbs";

export * from "./xml";

export {
  DEFAULT_OUTPUT_STYLE_NAME,
  OUTPUT_STYLE_CONFIG,
  getAllOutputStyles,
  getOutputStyleConfig,
  hasCustomOutputStyle,
} from "./outputStyles";
export type { OutputStyleConfig, OutputStyleName } from "./outputStyles";

export { CYBER_RISK_INSTRUCTION } from "./cyberRiskInstruction";

export * from "./apiLimits";

export * from "./files";

export * from "./toolLimits";

export * from "./betas";

export * from "./common";

export * from "./tools";

export * from "./systemPromptSections";

export * from "./prompts";
