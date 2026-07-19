import { describe, expect, it } from 'vitest'
import { normalizeReadStatePathKey } from './readFileState'

describe('normalizeReadStatePathKey', () => {
  it('case-folds Windows drive and UNC paths independent of the host OS', () => {
    expect(normalizeReadStatePathKey('C:\\Temp\\Mixed\\File.ts')).toBe(
      'c:/temp/mixed/file.ts',
    )
    expect(normalizeReadStatePathKey('\\\\Server\\Share\\Mixed.txt')).toBe(
      '//server/share/mixed.txt',
    )
  })

  it('preserves POSIX path case for case-sensitive filesystems', () => {
    expect(normalizeReadStatePathKey('/tmp/CaseSensitive/File.ts')).toBe(
      '/tmp/CaseSensitive/File.ts',
    )
  })
})
