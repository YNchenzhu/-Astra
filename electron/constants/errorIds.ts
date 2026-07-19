/**
 * 错误 ID 常量
 *
 * 设计为单独 const 导出以实现最优 dead code elimination。
 * 用于生产环境错误追踪，每个错误有唯一的混淆标识符。
 */

/** 工具使用摘要生成失败 */
export const E_TOOL_USE_SUMMARY_GENERATION_FAILED = 344;

/** 上下文管理相关错误 */
export const E_CONTEXT_COMPACT_FAILED = 345;

/** API 相关错误 */
export const E_STREAM_TIMEOUT = 346;
export const E_RATE_LIMIT_EXCEEDED = 347;
export const E_PROVIDER_SERVER_ERROR = 348;
export const E_CONTEXT_LENGTH_EXCEEDED = 349;

/** Agent 相关错误 */
export const E_AGENT_TIMEOUT = 350;
export const E_AGENT_TOKEN_BUDGET_EXCEEDED = 351;
export const E_AGENT_MAX_CONCURRENT_REACHED = 352;

/** 工具执行相关错误 */
export const E_TOOL_EXECUTION_FAILED = 353;
export const E_TOOL_RESULT_TOO_LARGE = 354;
export const E_TOOL_PARALLEL_LIMIT_REACHED = 355;

/** 文件系统相关错误 */
export const E_FILE_READ_BLOCKED = 356;
export const E_FILE_WRITE_BLOCKED = 357;
export const E_BINARY_FILE_NOT_SUPPORTED = 358;

/** 下一个可用 ID: 359 */
