/**
 * 输出风格配置
 *
 * 定义 AI 的不同输出模式行为。
 * 优先级：built-in → user → project
 */

export interface OutputStyleConfig {
  name: string;
  description: string;
  prompt: string;
  source: "built-in" | "user" | "project" | "plugin";
  keepCodingInstructions?: boolean;
  forceForPlugin?: boolean;
}

export type OutputStyleName = "default" | "concise" | "explanatory" | "learning";

export const DEFAULT_OUTPUT_STYLE_NAME: OutputStyleName = "default";

export const OUTPUT_STYLE_CONFIG: Record<OutputStyleName, OutputStyleConfig | null> = {
  default: null,
  explanatory: {
    name: "Explanatory",
    description: "Claude 解释实现选择和代码库模式",
    prompt:
      "When explaining your implementation choices, provide context about why you made certain decisions and how they relate to patterns in the codebase. Include references to existing code when relevant.",
    source: "built-in",
    keepCodingInstructions: true,
  },
  learning: {
    name: "Learning",
    description: "Claude 暂停并要求用户编写代码进行实践学习",
    prompt:
      "When implementing features, pause at key decision points and ask the user to write small pieces of code themselves as a learning exercise. Use TODO(human) markers to indicate where the user should contribute.",
    source: "built-in",
    keepCodingInstructions: true,
  },
  concise: {
    name: "Concise",
    description: "Claude 使用简短直接的回答",
    prompt:
      "Be brief and direct. Skip explanations unless specifically asked. Provide only the code and minimal context needed.",
    source: "built-in",
    keepCodingInstructions: false,
  },
};

export function getAllOutputStyles(): OutputStyleConfig[] {
  return Object.values(OUTPUT_STYLE_CONFIG).filter(
    (style): style is OutputStyleConfig => style !== null,
  );
}

export function getOutputStyleConfig(name: OutputStyleName): OutputStyleConfig | null {
  return OUTPUT_STYLE_CONFIG[name] ?? null;
}

export function hasCustomOutputStyle(name: OutputStyleName): boolean {
  const config = OUTPUT_STYLE_CONFIG[name];
  return config !== null && config.source !== "built-in";
}
