import { describe, expect, it } from 'vitest'
import { findTabForWorkspacePath } from './useFileStore'
import type { TabInfo } from '../types'

function tab(path: string, id = 't1'): TabInfo {
  return {
    id,
    path,
    name: 'x',
    language: 'plaintext',
    content: '',
    isModified: false,
  }
}

describe('findTabForWorkspacePath', () => {
  const root = 'G:/workspace/project'

  it('matches relative tab to absolute incoming (AI diff path)', () => {
    const tabs = [tab('src/foo.js')]
    expect(findTabForWorkspacePath(tabs, 'G:/workspace/project/src/foo.js', root)?.id).toBe('t1')
  })

  it('matches absolute tab to relative incoming', () => {
    const tabs = [tab('G:/workspace/project/src/foo.js')]
    expect(findTabForWorkspacePath(tabs, 'src/foo.js', root)?.id).toBe('t1')
  })

  it('matches file URI incoming to relative tab', () => {
    const tabs = [tab('src/foo.js')]
    expect(findTabForWorkspacePath(tabs, 'file:///G:/workspace/project/src/foo.js', root)?.id).toBe(
      't1',
    )
  })

  it('does not merge distinct untitled buffers', () => {
    const tabs = [tab('untitled-1-99', 'a'), tab('untitled-2-88', 'b')]
    expect(findTabForWorkspacePath(tabs, 'untitled-1-99', null)?.id).toBe('a')
    expect(findTabForWorkspacePath(tabs, 'untitled-2-88', null)?.id).toBe('b')
  })
})
