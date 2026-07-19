/**
 * XML 标签常量
 *
 * 定义消息中使用的 XML 标签名称，用于 Claude API 消息协议、
 * 终端输出解析、任务通知、跨 Agent 通信等。
 */

// 命令元数据
export const COMMAND_NAME_TAG = "command-name";
export const COMMAND_MESSAGE_TAG = "command-message";
export const COMMAND_ARGS_TAG = "command-args";

// 终端输出
export const BASH_INPUT_TAG = "bash-input";
export const BASH_STDOUT_TAG = "bash-stdout";
export const BASH_STDERR_TAG = "bash-stderr";
export const LOCAL_COMMAND_STDOUT_TAG = "local-command-stdout";
export const LOCAL_COMMAND_STDERR_TAG = "local-command-stderr";
export const LOCAL_COMMAND_CAVEAT_TAG = "local-command-caveat";

export const TERMINAL_OUTPUT_TAGS = [
  BASH_INPUT_TAG,
  BASH_STDOUT_TAG,
  BASH_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_CAVEAT_TAG,
] as const;

// Tick 标签
export const TICK_TAG = "tick";

// 任务通知
export const TASK_NOTIFICATION_TAG = "task-notification";
export const TASK_ID_TAG = "task-id";
export const TOOL_USE_ID_TAG = "tool-use-id";
export const TASK_TYPE_TAG = "task-type";
export const OUTPUT_FILE_TAG = "output-file";
export const STATUS_TAG = "status";
export const SUMMARY_TAG = "summary";
export const REASON_TAG = "reason";

// Worktree
export const WORKTREE_TAG = "worktree";
export const WORKTREE_PATH_TAG = "worktreePath";
export const WORKTREE_BRANCH_TAG = "worktreeBranch";

// 远程会话
export const ULTRAPLAN_TAG = "ultraplan";
export const REMOTE_REVIEW_TAG = "remote-review";
export const REMOTE_REVIEW_PROGRESS_TAG = "remote-review-progress";

// 跨 Agent 通信
export const TEAMMATE_MESSAGE_TAG = "teammate-message";
export const CHANNEL_MESSAGE_TAG = "channel-message";
export const CHANNEL_TAG = "channel";
export const CROSS_SESSION_MESSAGE_TAG = "cross-session-message";

// Fork
export const FORK_BOILERPLATE_TAG = "fork-boilerplate";
export const FORK_DIRECTIVE_PREFIX = "Your directive: ";

// 系统提示/归因
export const SYSTEM_REMINDER_TAG = "system-reminder";

// 项目上下文
export const PROJECT_MEMORY_TAG = "project-memory";
export const SESSION_CONTEXT_TAG = "session-context";
export const LSP_DIAGNOSTICS_TAG = "lsp-passive-diagnostics";
export const ENV_TAG = "env";

// 帮助/信息参数
export const COMMON_HELP_ARGS = ["help", "-h", "--help"] as const;
export const COMMON_INFO_ARGS = [
  "list",
  "show",
  "display",
  "current",
  "view",
  "get",
  "check",
  "describe",
  "print",
  "version",
  "about",
  "status",
  "?",
] as const;
