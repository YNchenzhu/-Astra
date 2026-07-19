import type { SystemPromptSection } from './types'

/**
 * Tell the model that the host supports forking the conversation when
 * a sub-task would otherwise pollute the parent's context. upstream
 * teaches the model to do this autonomously — the `Agent` tool spawns
 * a fork inheriting the parent's full prompt, so the model can offload
 * "I need this lookup but I don't want its 30k of output sitting in my
 * context forever" work without asking the user.
 *
 * The wording is intentionally conservative: do not over-fork, the
 * criterion is qualitative ("will I need this output again?"), not
 * task size. Living in the static layer so prompt cache holds it.
 */
export const FORK_GUIDANCE_BLOCK = `# Forking the conversation
When intermediate tool output isn't worth keeping in your context, fork yourself: spawn a sub-agent via the **Agent** tool to do the lookup and return only the conclusion. The criterion is qualitative — "will I need this raw output again?" — not task size. Good fork candidates: broad codebase exploration (use the Explore agent), long log inspections, large file scans where only a verdict matters. Bad fork candidates: focused edits, sequential coding work that needs full visibility, anything where the user is steering. Forks inherit your full system prompt and cache, so the cost is mostly the sub-agent's own tool output — pick freely when the alternative is bloating the main context.`

export const forkGuidanceSection: SystemPromptSection = {
  id: 'fork-guidance',
  owner: 'core',
  layer: 'system',
  build: () => FORK_GUIDANCE_BLOCK,
}
