/**
 * Unit tests for the three-mode todo gate resolution (星构Astra
 * coexist extension, 2026-05).
 *
 * Coverage:
 *   - default → `'coexist'` (both `isTodoV1Enabled` + `isTodoV2Enabled` true)
 *   - `ASTRA_TODO_MODE=v1-only|v2-only|coexist` env override
 *   - legacy `ASTRA_TODO_V1` / `CLAUDE_CODE_TODO_V1` env → `'v1-only'`
 *   - resolution priority: disk settings > explicit env > legacy env > default
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getTodoMode,
  isTodoCoexistMode,
  isTodoV1Enabled,
  isTodoV2Enabled,
} from './todoMode'

// Mock disk settings so we can drive the highest-priority lookup.
const diskSettingsState: { value: Record<string, unknown> } = { value: {} }
vi.mock('../settings/settingsAccess', () => ({
  readDiskSettings: () => diskSettingsState.value,
}))

function clearEnv(): void {
  delete process.env.ASTRA_TODO_MODE
  delete process.env.ASTRA_TODO_V1
  delete process.env.CLAUDE_CODE_TODO_V1
}

beforeEach(() => {
  diskSettingsState.value = {}
  clearEnv()
})

afterEach(() => {
  diskSettingsState.value = {}
  clearEnv()
})

describe('todoMode — default behaviour', () => {
  it('defaults to coexist when nothing is set', () => {
    expect(getTodoMode()).toBe('coexist')
    expect(isTodoCoexistMode()).toBe(true)
    expect(isTodoV1Enabled()).toBe(true)
    expect(isTodoV2Enabled()).toBe(true)
  })
})

describe('todoMode — disk settings (highest priority)', () => {
  it('honours settings.todoMode = "v1-only"', () => {
    diskSettingsState.value = { todoMode: 'v1-only' }
    expect(getTodoMode()).toBe('v1-only')
    expect(isTodoCoexistMode()).toBe(false)
    expect(isTodoV1Enabled()).toBe(true)
    expect(isTodoV2Enabled()).toBe(false)
  })

  it('honours settings.todoMode = "v2-only"', () => {
    diskSettingsState.value = { todoMode: 'v2-only' }
    expect(getTodoMode()).toBe('v2-only')
    expect(isTodoCoexistMode()).toBe(false)
    expect(isTodoV1Enabled()).toBe(false)
    expect(isTodoV2Enabled()).toBe(true)
  })

  it('honours settings.todoMode = "coexist" (explicit form)', () => {
    diskSettingsState.value = { todoMode: 'coexist' }
    expect(getTodoMode()).toBe('coexist')
    expect(isTodoV1Enabled()).toBe(true)
    expect(isTodoV2Enabled()).toBe(true)
  })

  it('ignores unrecognised settings.todoMode values (falls through to env / default)', () => {
    diskSettingsState.value = { todoMode: 'garbage' }
    expect(getTodoMode()).toBe('coexist')
  })

  it('disk setting wins over env override', () => {
    diskSettingsState.value = { todoMode: 'v1-only' }
    process.env.ASTRA_TODO_MODE = 'v2-only'
    expect(getTodoMode()).toBe('v1-only')
  })
})

describe('todoMode — explicit env override', () => {
  it('ASTRA_TODO_MODE=v1-only flips to V1-only', () => {
    process.env.ASTRA_TODO_MODE = 'v1-only'
    expect(getTodoMode()).toBe('v1-only')
    expect(isTodoV1Enabled()).toBe(true)
    expect(isTodoV2Enabled()).toBe(false)
  })

  it('ASTRA_TODO_MODE=v2-only flips to V2-only', () => {
    process.env.ASTRA_TODO_MODE = 'v2-only'
    expect(getTodoMode()).toBe('v2-only')
    expect(isTodoV1Enabled()).toBe(false)
    expect(isTodoV2Enabled()).toBe(true)
  })

  it('ASTRA_TODO_MODE=coexist still maps to coexist', () => {
    process.env.ASTRA_TODO_MODE = 'coexist'
    expect(getTodoMode()).toBe('coexist')
  })

  it('case insensitive', () => {
    process.env.ASTRA_TODO_MODE = 'V2-ONLY'
    expect(getTodoMode()).toBe('v2-only')
  })

  it('rubbish value falls through to legacy env / default', () => {
    process.env.ASTRA_TODO_MODE = 'broken'
    expect(getTodoMode()).toBe('coexist')
  })

  it('explicit env wins over legacy env', () => {
    process.env.ASTRA_TODO_MODE = 'v2-only'
    process.env.ASTRA_TODO_V1 = '1'  // would imply v1-only
    expect(getTodoMode()).toBe('v2-only')
  })
})

describe('todoMode — legacy env (cc-haha compat)', () => {
  it('ASTRA_TODO_V1=1 → v1-only', () => {
    process.env.ASTRA_TODO_V1 = '1'
    expect(getTodoMode()).toBe('v1-only')
    expect(isTodoV2Enabled()).toBe(false)
  })

  it('CLAUDE_CODE_TODO_V1=true → v1-only (upstream alias)', () => {
    process.env.CLAUDE_CODE_TODO_V1 = 'true'
    expect(getTodoMode()).toBe('v1-only')
  })

  it('falsy legacy env does not flip mode', () => {
    process.env.ASTRA_TODO_V1 = '0'
    expect(getTodoMode()).toBe('coexist')
  })
})

describe('todoMode — robustness', () => {
  it('readDiskSettings throwing falls through to env / default', () => {
    // Force the loader to throw by replacing it with a getter that throws.
    diskSettingsState.value = new Proxy(
      {},
      {
        get() {
          throw new Error('disk read failed')
        },
      },
    ) as Record<string, unknown>
    expect(getTodoMode()).toBe('coexist')
  })
})
