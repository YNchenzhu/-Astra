import { describe, it, expect, beforeEach, vi } from 'vitest'
import { RECENT_PROJECTS_STORAGE_KEY } from '../constants/recentProjects'
import {
  normalizeRecentProjectPath,
  readRecentProjectsFromStorage,
  syncRecentProjectsWithWorkspaceRoot,
} from './recentProjectsPersistence'

function attachFakeLocalStorage(): Map<string, string> {
  const map = new Map<string, string>()
  const ls = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
    removeItem: (k: string) => {
      map.delete(k)
    },
    clear: () => {
      map.clear()
    },
  }
  vi.stubGlobal('localStorage', ls as unknown as Storage)
  return map
}

describe('recentProjectsPersistence', () => {
  beforeEach(() => {
    attachFakeLocalStorage()
  })

  it('normalizeRecentProjectPath unifies slashes', () => {
    expect(normalizeRecentProjectPath('G:\\work\\app')).toBe('G:/work/app')
  })

  it('syncRecentProjectsWithWorkspaceRoot prepends and dedupes by normalized path', () => {
    localStorage.setItem(
      RECENT_PROJECTS_STORAGE_KEY,
      JSON.stringify(['G:/other', 'G:\\work\\app']),
    )
    syncRecentProjectsWithWorkspaceRoot('G:/work/app')
    expect(readRecentProjectsFromStorage()).toEqual(['G:/work/app', 'G:/other'])
  })

  it('syncRecentProjectsWithWorkspaceRoot records first open', () => {
    syncRecentProjectsWithWorkspaceRoot('D:/repo')
    expect(readRecentProjectsFromStorage()).toEqual(['D:/repo'])
  })
})
