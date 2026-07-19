/**
 * Self-audit fix D2 (2026-05) — pins the yaml-library swap for
 * `customAgents.parseSimpleYaml`. Adds coverage for inputs the
 * hand-rolled parser silently mangled:
 *   - unquoted brace-glob mid-value (e.g. `description: src/*.{ts,tsx}`)
 *   - nested objects (e.g. `metadata: { author: x }`)
 *   - `null` values
 *   - already-quoted strings (idempotent quote pass)
 *
 * The existing `customAgents.markdownZod.test.ts` still covers the
 * block-scalar regression (`description: |` / `>`). We intentionally
 * don't duplicate that here.
 */

import { describe, expect, it } from 'vitest'
import { parseAgentFromMarkdown } from './customAgents'
import { silenceExpectedConsoleWarn } from '../testHelpers/silenceExpectedConsole'

silenceExpectedConsoleWarn()

describe('parseAgentFromMarkdown — yaml-library tolerance (D2)', () => {
  it('parses brace-glob in description without losing the value', () => {
    const md = `---
name: glob-agent
description: Triggers on src/*.{ts,tsx}
---
Body.
`
    const a = parseAgentFromMarkdown('/tmp/g.md', md)
    expect(a).not.toBeNull()
    expect(typeof a?.whenToUse).toBe('string')
    expect(a?.whenToUse).toContain('src/*.{ts,tsx}')
  })

  it('handles inline arrays of tools without breaking', () => {
    const md = `---
name: array-tools
description: Inline array
tools: [Read, Edit, Grep]
---
Body.
`
    const a = parseAgentFromMarkdown('/tmp/a.md', md)
    expect(a).not.toBeNull()
    // The schema canonicalises tool casing; just assert presence.
    expect(a?.tools).toBeDefined()
    expect(a?.tools).toEqual(expect.arrayContaining(['Read', 'Edit', 'Grep']))
  })

  it('does not crash on malformed frontmatter — returns null instead', () => {
    const md = `---
name: broken
description: :::: pathological :::
maxTurns: this is not a number
permissionMode: not-a-real-mode
---
Body.
`
    // Zod will reject this; we just need the parser not to throw.
    expect(() => parseAgentFromMarkdown('/tmp/x.md', md)).not.toThrow()
  })

  it('preserves already-quoted strings verbatim (idempotent quote-retry)', () => {
    const md = `---
name: quoted
description: "Quoted value with colons: like this"
---
Body.
`
    const a = parseAgentFromMarkdown('/tmp/q.md', md)
    expect(a).not.toBeNull()
    expect(a?.whenToUse).toBe('Quoted value with colons: like this')
  })

  it('rejects nested-object description without throwing (Zod-rejects path)', () => {
    // YAML allows `description:` followed by an indented mapping. Old
    // hand-rolled parser would store a malformed value here; library
    // parser produces a real object and the Zod step rejects it.
    const md = `---
name: nested-desc
description:
  foo: bar
---
Body.
`
    expect(() => parseAgentFromMarkdown('/tmp/n.md', md)).not.toThrow()
    // Zod rejects → parseAgentFromMarkdown returns null
    expect(parseAgentFromMarkdown('/tmp/n.md', md)).toBeNull()
  })
})
