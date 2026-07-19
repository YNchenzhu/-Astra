import { describe, expect, it } from 'vitest'
import { SystemPromptBuilder } from './systemPromptBuilder'

const emptyLayers = {
  systemContext: '',
  userContext: '',
  userMessageContext: '',
}

describe('SystemPromptBuilder', () => {
  it('empty initial → build returns empty merged + empty layers', () => {
    const b = new SystemPromptBuilder(emptyLayers)
    const out = b.build()
    expect(out.merged).toBe('')
    expect(out.layers).toEqual(emptyLayers)
  })

  it('initial layers pass through verbatim', () => {
    const b = new SystemPromptBuilder({
      systemContext: 'STATIC',
      userContext: 'VOLATILE',
      userMessageContext: 'REF',
    })
    const out = b.build()
    expect(out.layers.systemContext).toBe('STATIC')
    expect(out.layers.userContext).toBe('VOLATILE')
    expect(out.layers.userMessageContext).toBe('REF')
    expect(out.merged).toBe('STATIC\n\nVOLATILE')
  })

  it('adds to static layer with default \\n\\n separator', () => {
    const b = new SystemPromptBuilder({
      systemContext: 'BASE',
      userContext: '',
      userMessageContext: '',
    })
    b.add({ id: 'extra', text: 'EXTRA', layer: 'static' })
    const out = b.build()
    expect(out.layers.systemContext).toBe('BASE\n\nEXTRA')
    expect(out.merged).toBe('BASE\n\nEXTRA')
  })

  it('adds to volatile layer with default \\n\\n separator', () => {
    const b = new SystemPromptBuilder({
      systemContext: 'S',
      userContext: 'V',
      userMessageContext: '',
    })
    b.add({ id: 'hint', text: 'HINT', layer: 'volatile' })
    const out = b.build()
    expect(out.layers.userContext).toBe('V\n\nHINT')
    expect(out.merged).toBe('S\n\nV\n\nHINT')
  })

  it('honors explicit separator (e.g. routing hint with leading \\n\\n)', () => {
    const b = new SystemPromptBuilder({
      systemContext: '',
      userContext: 'BODY',
      userMessageContext: '',
    })
    // Hint pre-formatted with own leading newlines — must NOT add another \n\n
    b.add({
      id: 'routing',
      text: '\n\n## Task Routing\nDelegate.',
      layer: 'volatile',
      separator: '',
    })
    const out = b.build()
    expect(out.layers.userContext).toBe('BODY\n\n## Task Routing\nDelegate.')
  })

  it('honors custom separator (e.g. \\n\\n---\\n\\n for hook output)', () => {
    const b = new SystemPromptBuilder({
      systemContext: '',
      userContext: 'BODY',
      userMessageContext: '',
    })
    b.add({
      id: 'hook',
      text: 'HOOK_TEXT',
      layer: 'volatile',
      separator: '\n\n---\n\n',
    })
    const out = b.build()
    expect(out.layers.userContext).toBe('BODY\n\n---\n\nHOOK_TEXT')
  })

  it('id-based dedup — adding the same id twice keeps only the first', () => {
    const b = new SystemPromptBuilder(emptyLayers)
    b.add({ id: 'plan-mode', text: 'FIRST', layer: 'volatile' })
    b.add({ id: 'plan-mode', text: 'SECOND', layer: 'volatile' })
    const out = b.build()
    expect(out.layers.userContext).toBe('FIRST')
  })

  it('marker-based idempotency — section is skipped if marker already present in layer', () => {
    const b = new SystemPromptBuilder({
      systemContext: '',
      userContext: 'CARRIES_# Plan mode is active\nbody...',
      userMessageContext: '',
    })
    b.add({
      id: 'plan-mode',
      text: '# Plan mode is active\nFRESH BODY',
      layer: 'volatile',
      marker: '# Plan mode is active',
    })
    const out = b.build()
    // Original carry-over preserved, no duplicate.
    expect(out.layers.userContext).toBe('CARRIES_# Plan mode is active\nbody...')
  })

  it('whitespace-only text is dropped (no separator added)', () => {
    const b = new SystemPromptBuilder({
      systemContext: '',
      userContext: 'BODY',
      userMessageContext: '',
    })
    b.add({ id: 'empty', text: '   \n  ', layer: 'volatile' })
    const out = b.build()
    expect(out.layers.userContext).toBe('BODY')
  })

  it('userMessageContext passes through unchanged regardless of system additions', () => {
    const b = new SystemPromptBuilder({
      systemContext: 'S',
      userContext: 'V',
      userMessageContext: 'REF',
    })
    b.add({ id: 'a', text: 'A', layer: 'static' })
    b.add({ id: 'b', text: 'B', layer: 'volatile' })
    expect(b.build().layers.userMessageContext).toBe('REF')
  })

  it('build is deterministic — calling twice returns equal result', () => {
    const b = new SystemPromptBuilder({
      systemContext: 'S',
      userContext: 'V',
      userMessageContext: 'R',
    })
    b.add({ id: 'a', text: 'A', layer: 'volatile' })
    expect(b.build()).toEqual(b.build())
  })

  it('has(id) reports whether a section was already added (dedup probe)', () => {
    const b = new SystemPromptBuilder(emptyLayers)
    expect(b.has('foo')).toBe(false)
    b.add({ id: 'foo', text: 'F', layer: 'volatile' })
    expect(b.has('foo')).toBe(true)
  })

  it('marker hit is also recorded as `has(id)` so subsequent re-adds are skipped without re-checking marker', () => {
    const b = new SystemPromptBuilder({
      systemContext: '',
      userContext: 'PLAN_MARKER\n…',
      userMessageContext: '',
    })
    b.add({
      id: 'plan-mode',
      text: 'IGNORED',
      layer: 'volatile',
      marker: 'PLAN_MARKER',
    })
    expect(b.has('plan-mode')).toBe(true)
    // Even if a different text is offered next, id-dedup short-circuits.
    b.add({ id: 'plan-mode', text: 'ALSO_IGNORED', layer: 'volatile' })
    expect(b.build().layers.userContext).toBe('PLAN_MARKER\n…')
  })

  it('multiple sections in the same layer are joined with their respective separators', () => {
    const b = new SystemPromptBuilder({
      systemContext: '',
      userContext: 'BODY',
      userMessageContext: '',
    })
    b.add({ id: 'a', text: 'A', layer: 'volatile' }) // default \n\n
    b.add({ id: 'b', text: 'B', layer: 'volatile', separator: '\n---\n' })
    b.add({ id: 'c', text: 'C', layer: 'volatile' }) // default \n\n
    const out = b.build()
    expect(out.layers.userContext).toBe('BODY\n\nA\n---\nB\n\nC')
  })

  it('merge invariant — built.merged === mergeSystemPromptLayers(layers.systemContext, layers.userContext)', () => {
    const b = new SystemPromptBuilder({
      systemContext: 'IDENTITY',
      userContext: 'ENV',
      userMessageContext: 'REF',
    })
    b.add({ id: 'r', text: '\n\n## Task Routing\nDelegate.', layer: 'volatile', separator: '' })
    b.add({ id: 'h', text: 'HOOK', layer: 'volatile', separator: '\n\n---\n\n' })
    b.add({ id: 'p', text: '# Plan mode is active\n…', layer: 'volatile', marker: '# Plan mode is active' })
    const out = b.build()
    // Re-derive using the same helper used inside Builder.
    const expected = out.layers.systemContext
      + (out.layers.userContext.trim() ? `\n\n${out.layers.userContext}` : '')
    expect(out.merged).toBe(expected)
  })
})
