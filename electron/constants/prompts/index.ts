/**
 * Prompts 子模块 barrel export
 */

export {
  PRODUCT_NAME,
  PRODUCT_SOURCE,
  PROMPT_LAYER_VERSION,
  WORKSPACE_FINGERPRINT_LENGTH,
  CLI_SYSTEM_PROMPT_PREFIX,
  AGENT_SDK_PREFIX,
  buildAttributionHeader,
} from "./attribution";

export {
  CYBER_RISK_INSTRUCTION,
  EDIT_FILE_CONTRACT_BLOCK,
} from "./systemDirectives";

export {
  AGENT_TOOL_DESCRIPTION,
  READ_TOOL_DESCRIPTION,
  WRITE_TOOL_DESCRIPTION,
  EDIT_TOOL_DESCRIPTION,
  BASH_TOOL_DESCRIPTION,
  GLOB_TOOL_DESCRIPTION,
  GREP_TOOL_DESCRIPTION,
  WEB_SEARCH_TOOL_DESCRIPTION,
  WEB_FETCH_TOOL_DESCRIPTION,
  TODO_WRITE_TOOL_DESCRIPTION,
} from "./toolDescriptions";

export {
  OUTPUT_STYLE_CONFIG,
  getResponseStyleInstruction,
} from "./modeInstructions";
export type { OutputStyleName } from "./modeInstructions";
