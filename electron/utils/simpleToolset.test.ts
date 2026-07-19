import { describe, it, expect, afterEach } from 'vitest'
import {
  isSimpleToolsetMode,
  toolAllowedInSimpleToolset,
  SIMPLE_TOOLSET_NAME_SET,
} from './simpleToolset'

describe('simpleToolset (report §4.2)', () => {
  afterEach(() => {
    delete process.env.ASTRA_SIMPLE_TOOLSET
    delete process.env.CLAUDE_CODE_SIMPLE
  })

  it('is off by default', () => {
    delete process.env.ASTRA_SIMPLE_TOOLSET
    delete process.env.CLAUDE_CODE_SIMPLE
    expect(isSimpleToolsetMode()).toBe(false)
    expect(toolAllowedInSimpleToolset({ name: 'glob_file_search' })).toBe(true)
  })

  it('ASTRA_SIMPLE_TOOLSET=1 restricts to three tools', () => {
    process.env.ASTRA_SIMPLE_TOOLSET = '1'
    delete process.env.CLAUDE_CODE_SIMPLE
    expect(isSimpleToolsetMode()).toBe(true)
    expect(SIMPLE_TOOLSET_NAME_SET.size).toBe(3)
    expect(toolAllowedInSimpleToolset({ name: 'read_file' })).toBe(true)
    expect(toolAllowedInSimpleToolset({ name: 'Agent' })).toBe(false)
  })

  it('CLAUDE_CODE_SIMPLE=1 enables same mode', () => {
    delete process.env.ASTRA_SIMPLE_TOOLSET
    process.env.CLAUDE_CODE_SIMPLE = '1'
    expect(isSimpleToolsetMode()).toBe(true)
  })
})
