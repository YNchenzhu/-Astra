import { describe, it, expect } from 'vitest'
import {
  bashCommandMatchesRule,
  toolNameMatchesRulePattern,
  isToolDeniedForModelListing,
  resolveToolPermissionMode,
} from './permissionRuleMatch'

describe('permissionRuleMatch', () => {
  it('matches MCP server prefix', () => {
    expect(toolNameMatchesRulePattern('mcp__srv__t1', 'mcp__srv')).toBe(true)
    expect(toolNameMatchesRulePattern('mcp__other__t1', 'mcp__srv')).toBe(false)
  })

  it('bashCommandMatchesRule supports prefix and wildcard', () => {
    expect(bashCommandMatchesRule('npm install', 'npm:*')).toBe(true)
    expect(bashCommandMatchesRule('yarn add x', 'npm:*')).toBe(false)
    expect(bashCommandMatchesRule('git status', 'git *')).toBe(true)
    expect(bashCommandMatchesRule('git status --porcelain', 'git *')).toBe(true)
  })

  it('bashCommandMatchesRule is case-insensitive (report §5.5)', () => {
    expect(bashCommandMatchesRule('GIT STATUS', 'git *')).toBe(true)
    expect(bashCommandMatchesRule('Npm install', 'npm:*')).toBe(true)
  })

  it('resolveToolPermissionMode applies shellPattern for Bash (§5.5 integration)', () => {
    const rules = [{ id: 's', pattern: 'bash', mode: 'deny' as const, shellPattern: 'rm *' }]
    expect(
      resolveToolPermissionMode('bash', 'ask', rules, { bashCommand: 'rm -rf /tmp/x' }).effectiveMode,
    ).toBe('deny')
    expect(resolveToolPermissionMode('bash', 'ask', rules, { bashCommand: 'ls' }).matchedRule).toBe(false)
  })

  it('bashCommandMatchesRule exact match (report §5.5)', () => {
    const line = 'git commit -m "fix"'
    expect(bashCommandMatchesRule(line, line)).toBe(true)
    expect(bashCommandMatchesRule('git commit -m "other"', line)).toBe(false)
  })

  it('isToolDeniedForModelListing skips rules with shell/path subpatterns', () => {
    const rules = [
      { id: '1', pattern: 'Bash', mode: 'deny' as const, shellPattern: 'rm *' },
      { id: '2', pattern: 'glob', mode: 'deny' as const },
    ]
    expect(isToolDeniedForModelListing('glob', rules)).toBe(true)
    expect(isToolDeniedForModelListing('Bash', rules)).toBe(false)
  })

  /**
   * upstream §5.4 parity: deny from settings must be resolved before any hook can "allow".
   * `runAgenticToolUse` applies `resolveToolPermissionMode` and returns early on deny before
   * `runPermissionHookPhase` / `runPreToolUsePhase` (see runAgenticToolUse.ts).
   */
  describe('OpenClaude parity — permission before hooks (PHI)', () => {
    it('PHI-01: matched deny rule yields effectiveMode deny', () => {
      expect(
        resolveToolPermissionMode('write_file', 'ask', [
          { id: 'x', pattern: 'write_file', mode: 'deny' },
        ]),
      ).toEqual({ effectiveMode: 'deny', matchedRule: true })
    })

    it('PHI-02: first matching rule wins', () => {
      const rules = [
        { id: 'a', pattern: 'read_file', mode: 'allow' as const },
        { id: 'b', pattern: 'read_file', mode: 'deny' as const },
      ]
      expect(resolveToolPermissionMode('read_file', 'ask', rules)).toEqual({
        effectiveMode: 'allow',
        matchedRule: true,
      })
    })

    it('PHI-03: deny without shell/path hides tool from model listing', () => {
      expect(
        isToolDeniedForModelListing('Bash', [{ id: '1', pattern: 'Bash', mode: 'deny' }]),
      ).toBe(true)
    })
  })

  /**
   * Regression — audit v4, May 2026 (debug-c1971a session, H6 → H8).
   *
   * `pathMatchesPathPattern` used to call `path.relative(workspace, target)`
   * then feed the result into `ignore().add(line).ignores(rel)`. When the
   * target lived OUTSIDE the workspace (e.g. session-memory-internal's
   * `~/.claude/projects/<slug>/session-memory/conv-X.md` from a workspace
   * at `C:\Users\TestUser\Desktop\workspace`), `path.relative` returned
   * `../../.claude/projects/.../conv-X.md` and the `ignore` library threw
   * `RangeError: path should be a \`path.relative()\`d string, but got
   * "../../.claude/projects/..."`. The throw escaped from
   * `pathMatchesPathPattern`, killed the whole tool dispatch, and burned
   * ~2 minutes on retries.
   *
   * `resolveToolPermissionMode` itself doesn't take a `filePath`, so we
   * exercise the matcher indirectly via the `pathPattern` rule path. We
   * smoke-test that no path triggers a throw — return-false is good
   * enough for the broken case.
   */
  describe('audit v4 — pathMatchesPathPattern out-of-workspace safety', () => {
    it('does not throw for any tested file path; out-of-tree paths just do not match', () => {
      const ruleWithPath = [
        { id: 'p', pattern: 'read_file', mode: 'deny' as const, pathPattern: '*.md' },
      ]
      // Whatever path we feed in, evaluating must NOT throw.
      const candidates = [
        'C:\\Users\\TestUser\\.claude\\projects\\5288ae55b508aa99\\session-memory\\conv-X.md',
        '/c/Users/TestUser/.claude/projects/abc/session-memory/conv-X.md',
        '../../.claude/projects/abc/session-memory/conv-X.md',
        '/etc/passwd',
        '',
      ]
      for (const filePath of candidates) {
        expect(() =>
          resolveToolPermissionMode('read_file', 'ask', ruleWithPath, { filePath }),
        ).not.toThrow()
      }
    })
  })

  it('skill: pattern matches Skill tool + invocation name (§9)', () => {
    expect(
      resolveToolPermissionMode(
        'Skill',
        'ask',
        [{ id: 's', pattern: 'skill:commit', mode: 'deny' }],
        { skillInvocationName: 'commit' },
      ),
    ).toEqual({ effectiveMode: 'deny', matchedRule: true })
    expect(
      resolveToolPermissionMode(
        'Skill',
        'ask',
        [{ id: 's', pattern: 'skill:commit', mode: 'deny' }],
        { skillInvocationName: 'other' },
      ).matchedRule,
    ).toBe(false)
    expect(
      resolveToolPermissionMode('Read', 'ask', [{ id: 's', pattern: 'skill:x', mode: 'deny' }])
        .matchedRule,
    ).toBe(false)
  })
})
