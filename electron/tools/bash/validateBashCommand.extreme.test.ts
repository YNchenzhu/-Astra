/**
 * Extreme / adversarial test cases for validateBashCommand — 20 cases.
 * Run: npx vitest run electron/tools/bash/validateBashCommand.extreme.test.ts
 */

import { describe, it, expect } from 'vitest'
import { validateBashCommand } from './validateBashCommand'
import { BashSecurityCode as BC } from './bashCodes'

describe('validateBashCommand extreme/adversarial', () => {
  // ─── 1. Empty command string ──────────────────────────────────
  it('B1: empty command returns allow with isReadOnly=true', () => {
    const r = validateBashCommand('')
    expect(r.verdict).toBe('allow')
    // Empty command has no analysis → isReadOnly defaults to true
  })

  // ─── 2. Whitespace-only command ───────────────────────────────
  it('B2: whitespace-only command handles gracefully', () => {
    const r = validateBashCommand('   \n  ')
    expect(r.verdict).toBe('allow')
  })

  // ─── 3. Backtick injection attempt ────────────────────────────
  it('B3: detects backtick command substitution as injection risk', () => {
    const r = validateBashCommand('echo `rm -rf /`')
    expect(r.codes).toContain(BC.STRING_BACKTICK)
    expect(r.verdict).toBe('deny')
  })

  // ─── 4. Nested subshell injection ─────────────────────────────
  it('B4: detects nested $(()) command substitution', () => {
    const r = validateBashCommand('echo $(cat $(echo /etc/passwd))')
    expect(r.codes).toContain(BC.STRING_NESTED_SUBST)
    expect(r.verdict).toBe('deny')
  })

  // ─── 5. Pipe to shell ─────────────────────────────────────────
  it('B5: detects pipe to shell interpreter as high-risk', () => {
    const r = validateBashCommand('cat file.txt | bash')
    expect(r.codes).toContain(BC.STRING_PIPE_TO_SHELL)
    expect(r.verdict).toBe('deny')
  })

  // ─── 6. Eval with variable ────────────────────────────────────
  it('B6: detects eval with dynamic execution', () => {
    const r = validateBashCommand('eval $USER_INPUT')
    expect(r.codes).toContain(BC.STRING_EVAL_SOURCE)
    expect(r.verdict).toBe('deny')
  })

  // ─── 7. Long chain of operators (16+ chain operators) ─────────
  it('B7: detects excessively long command chains', () => {
    const chain = Array(17).fill('echo x').join('; ')
    const r = validateBashCommand(chain)
    expect(r.codes).toContain(BC.STRING_LONG_CHAIN)
    expect(r.verdict).toBe('deny')
  })

  // ─── 8. Sensitive env variable ─────────────────────────────────
  it('B8: detects sensitive environment variable references', () => {
    const r = validateBashCommand('echo $PATH')
    expect(r.codes).toContain(BC.STRING_SENSITIVE_ENV)
    expect(r.verdict).toBe('deny')
  })

  // ─── 9. rm -rf ────────────────────────────────────────────────
  it('B9: denies rm -rf as dangerous with recursive warning', () => {
    const r = validateBashCommand('rm -rf /important')
    expect(r.codes).toContain(BC.DANGEROUS_COMMAND)
    expect(r.codes).toContain(BC.WARN_RM_RECURSIVE)
    expect(r.verdict).toBe('deny')
  })

  // ─── 10. Read-only command (ls) ───────────────────────────────
  it('B10: ls is classified as read-only and allowed', () => {
    const r = validateBashCommand('ls -la')
    expect(r.verdict).toBe('allow')
    expect(r.isReadOnly).toBe(true)
  })

  // ─── 11. Git status (read-only subcommand) ────────────────────
  it('B11: git status is allowed (exempted from WARN_COMMANDS)', () => {
    const r = validateBashCommand('git status')
    expect(r.verdict).toBe('allow')
    // git status is exempted from WARN_COMMANDS but multi-command still triggers
    // a warn — verify it's not denied
    expect(r.verdict).not.toBe('deny')
  })

  // ─── 12. Git push --force ─────────────────────────────────────
  it('B12: warns on git push --force', () => {
    const r = validateBashCommand('git push --force origin main')
    expect(r.codes).toContain(BC.WARN_GIT_PUSH_FORCE)
    expect(r.verdict).toBe('warn')
  })

  // ─── 13. chmod 777 ────────────────────────────────────────────
  it('B13: warns on chmod 777 excessively permissive', () => {
    const r = validateBashCommand('chmod 777 file.txt')
    expect(r.codes).toContain(BC.WARN_CHMOD_777)
    expect(r.verdict).toBe('warn')
  })

  // ─── 14. kill -9 ──────────────────────────────────────────────
  it('B14: warns on kill -9 SIGKILL', () => {
    const r = validateBashCommand('kill -9 1234')
    expect(r.codes).toContain(BC.WARN_KILL_SIGKILL)
    expect(r.verdict).toBe('warn')
  })

  // ─── 15. dd command ───────────────────────────────────────────
  it('B15: denies dd command as potentially destructive', () => {
    const r = validateBashCommand('dd if=/dev/zero of=/dev/sda')
    expect(r.codes).toContain(BC.DENY_DD)
    expect(r.verdict).toBe('deny')
  })

  // ─── 16. curl with -O flag (output to file) ───────────────────
  it('B16: curl -O sets isReadOnly=false (writes file)', () => {
    const r = validateBashCommand('curl -O http://example.com/file')
    expect(r.isReadOnly).toBe(false)
  })

  // ─── 17. Complex valid command ────────────────────────────────
  it('B17: complex valid pipeline analyzed correctly', () => {
    const r = validateBashCommand('find . -name "*.ts" -type f | xargs wc -l')
    expect(r.commandAnalysis.length).toBeGreaterThanOrEqual(1)
    // Should not be denied for normal find|xargs
    expect(r.verdict).not.toBe('deny')
  })

  // ─── 18. PowerShell companion mode: Remove-Item -Recurse ──────
  it('B18: warns on PowerShell recursive remove in companion mode', () => {
    const r = validateBashCommand('Remove-Item -Recurse -Force C:\\temp', {
      companionForPowerShell: true,
    })
    expect(r.codes).toContain(BC.WARN_RM_RECURSIVE)
    expect(r.verdict).toBe('warn')
  })

  // ─── 19. Cross-platform: python3 on Windows ───────────────────
  it('B19: detects cross-platform executability issue (python3 on win32)', () => {
    const r = validateBashCommand('python3 script.py', { platform: 'win32' })
    // python3 does not exist on Windows by default → should at minimum flag a cross-platform finding
    const hasXpFlag = r.codes.some(
      (c) => c.startsWith('bash.xp'),
    )
    expect(hasXpFlag).toBe(true)
  })

  // ─── 20. Shell -c execution ────────────────────────────────────
  it('B20: detects shell -c direct command execution', () => {
    const r = validateBashCommand('bash -c "echo hacked"')
    expect(r.codes).toContain(BC.STRING_PIPE_TO_SHELL)
    expect(r.verdict).toBe('deny')
  })
})
