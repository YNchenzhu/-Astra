/**
 * 系统提示词段管理常量
 *
 * 定义系统提示词段的缓存 key 和段名称。
 * 不涉及实际计算逻辑，仅提供段标识符常量。
 */

/** 系统提示词动态边界标记 */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";

/** 系统提示词段名称常量 */
export const SECTION_NAMES = {
  /** 介绍段（含安全指令） */
  INTRO: "intro",
  /** 系统规则段 */
  SYSTEM_RULES: "system_rules",
  /** 任务执行指南 */
  DOING_TASKS: "doing_tasks",
  /** 谨慎执行操作 */
  ACTIONS: "actions",
  /** 工具使用指南 */
  USING_TOOLS: "using_tools",
  /** 语气和风格 */
  TONE_AND_STYLE: "tone_and_style",
  /** 输出效率 */
  OUTPUT_EFFICIENCY: "output_efficiency",
  /** 会话指导 */
  SESSION_GUIDANCE: "session_guidance",
  /** 记忆系统 */
  MEMORY: "memory",
  /** 模型覆盖 */
  MODEL_OVERRIDE: "model_override",
  /** 环境信息 */
  ENV_INFO: "env_info",
  /** 语言 */
  LANGUAGE: "language",
  /** MCP 指令 */
  MCP_INSTRUCTIONS: "mcp_instructions",
  /** Scratchpad 说明 */
  SCRATCHPAD: "scratchpad",
  /** 函数结果清除 */
  FUNCTION_RESULT_CLEARING: "function_result_clearing",
  /** 工具结果摘要 */
  SUMMARIZE_TOOL_RESULTS: "summarize_tool_results",
  /** Token 预算 */
  TOKEN_BUDGET: "token_budget",
  /** Brief 段 */
  BRIEF: "brief",
  /** 数字长度锚点 */
  NUMERIC_LENGTH_ANCHORS: "numeric_length_anchors",
  /** 验证代理 */
  VERIFICATION_AGENT: "verification_agent",
  /** 技能发现 */
  SKILL_DISCOVERY: "skill_discovery",
} as const;

export type SectionName = (typeof SECTION_NAMES)[keyof typeof SECTION_NAMES];
