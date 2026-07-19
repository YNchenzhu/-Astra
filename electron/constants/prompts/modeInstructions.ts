/**
 * 模式指令文本
 *
 * 不同输出模式的指令文本。
 */

import {
  OUTPUT_STYLE_CONFIG,
  type OutputStyleName,
} from "../outputStyles";

export { OUTPUT_STYLE_CONFIG };
export type { OutputStyleName };

/**
 * 获取响应风格指令
 */
export function getResponseStyleInstruction(
  outputStyle: "default" | "concise" | "explanatory",
  language: string,
): string {
  const responseStyleInstruction =
    outputStyle === "concise"
      ? "Prefer concise responses: keep outputs short, direct, and action-focused."
      : outputStyle === "explanatory"
        ? "Prefer explanatory responses: include brief rationale and key implementation details when helpful."
        : "Use a balanced response style: direct by default, with concise explanations where needed.";

  const languageInstruction = language.trim()
    ? `Respond in ${language.trim()} unless code or technical identifiers require another language.`
    : "Respond in the user's language preference from the conversation context.";

  return `# Response preferences
- ${responseStyleInstruction}
- ${languageInstruction}`;
}
