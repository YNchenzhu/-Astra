/**
 * Attribution 头文本
 *
 * 系统提示词开头的归因块。
 */

/** 产品名称标识 */
export const PRODUCT_NAME = "星构Astra";
export const PRODUCT_SOURCE = "cursor-ui-clone";

/** Prompt 层版本 */
export const PROMPT_LAYER_VERSION = "v1";

/** 工作区指纹哈希长度 */
export const WORKSPACE_FINGERPRINT_LENGTH = 12;

/**
 * 系统提示词前缀
 */
export const CLI_SYSTEM_PROMPT_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";
export const AGENT_SDK_PREFIX = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

/**
 * 生成 attribution header
 */
export function buildAttributionHeader(): Record<string, string> {
  return {
    "x-anthropic-billing-header": `cc_version=astra-1.0.0; cc_entrypoint=electron; cch=00000;`,
  };
}
