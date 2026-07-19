import type { SystemPromptSection } from './types'

/**
 * `# Memory Capabilities` tutorial block — describes the memory
 * subsystem in narrative form. Streamed only when the caller passes
 * `memoryCapabilities` (the streamHandler gates this to first-turn).
 */
export const memoryCapabilitiesSection: SystemPromptSection = {
  id: 'memory-capabilities',
  owner: 'memory',
  layer: 'user-meta',
  build: ({ options }) => {
    const cap = (options.memoryCapabilities ?? '').trim()
    if (!cap) return ''
    return `# Memory Capabilities
<memory-capabilities>
${cap}
</memory-capabilities>`
  },
}
