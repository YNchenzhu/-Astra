import type { SystemPromptSection } from './types'

/**
 * Recalled facts from the persistent memory store. Rendered inside
 * `<project-memory>` so the model treats it as "long-lived project
 * notes / prior decisions", distinct from the tutorial-grade
 * `<memory-capabilities>`.
 */
export const projectMemorySection: SystemPromptSection = {
  id: 'project-memory',
  owner: 'memory',
  layer: 'user-meta',
  build: ({ options }) => {
    const mem = (options.memoryContext ?? '').trim()
    if (!mem) return ''
    return `# Project Memory
<project-memory>
${mem}
</project-memory>`
  },
}
