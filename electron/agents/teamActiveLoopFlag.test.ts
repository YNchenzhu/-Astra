import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isTeamActiveLoopEnabled } from './teamActiveLoopFlag'

describe('isTeamActiveLoopEnabled', () => {
  let prior: string | undefined
  beforeEach(() => {
    prior = process.env.POLE_TEAM_ACTIVE_LOOP
  })
  afterEach(() => {
    if (prior === undefined) {
      delete process.env.POLE_TEAM_ACTIVE_LOOP
    } else {
      process.env.POLE_TEAM_ACTIVE_LOOP = prior
    }
  })

  it('is true when the env var is unset (S3: default ON)', () => {
    delete process.env.POLE_TEAM_ACTIVE_LOOP
    expect(isTeamActiveLoopEnabled()).toBe(true)
  })

  it('is true when the env var is empty (Windows `set FOO=` quirk)', () => {
    process.env.POLE_TEAM_ACTIVE_LOOP = ''
    expect(isTeamActiveLoopEnabled()).toBe(true)
  })

  it('is false only on explicit falsy spellings', () => {
    for (const v of ['0', 'false', 'FALSE', 'no', 'n', 'off', ' OFF ', 'disabled']) {
      process.env.POLE_TEAM_ACTIVE_LOOP = v
      expect(isTeamActiveLoopEnabled(), `value="${v}"`).toBe(false)
    }
  })

  it('treats common truthy spellings as enabled', () => {
    for (const v of ['1', 'true', 'TRUE', 'on', 'yes', 'y', ' true ']) {
      process.env.POLE_TEAM_ACTIVE_LOOP = v
      expect(isTeamActiveLoopEnabled(), `value="${v}"`).toBe(true)
    }
  })

  it('treats unrecognised values as enabled (forward-compat)', () => {
    process.env.POLE_TEAM_ACTIVE_LOOP = 'enabled-please'
    expect(isTeamActiveLoopEnabled()).toBe(true)
  })
})
