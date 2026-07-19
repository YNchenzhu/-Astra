/**
 * Self-audit fix B3 (2026-05) — pins the G6 fix: workspacePattern and
 * toolPattern matchers must escape regex metacharacters before turning
 * `*` into `.*`. Without these, a Windows cwd containing `(`, `)`, or
 * `.` (extremely common — `C:\Users\foo (work)\repo`) made the matcher
 * fall back to "matches nothing".
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  clearSkillHookRegistry,
  getSkillHooksForEvent,
  registerSkillHooks,
} from './skillHooks'
import type { SkillHookSpec } from './types'

const baseHook: SkillHookSpec = {
  event: 'PreToolUse',
  command: 'echo ok',
}

describe('skillHooks matcher — workspacePattern escape (G6)', () => {
  afterEach(() => {
    clearSkillHookRegistry()
  })

  it('literal cwd matches without wildcards', () => {
    registerSkillHooks('alpha', [
      { ...baseHook, matcher: { workspacePattern: '/home/user/repo' } },
    ])
    expect(
      getSkillHooksForEvent('alpha', 'PreToolUse', '/home/user/repo'),
    ).toHaveLength(1)
    expect(
      getSkillHooksForEvent('alpha', 'PreToolUse', '/home/user/other'),
    ).toHaveLength(0)
  })

  it('matches Windows-style cwd containing parens (G6 regression)', () => {
    // Pre-fix, the unescaped `(work)` was interpreted as a regex capture group.
    // The escaped version treats it as literal text.
    registerSkillHooks('beta', [
      { ...baseHook, matcher: { workspacePattern: 'C:\\Users\\foo (work)\\repo' } },
    ])
    expect(
      getSkillHooksForEvent('beta', 'PreToolUse', 'C:\\Users\\foo (work)\\repo'),
    ).toHaveLength(1)
  })

  it('matches cwd containing dots and dollar signs as literal text', () => {
    registerSkillHooks('gamma', [
      { ...baseHook, matcher: { workspacePattern: '/var/app.v1/$tmp' } },
    ])
    expect(
      getSkillHooksForEvent('gamma', 'PreToolUse', '/var/app.v1/$tmp'),
    ).toHaveLength(1)
    // Crucial: `.` must NOT match an arbitrary character.
    expect(
      getSkillHooksForEvent('gamma', 'PreToolUse', '/var/appXv1/$tmp'),
    ).toHaveLength(0)
  })

  it('honors `*` as a real wildcard segment', () => {
    registerSkillHooks('delta', [
      { ...baseHook, matcher: { workspacePattern: '/repos/*/my-app' } },
    ])
    expect(
      getSkillHooksForEvent('delta', 'PreToolUse', '/repos/team/my-app'),
    ).toHaveLength(1)
    expect(
      getSkillHooksForEvent('delta', 'PreToolUse', '/repos/team/other-app'),
    ).toHaveLength(0)
  })
})

describe('skillHooks matcher — toolPattern escape (regression guard)', () => {
  afterEach(() => {
    clearSkillHookRegistry()
  })

  it('exact tool name match', () => {
    registerSkillHooks('s1', [
      { ...baseHook, matcher: { toolPattern: 'read_file' } },
    ])
    expect(
      getSkillHooksForEvent('s1', 'PreToolUse', undefined, 'read_file'),
    ).toHaveLength(1)
    expect(
      getSkillHooksForEvent('s1', 'PreToolUse', undefined, 'write_file'),
    ).toHaveLength(0)
  })

  it('wildcard prefix match (mcp__*)', () => {
    registerSkillHooks('s2', [
      { ...baseHook, matcher: { toolPattern: 'mcp__*' } },
    ])
    expect(
      getSkillHooksForEvent('s2', 'PreToolUse', undefined, 'mcp__server__tool'),
    ).toHaveLength(1)
    expect(
      getSkillHooksForEvent('s2', 'PreToolUse', undefined, 'read_file'),
    ).toHaveLength(0)
  })

  it('toolPattern requires toolName to be present', () => {
    registerSkillHooks('s3', [
      { ...baseHook, matcher: { toolPattern: 'read_file' } },
    ])
    expect(
      getSkillHooksForEvent('s3', 'PreToolUse', undefined, undefined),
    ).toHaveLength(0)
  })
})

describe('skillHooks matcher — no matcher means always-match', () => {
  afterEach(() => {
    clearSkillHookRegistry()
  })

  it('hook without matcher fires regardless of cwd / toolName', () => {
    registerSkillHooks('s4', [baseHook])
    expect(getSkillHooksForEvent('s4', 'PreToolUse')).toHaveLength(1)
    expect(
      getSkillHooksForEvent('s4', 'PreToolUse', '/any/path', 'any_tool'),
    ).toHaveLength(1)
  })
})
