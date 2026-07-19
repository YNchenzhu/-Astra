import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSystemPromptLayers } from './systemPrompt'

const repoRoot = path.resolve(__dirname, '..', '..')

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8')
}

describe('prompt injection budget guards', () => {
  it('does not include the compact skill index in reusable prompt layers', () => {
    const layers = buildSystemPromptLayers({
      cwd: '/tmp/ws',
      platform: 'linux',
      outputStyle: 'default',
      language: 'en',
      memoryContext: '',
      memoryCapabilities: 'memory tutorial',
      sessionContext: '',
      lspPassiveDiagnosticsContext: '',
      includeEditFileContract: true,
    })

    expect(layers.systemContext).not.toContain('# Skill index (compact)')
    expect(layers.userContext).not.toContain('# Skill index (compact)')
    expect(layers.userMessageContext).not.toContain('# Skill index (compact)')
  })

  it('gates skill index and memory-capabilities to the first conversation turn in streamHandler', () => {
    const src = readRepoFile('electron/ai/streamHandler.ts')
    expect(src).toContain('const isFirstConversationTurn = !messages')
    expect(src).toMatch(/isFirstConversationTurn[\s\S]{0,140}getMemorySystemPromptSection\(true\)/u)
    expect(src).toMatch(/const firstTurnSkillIndex = isFirstConversationTurn[\s\S]{0,120}getCompactSkillIndexPrompt\(\)\.trim\(\)/u)
  })

  it('keeps automatic skill discovery prefetch disabled unless explicitly enabled', () => {
    const src = readRepoFile('electron/ai/agenticLoop/preModel.ts')
    expect(src).toContain('POLE_SKILL_DISCOVERY_PREFETCH')
    expect(src).toMatch(/return raw === '1' \|\| raw === 'true' \|\| raw === 'yes'/u)
    expect(src).toMatch(/if \(isSkillDiscoveryPrefetchEnabled\(\) && isIterationOne/u)
  })

  it('keeps sub-agent prompt construction free of skill index and memory-capabilities injection', () => {
    // upstream-aligned invariant: typed sub-agents (Explore/Plan/...)
    // ship a minimal Notes + env block via subagentSystemPrompt.ts and
    // pull skills explicitly through SKILL frontmatter `skills:` preload.
    // Fork sub-agents inherit the parent's prompt byte-for-byte, so any
    // re-injection here would double up. Lock both invariants with
    // file-level grep so a future refactor cannot quietly add them.
    const subagentPrompt = readRepoFile('electron/agents/subagentSystemPrompt.ts')
    expect(subagentPrompt).not.toContain('getCompactSkillIndexPrompt')
    expect(subagentPrompt).not.toContain('getMemorySystemPromptSection')
    expect(subagentPrompt).not.toContain('buildMemorySystemPrompt')

    const subagentRunner = readRepoFile('electron/agents/subAgentRunner.ts')
    expect(subagentRunner).not.toContain('getCompactSkillIndexPrompt')
    expect(subagentRunner).not.toContain('getMemorySystemPromptSection')
  })
})
