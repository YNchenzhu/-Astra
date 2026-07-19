/**
 * Side-query (分类器 / 摘要 / 标题 / 工具汇总 / 自动补全) 的统一 thinking 策略。
 *
 * 默认禁用 —— 这些短时调用不应该让"内部推理"散到主会话上下文里。
 *
 * 风险链路：
 *   用户开启全局"深度思考" → 摘要 / 分类器 / 工具结果摘要 / 自动补全也开启
 *   thinking → 模型的内部推理混入这些短时调用的输出 → 主线读到摘要时把
 *   "反思 / 假设"当事实 → 幻觉。
 *
 * 对齐 upstream-main `src/utils/sideQuery.ts#resolveSideQueryThinkingConfig`：
 * 那里的 `resolveSideQueryThinkingConfig(undefined, ...)` 在无显式预算时返回
 * `{ type: 'disabled' }`（启用 `CC_HAHA_SEND_DISABLED_THINKING`）或 `undefined`
 * （让 API 用默认值）。工作区简化为一个布尔常量，所有 side-query 调用点统一
 * 传 `alwaysThinking: SIDE_QUERY_ALWAYS_THINKING`。
 *
 * 使用：
 * ```ts
 * import { SIDE_QUERY_ALWAYS_THINKING } from '../ai/sideQueryThinkingPolicy'
 * await streamText(config, { ..., alwaysThinking: SIDE_QUERY_ALWAYS_THINKING }, ...)
 * ```
 */

export const SIDE_QUERY_ALWAYS_THINKING = false as const
