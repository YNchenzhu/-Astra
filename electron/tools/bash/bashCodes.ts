/**
 * Stable machine-readable codes for tests, logging, and policy.
 * Extended with checks aligned to upstream BashTool-style defenses (regex subset, no tree-sitter).
 */

export type SecurityVerdict = 'allow' | 'warn' | 'deny'

export const BashSecurityCode = {
  STRING_BACKTICK: 'bash.string.backtick_subst',
  STRING_NESTED_SUBST: 'bash.string.nested_command_subst',
  STRING_SENSITIVE_ENV: 'bash.string.sensitive_env_ref',
  STRING_PIPE_TO_SHELL: 'bash.string.pipe_to_shell',
  STRING_EVAL_SOURCE: 'bash.string.eval_or_source_dynamic',
  STRING_LONG_CHAIN: 'bash.string.long_operator_chain',
  DANGEROUS_COMMAND: 'bash.cmd.dangerous_blacklist',
  WARN_CHMOD_777: 'bash.cmd.warn.chmod_777',
  WARN_KILL_SIGKILL: 'bash.cmd.warn.kill_9',
  WARN_GIT_PUSH_FORCE: 'bash.cmd.warn.git_push_force',
  WARN_COMMAND: 'bash.cmd.warn.sensitive_command',
  WARN_RM_RECURSIVE: 'bash.cmd.warn.rm_recursive',
  DENY_DD: 'bash.cmd.deny.dd',
  MULTI_COMMAND_CHAIN: 'bash.chain.multiple_commands',
  /** Dangerous binary reached through a wrapper prefix (`command rm`, `env rm`, `busybox rm`, `sudo rm`, `xargs rm`, …). */
  WRAPPED_DANGEROUS_COMMAND: 'bash.cmd.wrapped_dangerous_blacklist',
  /** `find … -delete` / `find … -exec <dangerous>` — destructive despite `find` being read-only. */
  FIND_DESTRUCTIVE: 'bash.cmd.find_destructive',
  /** Inline interpreter (`python -c` / `node -e` / …) whose payload contains destructive / exec-capable code. */
  INLINE_INTERPRETER_DESTRUCTIVE: 'bash.cmd.inline_interpreter_destructive',
  /** upstream-style: process substitution, zsh-only metasyntax, etc. */
  OC_SHELL_METASYNTAX: 'bash.oc.metasyntax',
  OC_ZSH_DANGEROUS_BUILTIN: 'bash.oc.zsh_dangerous_builtin',
  OC_HEREDOC_IN_SUBST: 'bash.oc.heredoc_in_subst',
  /** Paths like `/`, `$HOME`, drive roots — parity with upstream pathValidation dangerous removal */
  PATH_DANGEROUS_TARGET: 'bash.path.dangerous_removal_target',
  /** sed -i / --in-place — in-place edits should prefer dedicated file tools */
  SED_INPLACE: 'bash.sed.inplace',
  /** jq with system() or similar execution */
  JQ_SYSTEM: 'bash.jq.system',
  /** Informational destructive patterns (git reset --hard, etc.) */
  DESTRUCTIVE_PATTERN_HINT: 'bash.hint.destructive_pattern',

  // --- Cross-platform executability heuristics (orchestration-layer guards) ---
  /** `python3` on Windows — executable is usually `python` or `py`; `python3` commonly ENOENTs. */
  XP_PYTHON3_ON_WINDOWS: 'bash.xp.python3_on_windows',
  /** Unbalanced (odd count of) unescaped double or single quotes — command will fail to parse. */
  XP_UNCLOSED_QUOTE: 'bash.xp.unclosed_quote',
  /** `<cmd> -c "..."` with a literal newline inside the `-c` string — fragile across PowerShell / cmd routing. */
  XP_MULTILINE_DASH_C: 'bash.xp.multiline_dash_c_heredoc_style',
  /**
   * `python3 -c "<multi-line body>"` on Windows — the two failure modes
   * compound: `python3.exe` is usually absent AND the embedded newlines mangle
   * across PowerShell / cmd quoting. Promoted to deny so the model rewrites
   * to `py -3 -c "..."` (single-line) or moves the body into a `.py` file
   * instead of silently exiting 9009 / 49 with empty stderr.
   */
  XP_PYTHON3_DASHC_MULTILINE_ON_WINDOWS: 'bash.xp.python3_dashc_multiline_on_windows',

  // --- PowerShellTool-style (upstream) — regex subset, shared code namespace for registry/errors ---
  PS_INVOKE_EXPRESSION: 'ps.invoke_expression',
  PS_ENCODED_COMMAND: 'ps.encoded_command',
  PS_NESTED_PWSH: 'ps.nested_powershell',
  PS_DOWNLOAD_IEX: 'ps.download_and_execute',
  PS_DOWNLOAD_UTILITY: 'ps.download_utility',
  PS_ADD_TYPE: 'ps.add_type',
  PS_IMPORT_MODULE: 'ps.import_or_install_module',
  PS_WEBCLIENT: 'ps.net_webclient',
  PS_START_PROCESS_ELEVATE: 'ps.start_process_elevate',
  PS_WMI_CIM: 'ps.wmi_cim_invoke',
  PS_DYNAMIC_INVOKE: 'ps.dynamic_invocation',
  PS_EXEC_POLICY_BYPASS: 'ps.executionpolicy_bypass',
  PS_REFLECTION_LOAD: 'ps.reflection_assembly_load',
  PS_COM_SCRIPTING: 'ps.com_scripting',
  /**
   * Second wave (mirrors upstream checkInvokeItem / checkScheduledTask /
   * checkRuntimeStateManipulation / checkStopParsing / checkEnvVarManipulation
   * / checkTypeLiterals / checkScriptBlockInjection). All implemented as
   * regex-only — no PS AST — so they live alongside the existing PS_* codes.
   */
  PS_INVOKE_ITEM: 'ps.invoke_item',
  PS_SCHEDULED_TASK: 'ps.scheduled_task',
  PS_SET_EXEC_POLICY: 'ps.set_executionpolicy',
  PS_STOP_PARSING: 'ps.stop_parsing_token',
  PS_ENV_WRITE: 'ps.env_var_assignment',
  PS_TYPE_LITERAL_INVOKE: 'ps.type_literal_static_invoke',
  PS_INVOKE_COMMAND: 'ps.invoke_command',
} as const

export type BashSecurityCode = (typeof BashSecurityCode)[keyof typeof BashSecurityCode]
