/**
 * 系统指令文本片段（仅保留 **当前实际被消费** 的导出）。
 *
 * 历史背景：本文件曾导出十个 `SYSTEM_RULES_TEXT` / `DOING_TASKS_TEXT` /
 * `TONE_STYLE_TEXT` / `OUTPUT_EFFICIENCY_TEXT` 等常量，原意是给 systemPrompt.ts
 * 拼装时复用。但 `renderSystemPromptInstructionSection` 走的是内联模板字符串
 * 路径，从未消费这些常量；它们成为死代码、并跟 systemPrompt.ts 内的同名段落
 * 双源失同步（改一处忘改另一处会让"看上去合理"的常量变成误导信号）。
 *
 * Stage 1·2 整改：删除全部从未被消费的常量，仅保留 `EDIT_FILE_CONTRACT_BLOCK`
 * 和 `CYBER_RISK_INSTRUCTION` re-export — 这两者在 systemPrompt.ts、
 * subagentSystemPrompt.ts、orchestrationContext.ts 中真实使用。
 */

import { CYBER_RISK_INSTRUCTION } from "../cyberRiskInstruction";

export { CYBER_RISK_INSTRUCTION };

/**
 * Injected only when the model's tool surface includes **edit_file** (main chat or sub-agent).
 * Host enforces read/edit gates; this block prevents the most common model-side failures.
 */
export const EDIT_FILE_CONTRACT_BLOCK = `# edit_file / multi_edit_file contract (MANDATORY — host will reject bad calls)
You have **edit_file** and/or **multi_edit_file**. The rules below apply to BOTH tools (every entry in a multi_edit_file batch must individually satisfy 1–4). Treat them as non-negotiable; breaking them produces tool errors, not "soft" hints.

1. **Exact \`old_string\`**: It must be a **literal contiguous substring** of the current file bytes on disk — same spaces, tabs, newlines, comment text, and punctuation. Never abbreviate with \`...\`, ellipses, "…", or placeholders (e.g. \`flex-direction: ...\`). If your snippet is not unique, add more surrounding lines or use \`replace_all\` only when appropriate and after the right read scope.
2. **Complete \`new_string\`**: Must be the **full** replacement text. No placeholders unless those characters should appear literally in the file.
3. **read_file before edit**: Call \`read_file\` on that path in this session **before** any \`edit_file\` / \`multi_edit_file\` call. A **segment** read is OK only if its line window **covers the lines you will change plus roughly ±100 lines** around them. If you use \`replace_all: true\`, or the engine must match via newline normalization, you may need a **full-file** read first — the tool will tell you.
4. **Source of truth**: Copy \`old_string\` from the **latest** \`read_file\` output for that file, not from memory, chat summaries, or truncated UI.
5. **multi_edit_file extra rule**: Edits run in order, and each entry's \`old_string\` must NOT appear as a substring of any earlier entry's \`new_string\` — that pattern is rejected as a chained-clobber bug. Use multi_edit_file for atomic batched refactors (rename across multiple sites in one file); use single \`edit_file\` when you only need one change.
6. **JSON escaping in \`old_string\` / \`new_string\` (LEADING CAUSE of repeated tool failures)**: The tool-call \`arguments\` payload is parsed as **strict JSON**. Inside every string value (including \`old_string\`, \`new_string\`, \`content\`) you MUST escape:
   - every literal ASCII double-quote \`"\` as \`\\"\`
   - every backslash \`\\\` as \`\\\\\`
   - every newline as \`\\n\`, every tab as \`\\t\`, every CR as \`\\r\`
   The host cannot auto-repair this — a missing \`\\\` before \`"\` makes the payload structurally ambiguous (the JSON parser cannot tell whether the \`"\` ends the string or is content) and the entire call is rejected to \`__rawArguments\`. **Curly Chinese quotes \`“ ” ‘ ’\` do NOT need escaping** — only ASCII straight \`"\` does. Examples (model-facing):
   - WRONG (looks fine, but invalid JSON): \`"old_string": "锚定"推动数智化转型"目标"\`
   - RIGHT: \`"old_string": "锚定\\"推动数智化转型\\"目标"\`
   - WRONG (embedded newline): \`"new_string": "first line
second line"\`
   - RIGHT: \`"new_string": "first line\\nsecond line"\`
7. **Split large replacements**: When \`new_string\` would exceed ~2,000 characters, or when a single batch carries more than ~4 edits each with long bodies, **prefer multiple smaller \`edit_file\` calls** over one giant \`multi_edit_file\`. Long heavily-escaped string literals are the most common source of JSON-escape mistakes; small payloads are far less likely to silently corrupt.
8. **Notebook files (.ipynb)**: Use the **NotebookEdit** tool, not \`edit_file\` / \`multi_edit_file\`.`;
