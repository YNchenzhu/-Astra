import { describe, it, expect } from 'vitest'
import { parseAgentFromMarkdown, applyAgentFrontmatterKeyAliases } from './customAgents'
import { silenceExpectedConsoleWarn } from '../testHelpers/silenceExpectedConsole'

// Invalid permissionMode tests deliberately trigger the Zod-rejection warn
// in production. Behavior is asserted via return value (null); the warn
// itself is noise we don't want in test output.
silenceExpectedConsoleWarn()

describe('applyAgentFrontmatterKeyAliases', () => {
  it('maps snake_case keys when camelCase absent', () => {
    const m = applyAgentFrontmatterKeyAliases({
      name: 'x',
      max_turns: 12,
      permission_mode: 'plan',
    })
    expect(m.maxTurns).toBe(12)
    expect(m.permissionMode).toBe('plan')
    expect(m.max_turns).toBeUndefined()
  })
})

describe('parseAgentFromMarkdown (Zod AC-2.5)', () => {
  it('accepts valid frontmatter and body', () => {
    const md = `---
name: md-agent
description: Does things
maxTurns: 5
permissionMode: default
tools:
  - Read
---
You are helpful.
`
    const a = parseAgentFromMarkdown('/tmp/x.md', md)
    expect(a).not.toBeNull()
    expect(a?.agentType).toBe('md-agent')
    expect(a?.maxTurns).toBe(5)
    expect(a?.getSystemPrompt()).toContain('helpful')
  })

  it('returns null when Zod rejects (invalid permissionMode)', () => {
    const md = `---
name: bad
description: x
permissionMode: not-a-real-mode
---
Body.
`
    expect(parseAgentFromMarkdown('/tmp/bad.md', md)).toBeNull()
  })

  it('accepts whenToUse without description', () => {
    const md = `---
name: w
whenToUse: When needed
---
Prompt body.
`
    const a = parseAgentFromMarkdown('/tmp/w.md', md)
    expect(a?.whenToUse).toBe('When needed')
  })

  // Regression: pre-fix `parseSimpleYaml` turned `description: |` into an
  // empty array because the multi-line continuation was silently dropped,
  // which then made Zod reject the record with
  //   "Invalid input: expected string, received array"
  // — observed in production logs for `flutter-go-reviewer.md`. The schema
  // collapses `description` into `whenToUse` at the output stage
  // (`toSharedDefinitionFields`), so we assert against `whenToUse` here.
  it('accepts a literal block scalar (`|`) for description', () => {
    const md = `---
name: literal-desc
description: |
  Reviews Flutter and Go code
  for security issues.
tools:
  - Read
  - Grep
---
Body text.
`
    const a = parseAgentFromMarkdown('/tmp/lit.md', md)
    expect(a).not.toBeNull()
    expect(typeof a?.whenToUse).toBe('string')
    expect(a?.whenToUse).toContain('Reviews Flutter and Go code')
    expect(a?.whenToUse).toContain('for security issues.')
  })

  it('accepts a folded block scalar (`>`) for whenToUse', () => {
    const md = `---
name: folded-when
whenToUse: >
  Use this agent when reviewing
  cross-language code reviews
  for Flutter and Go.
---
Body.
`
    const a = parseAgentFromMarkdown('/tmp/fold.md', md)
    expect(a).not.toBeNull()
    expect(typeof a?.whenToUse).toBe('string')
    // Folded mode joins with single spaces, so each segment lives on the same line.
    expect(a?.whenToUse).toMatch(/Use this agent when reviewing\s+cross-language code reviews\s+for Flutter and Go\./)
  })

  it('still parses list values after a block scalar key', () => {
    // The block-scalar termination logic must not eat the following `tools:` list.
    const md = `---
name: mixed
description: |
  Multi
  line.
tools:
  - Read
  - Edit
---
Body.
`
    const a = parseAgentFromMarkdown('/tmp/mixed.md', md)
    expect(a).not.toBeNull()
    expect(typeof a?.whenToUse).toBe('string')
    expect(a?.whenToUse).toContain('Multi')
    expect(a?.tools).toEqual(['Read', 'Edit'])
  })
})
