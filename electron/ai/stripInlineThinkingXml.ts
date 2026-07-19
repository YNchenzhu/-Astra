/**
 * Strip inline `<thinking>` / `<think>` XML before regex-parsing model
 * free-text output.
 *
 * Why this exists:
 *   Some 3P gateways (DeepSeek thinking, Zhipu GLM, certain Anthropic-compat
 *   proxies) encode chain-of-thought as inline XML even when extended-thinking
 *   is disabled at the protocol layer. If a downstream parser regex-matches
 *   raw text (e.g. looking for `<reason>...</reason>` or a filename in a
 *   freeform list), keywords inside the model's reasoning get matched and
 *   poison the result.
 *
 * Example failure mode without this:
 *   The model emits `<thinking>I'm not sure, but maybe yes</thinking>\n<block>no</block>`.
 *   A naive `text.match(/<block>(yes|no)<\/block>/)` would still get "no"
 *   — but a stray `<block>` in the thinking would be matched first. Worse,
 *   models sometimes write `<thinking>The answer is yes</thinking><block>no</block>`
 *   where the keyword "yes" sits inside reasoning we should ignore.
 *
 * Mirrors upstream-main `src/utils/permissions/yoloClassifier.ts:565-572`
 * `stripThinking()` — same 4-regex pattern, extended to also handle the
 * shorter `<think>` tag form DeepSeek-R1 uses.
 *
 * Known limitations:
 *   - Does NOT handle nested `<thinking><thinking>...</thinking></thinking>`
 *     (the non-greedy `*?` matches the inner closing tag first). Models
 *     don't produce nested thinking XML in practice; if they did, the outer
 *     wrapper would just survive minus its inner content — which is still
 *     safer than passing all the reasoning through to the parser.
 *   - Does NOT strip `<thought>...</thought>` (different vendor convention,
 *     not observed in our wire payloads). Add another regex if it appears.
 */

export function stripInlineThinkingXml(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text
  return text
    // Closed `<thinking>...</thinking>` blocks (most common, both 3P thinking
    // gateways and OpenAI o-series-style imitation use this).
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
    // Closed `<think>...</think>` blocks (DeepSeek-R1 / Qwen-QwQ flavour).
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    // Unclosed `<thinking>` tail — happens when stream was cut mid-block
    // (529, timeout, user cancel). Drop everything from the opening tag
    // through end-of-string.
    .replace(/<thinking>[\s\S]*$/, '')
    // Same for unclosed `<think>`.
    .replace(/<think>[\s\S]*$/, '')
}
