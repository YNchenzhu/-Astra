/**
 * 轮次完成动词
 *
 * 过去时态动词，与 "for [duration]" 搭配使用（如 "Worked for 5s"）。
 * 用于流式会话完成时的状态消息显示。
 */

export const TURN_COMPLETION_VERBS = [
  "Baked",
  "Brewed",
  "Churned",
  "Cogitated",
  "Cooked",
  "Crunched",
  "Sauteed",
  "Worked",
] as const;

export type TurnCompletionVerb = (typeof TURN_COMPLETION_VERBS)[number];
