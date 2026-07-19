/**
 * Bash / POSIX shell security and analysis — modular counterpart to upstream `src/tools/BashTool/`
 * (main-process validation only; no React Ink UI).
 */

export type { SecurityVerdict } from './bashCodes'
export { BashSecurityCode } from './bashCodes'
export {
  analyzeCommand,
  countStructuralChainOperators,
  BASH_STYLE_BACKTICK_SUBSTITUTION,
} from './commandAnalysis'
export type { CommandAnalysis } from './commandAnalysis'
export type { ValidateBashCommandOptions, SecurityAnalysis } from './validateBashCommand'
export { validateBashCommand, isCommandReadOnly } from './validateBashCommand'
export {
  classifyBashCommand,
  classifyBashCommandStage1,
  classifyBashCommandStage2,
  matchesDevCommandWhitelist,
} from './bashClassifier'
export { transcriptStyleRiskHeuristic } from './bashClassifierStage2Heuristics'
export type {
  BashClassifierFullResult,
  BashClassifierShellKind,
  BashClassifierStage1Result,
} from './bashClassifier'
export { getDestructiveCommandWarning } from './destructiveHints'
export { isDangerousRemovalPath, expandTildeSimple, extractPositionalArgs } from './pathDanger'
export { ZSH_DANGEROUS_COMMANDS } from './openClaudePatternLayer'
export { BASH_TOOL_NAME } from './toolName'
