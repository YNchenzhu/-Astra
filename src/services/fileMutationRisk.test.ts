import { describe, expect, it } from 'vitest'
import { computeFileMutationRiskWarnings } from './fileMutationRisk'

describe('computeFileMutationRiskWarnings', () => {
  it('warns when a non-empty file is fully emptied', () => {
    expect(computeFileMutationRiskWarnings('some content', '')).toEqual([
      '此变更将删除文件中的全部内容。',
    ])
  })

  it('no warning for a normal edit', () => {
    expect(computeFileMutationRiskWarnings('abc', 'abcd')).toEqual([])
  })

  it('no warning when creating content in a previously empty file', () => {
    expect(computeFileMutationRiskWarnings('', 'new content')).toEqual([])
  })

  it('no warning when both empty (no-op)', () => {
    expect(computeFileMutationRiskWarnings('', '')).toEqual([])
  })

  it('warns even when shrinking to a single remaining char vs full clear', () => {
    // whitespace-only modified content is still length>0 => not a full clear
    expect(computeFileMutationRiskWarnings('abc', ' ')).toEqual([])
  })
})
