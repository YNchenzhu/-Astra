/**
 * 工具结果和编排限制
 *
 * 定义工具结果大小限制、并行调用数、token 估算等。
 * 合并了原有的 toolOrchestrationConstants.ts。
 */

// 工具结果大小限制
/** 工具结果超过此字符数时持久化到磁盘 */
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000;

/** 溢出到磁盘后，内联预览保留的字符数（见 `toolResultBudget`） */
export const TOOL_RESULT_SPILL_PREVIEW_CHARS = 8_000;

/** 单个工具结果最大 token 数 (约 400KB 文本) */
export const MAX_TOOL_RESULT_TOKENS = 100_000;

/** 每 token 字节数估算 */
export const BYTES_PER_TOKEN = 4;

/** 工具结果最大字节数 */
export const MAX_TOOL_RESULT_BYTES = MAX_TOOL_RESULT_TOKENS * BYTES_PER_TOKEN;

/** 单条消息中所有工具结果的总字符数限制 */
export const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000;

/**
 * Skill 指令块（`<skill-instructions>` 信封）的单块上限。
 *
 * Skill 块是 ACTIVE 工作流指令，不是普通数据：用全局 50k 的单块上限去裁它，
 * 会在第一轮之后把 SKILL.md 的尾部步骤物理删除（skill-adherence 审计 2026-06）。
 * 这里把它对齐到 Skill 工具自身的 inline 上限（`skillTool.ts` 的
 * `maxResultChars`），让 50k–120k 的大 skill 在历史里也能整段保留——
 * 二者共享同一来源，避免再次漂移。
 */
export const SKILL_INSTRUCTIONS_BLOCK_CAP_CHARS = 120_000;

/** 紧凑视图中工具摘要最大长度 */
export const TOOL_SUMMARY_MAX_LENGTH = 50;

// 并行调用限制
/** 单次批量工具调用的最大并行数 */
export const MAX_PARALLEL_TOOL_CALLS = 10;

/** Agent 场景下的最大并行工具调用数（子代理更重） */
export const MAX_PARALLEL_AGENT_TOOL_CALLS = 6;

// Agentic 循环限制
/** 单次 agentic loop 最大迭代次数（主会话未覆盖 maxIterationsOverride 时的默认） */
export const MAX_ITERATIONS = 1000;

// 子代理限制
/** 子代理输出文本缓冲上限 */
export const MAX_SUB_AGENT_TEXT_BUFFER = 120_000;

/**
 * Hard cap on nested agent spawn depth.
 *
 * The main chat is depth 0; a sub-agent it spawns runs at depth 1, a
 * sub-sub-agent at depth 2, and so on. When a new spawn would exceed
 * this value the spawn fails fast with an error (see agent spawn entry
 * points in electron/agents/*). Without a hard cap, nothing structurally
 * prevents runaway recursion — historically only prompt wording and the
 * concurrent-agent cap kept it in check.
 *
 * Overridable via `POLE_MAX_AGENT_DEPTH` at process launch for research.
 */
export const MAX_AGENT_DEPTH: number = (() => {
  const raw = process.env?.POLE_MAX_AGENT_DEPTH
  const n = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n > 0 && n <= 32 ? n : 4
})()
