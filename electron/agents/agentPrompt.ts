/**
 * Agent tool prompt generation.
 *
 * Ported from upstream's prompt.ts with simplifications:
 * - Removed fork-related content (added in forkSubagent.ts)
 * - Removed feature flags and GrowthBook checks
 * - Removed tmux/background complexity
 * - Tool names adapted to cursor-ui-clone's registry
 */

import type { AgentDefinition, AgentDefinitionUnion } from './types'
import { FORK_EXAMPLES, FORK_PROMPT_SECTION } from './forkSubagent'
import { normalizeToolsList } from './normalizeToolLists'

function getToolsDescription(agent: AgentDefinition): string {
  const tools = normalizeToolsList(agent.tools)
  const disallowedTools = normalizeToolsList(agent.disallowedTools)
  // P0-3: distinguish "no allowlist configured" (`tools` undefined) from
  // "explicitly empty allowlist" (`tools: []`). The latter must render as
  // 'None', not 'All tools'.
  const hasAllowlist = tools !== undefined && !(tools.length === 1 && tools[0] === '*')
  const hasDenylist = disallowedTools !== undefined && disallowedTools.length > 0

  if (hasAllowlist && hasDenylist) {
    const denySet = new Set(disallowedTools)
    const effectiveTools = tools.filter(t => !denySet.has(t))
    if (effectiveTools.length === 0) return 'None'
    return effectiveTools.join(', ')
  } else if (hasAllowlist) {
    if (tools.length === 0) return 'None'
    return tools.join(', ')
  } else if (hasDenylist) {
    return `All tools except ${disallowedTools.join(', ')}`
  }
  return 'All tools'
}

/**
 * Concatenate an agent's human-facing "what is this for" signal from the
 * available slots. Precedence:
 *   1. `whenToUse`  — upstream's routing sentence; shown first.
 *   2. `capability` — optional "功能是..." slot from the Settings UI form;
 *      appended as a parenthetical so the router sees both the when-to-use
 *      summary AND a concrete capability bullet point.
 *
 * Empty / whitespace-only values are skipped. We keep the full text (no
 * truncation) because this listing is what the main AI uses to decide which
 * agent to spawn — truncating would hide the very signals that help routing.
 */
function formatAgentWhenAndCapability(agent: AgentDefinitionUnion): string {
  const when = typeof agent.whenToUse === 'string' ? agent.whenToUse.trim() : ''
  const cap = typeof (agent as { capability?: string }).capability === 'string'
    ? ((agent as { capability?: string }).capability ?? '').trim()
    : ''
  if (when && cap) return `${when} — ${cap}`
  return when || cap || ''
}

function formatAgentLine(agent: AgentDefinitionUnion): string {
  const toolsDescription = getToolsDescription(agent)
  const intro = formatAgentWhenAndCapability(agent)
  const plug = agent.source === 'plugin' ? ` [plugin:${agent.pluginName}]` : ''
  // Surface read-only / model-override hints the router can condition on
  // without reading the full AgentDefinition. Keeps the line compact but
  // gives the main AI concrete reasons to pick this agent.
  const flags: string[] = []
  if (agent.isReadOnly) flags.push('read-only')
  if (agent.model && agent.model !== 'inherit') flags.push(`model=${agent.model}`)
  if (agent.background) flags.push('background-friendly')
  const flagsSuffix = flags.length > 0 ? ` [${flags.join(', ')}]` : ''
  return `- ${agent.agentType}: ${intro} (Tools: ${toolsDescription})${flagsSuffix}${plug}`
}

/**
 * Generate the Agent tool's description/prompt.
 * This is what the main AI sees when deciding whether to use the Agent tool.
 */
export function getAgentToolPrompt(
  agentDefinitions: AgentDefinitionUnion[],
  isForkEnabled = false
): string {
  const agentListSection = `Available agent types and the tools they have access to:
${agentDefinitions.map(agent => formatAgentLine(agent)).join('\n')}`

  const shared = `Launch a new agent to handle complex, multi-step tasks autonomously.

The Agent tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

${agentListSection}

When using the Agent tool, specify a subagent_type parameter to select which agent type to use.${
    isForkEnabled
      ? ' If you **omit** subagent_type, you **fork** yourself: a general-purpose agent inherits your full conversation context (shared prompt prefix / cache-friendly).'
      : ' If omitted, the general-purpose agent is used without inheriting parent messages.'
  }`

  const whenNotToUseSection = `
When NOT to use the Agent tool:
- If you already know the exact file path, use **Read** (or **Edit** after reading) — do not spawn an agent to open one file.
- If you need one symbol or string across the repo, use **Grep** / **Glob** first; only delegate when the search space is huge or needs multi-step judgment.
- If the task fits in 2–3 tool calls on known paths, stay on the main thread — nested agents add latency and hide raw output from the user until you summarize.
- If you are searching for a specific class definition like "class Foo", prefer **Glob** + **Read** rather than Agent, unless exploration must span many directories autonomously.
- Other tasks that are not related to the agent descriptions above
`

  const usageNotes = `
Usage notes:
- Always include a short description (3-5 words) summarizing what the agent will do
- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses
- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.
- **TaskOutput vs ids**: The Agent result JSON includes \`taskOutputTaskId\` — use that as TaskOutput's \`task_id\` to read the parent tool's runtime stream. \`agentId\` is for **SendMessage** / team routing; it is also accepted as TaskOutput \`task_id\`, but \`taskOutputTaskId\` is the canonical key when both appear.
- **Background agents auto-deliver. Don't peek, don't race.** When you set \`run_in_background: true\`, the runtime pushes the sub-agent's new output (delta + terminal status notice — \`completed\` / \`failed\` / \`stopped\`) into your context on the **next user turn** as a \`<system-reminder>\` block. You do **not** call TaskOutput, sleep, or wait to learn whether the sub-agent finished. The user is also seeing a live UI sub-agent card the whole time, so even when you can't see progress, they can.
  - **End your turn after launching.** Briefly tell the user what you launched, then stop. Don't loop on TaskOutput. Don't restart the sub-agent because the spawn JSON read \`Status: running\` — that JSON is a receipt, not a deliverable. The post-spawn \`{status: "running", agentId, taskOutputTaskId}\` is acknowledgement of dispatch, nothing more.
  - **Never fabricate or predict** sub-agent results. If the user follows up before the delta arrives, give status ("still running") not a guess. The synthetic-context-block delivery is the authoritative signal.
  - **TaskOutput is a fallback, not the default polling channel.** Reach for it only when (a) the **user explicitly asks** to see the in-flight transcript of a sub-agent, (b) the runtime task is **not** a sub-agent (Bash, etc.) and you genuinely need its stdout/stderr now, or (c) you need to re-read a completed task's buffer for paginated detail. The \`taskOutputTaskId\` field on the Agent result JSON is the handle for those rare cases; \`agentId\` is the routing handle for SendMessage / team operations.
  - For structured team mailboxes / broadcast queues, **TeamStatus** after **SendMessage** is the right tool — that is a roster/mailbox lookup, not a sub-agent progress check.
- **Foreground vs background**: Use foreground (default) when you need the agent's results before you can proceed — e.g., research agents whose findings inform your next steps. Use background when you have genuinely independent work to do in parallel.
- To continue a previously spawned agent, use SendMessage with the agent's ID or name as the \`to\` field. The agent resumes with its full context preserved. Each Agent invocation starts fresh — provide a complete task description.
- **SendMessage \`to\`**: Use only values that match the tool schema — running sub-agent IDs/names, \`*\`, \`team:<name>\`, \`mailbox:<id|name>\` (durable mailbox + queue if running), or \`bridge:<id|name>\` (in-process). Do not invent labels (e.g. role nicknames). When unsure who is alive, use **TeamStatus** or \`*\` (broadcast) if appropriate.
- The agent's outputs should generally be trusted
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent
- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.
- If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple Agent tool use content blocks. For example, if you need to launch both a build-validator agent and a test-runner agent in parallel, send a single message with both tool calls.
`

  const writingPromptSection = `
## Writing the prompt

Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.
- **Structured handoff (strongly recommended for Explore / Plan):** Include (1) **Goal** — one sentence; (2) **Done when** — verifiable criteria (e.g. "list entrypoints + call flow for X"); (3) **Scope** — repo paths or dirs to focus or avoid; (4) **Thoroughness** — quick | medium | very thorough; (5) **Tool hint** — e.g. "prefer Grep/Glob/Read over Bash". Vague goals cause runaway tool loops.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.
`

  const examples = `
Example usage:

<example_agent_descriptions>
"test-runner": use this agent after you are done writing code to run tests
"greeting-responder": do not use agents for greetings; answer directly instead
</example_agent_descriptions>

<example>
user: "Create a new file prime.ts with a function that checks if a number is prime"
assistant: I'm going to use the write_file tool for this new file:
<code>
function isPrime(n) {
  if (n <= 1) return false
  for (let i = 2; i * i <= n; i++) {
    if (n % i === 0) return false
  }
  return true
}
</code>
<commentary>
Since a significant piece of code was written and the task was completed, now use the test-runner agent to run the tests
</commentary>
assistant: Uses the Agent tool to launch the test-runner agent
</example>

<example>
user: "Hello"
<commentary>
The user is only greeting. Respond directly in normal assistant text. Do not call Agent or any workspace tool.
</commentary>
assistant: "Hello! How can I help?"
</example>
`

  const forkBlock = isForkEnabled ? `${FORK_PROMPT_SECTION}${FORK_EXAMPLES}` : ''

  return `${shared}
${whenNotToUseSection}
${usageNotes}
${writingPromptSection}

${examples}${forkBlock}`
}
