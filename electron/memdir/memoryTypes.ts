/**
 * Memory type taxonomy — adapted from upstream for cursor-ui-clone.
 *
 * Memories are constrained to four types capturing context NOT derivable
 * from the current project state. Code patterns, architecture, git history,
 * and file structure are derivable (via grep/git/CLAUDE.md) and should NOT
 * be saved as memories.
 */

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const

export type MemoryType = (typeof MEMORY_TYPES)[number]

/**
 * Parse a raw frontmatter value into a MemoryType.
 * Invalid or missing values return undefined.
 */
export function parseMemoryType(raw: unknown): MemoryType | undefined {
  if (typeof raw !== 'string') return undefined
  return MEMORY_TYPES.find(t => t === raw)
}

/** Memory frontmatter format example */
export const MEMORY_FRONTMATTER_EXAMPLE: readonly string[] = [
  '```markdown',
  '---',
  'name: {{memory name}}',
  'description: {{one-line description}}',
  `type: {{${MEMORY_TYPES.join(', ')}}}`,
  '---',
  '',
  '{{memory content}}',
  '```',
]

/** Guidance on what NOT to save in memory */
export const WHAT_NOT_TO_SAVE_SECTION: readonly string[] = [
  '## What NOT to save in memory',
  '',
  '- Code patterns, conventions, architecture, file paths, or project structure — these can be derived by reading the current project state.',
  '- Git history, recent changes, or who-changed-what — `git log` / `git blame` are authoritative.',
  '- Debugging solutions or fix recipes — the fix is in the code; the commit message has the context.',
  '- Anything already documented in CLAUDE.md files.',
  '- Ephemeral task details: in-progress work, temporary state, current conversation context.',
  '',
  'These exclusions apply even when the user explicitly asks you to save. If they ask you to save a PR list or activity summary, ask what was *surprising* or *non-obvious* about it — that is the part worth keeping.',
]

/** Recall-side drift caveat for stale memories */
export const MEMORY_DRIFT_CAVEAT =
  '- Memory records can become stale over time. Use memory as context for what was true at a given point in time. Before answering the user or building assumptions based solely on information in memory records, verify that the memory is still correct and up-to-date by reading the current state of the files or resources. If a recalled memory conflicts with current information, trust what you observe now — and update or remove the stale memory rather than acting on it.'

/** When to access memories guidance */
export const WHEN_TO_ACCESS_SECTION: readonly string[] = [
  '## When to access memories',
  '- When memories seem relevant, or the user references prior-conversation work.',
  '- You MUST access memory when the user explicitly asks you to check, recall, or remember.',
  '- If the user says to *ignore* or *not use* memory: proceed as if MEMORY.md were empty. Do not apply remembered facts, cite, compare against, or mention memory content.',
  MEMORY_DRIFT_CAVEAT,
]

/** Trusting recalled memory guidance */
export const TRUSTING_RECALL_SECTION: readonly string[] = [
  '## Before recommending from memory',
  '',
  'A memory that names a specific function, file, or flag is a claim that it existed *when the memory was written*. It may have been renamed, removed, or never merged. Before recommending it:',
  '',
  '- If the memory names a file path: check the file exists.',
  '- If the memory names a function or flag: grep for it.',
  '- If the user is about to act on your recommendation (not just asking about history), verify first.',
  '',
  '"The memory says X exists" is not the same as "X exists now."',
]

/** Types of memory section for individual mode (single directory) */
export const TYPES_SECTION_INDIVIDUAL: readonly string[] = [
  '## Types of memory',
  '',
  'There are several discrete types of memory that you can store in your memory system:',
  '',
  '<types>',
  '<type>',
  '    <name>user</name>',
  "    <description>Contain information about the user's role, goals, responsibilities, and knowledge.</description>",
  "    <when_to_save>When you learn any details about the user's role, preferences, responsibilities, or knowledge</when_to_save>",
  "    <how_to_use>When your work should be informed by the user's profile or perspective.</how_to_use>",
  '</type>',
  '<type>',
  '    <name>feedback</name>',
  '    <description>Guidance the user has given you about how to approach work — both what to avoid and what to keep doing.</description>',
  '    <when_to_save>Any time the user corrects your approach OR confirms a non-obvious approach worked.</when_to_save>',
  '    <how_to_use>Let these memories guide your behavior so that the user does not need to offer the same guidance twice.</how_to_use>',
  '</type>',
  '<type>',
  '    <name>project</name>',
  '    <description>Information about ongoing work, goals, initiatives, bugs, or incidents within the project that is not derivable from the code or git history.</description>',
  '    <when_to_save>When you learn who is doing what, why, or by when.</when_to_save>',
  '    <how_to_use>Use these memories to understand the broader context and motivation behind the work.</how_to_use>',
  '</type>',
  '<type>',
  '    <name>reference</name>',
  '    <description>Stores pointers to where information can be found in external systems.</description>',
  '    <when_to_save>When you learn about resources in external systems and their purpose.</when_to_save>',
  '    <how_to_use>When the user references an external system or information that may be in an external system.</how_to_use>',
  '</type>',
  '</types>',
  '',
]
