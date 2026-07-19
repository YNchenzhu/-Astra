import { describe, it, expect } from 'vitest'
import {
  analyzeCommand,
  validateBashCommand,
  isCommandReadOnly,
  BashSecurityCode,
} from './bashSecurity'

describe('bashSecurity', () => {
  describe('validateBashCommand', () => {
    it('denies rm (blacklist) including rm -rf / style', () => {
      const a = validateBashCommand('rm -rf /')
      expect(a.verdict).toBe('deny')
      expect(a.codes).toContain(BashSecurityCode.DANGEROUS_COMMAND)
    })

    it('denies backtick command substitution (injection)', () => {
      const a = validateBashCommand('echo `whoami`')
      expect(a.verdict).toBe('deny')
      expect(a.codes).toContain(BashSecurityCode.STRING_BACKTICK)
    })

    it('denies nested $( command substitution', () => {
      const a = validateBashCommand('echo $(echo $(echo hi))')
      expect(a.verdict).toBe('deny')
      expect(a.codes).toContain(BashSecurityCode.STRING_NESTED_SUBST)
    })

    it('denies sensitive env references', () => {
      const a = validateBashCommand('echo $PATH')
      expect(a.verdict).toBe('deny')
      expect(a.codes).toContain(BashSecurityCode.STRING_SENSITIVE_ENV)
    })

    it('denies pipe to shell interpreter', () => {
      const a = validateBashCommand('cat x | bash')
      expect(a.verdict).toBe('deny')
      expect(a.codes).toContain(BashSecurityCode.STRING_PIPE_TO_SHELL)
    })

    it('denies overly long structural operator chains', () => {
      const cmd = Array.from({ length: 17 }, () => 'true').join(';')
      const a = validateBashCommand(cmd)
      expect(a.verdict).toBe('deny')
      expect(a.codes).toContain(BashSecurityCode.STRING_LONG_CHAIN)
    })

    it('allows moderate-length chains (e.g. many true && true)', () => {
      const cmd = Array.from({ length: 8 }, () => 'true').join(' && ')
      const a = validateBashCommand(cmd)
      expect(a.verdict).toBe('allow')
      expect(a.codes).not.toContain(BashSecurityCode.STRING_LONG_CHAIN)
    })

    it('does not apply STRING_BACKTICK when defaultShell is powershell', () => {
      const a = validateBashCommand('echo `whoami`', { defaultShell: 'powershell' })
      expect(a.codes).not.toContain(BashSecurityCode.STRING_BACKTICK)
      expect(a.verdict).toBe('allow')
    })

    it('allows benign read-only commands with empty codes', () => {
      const a = validateBashCommand('ls -la')
      expect(a.verdict).toBe('allow')
      expect(a.codes).toEqual([])
    })

    it('marks git status as read-only allow', () => {
      const a = validateBashCommand('git status')
      expect(a.verdict).toBe('allow')
      expect(a.isReadOnly).toBe(true)
      expect(a.codes).toEqual([])
    })

    it('warns on non-read-only git push with stable code', () => {
      const a = validateBashCommand('git push origin main')
      expect(['warn', 'deny']).toContain(a.verdict)
      expect(a.isReadOnly).toBe(false)
      expect(a.codes).toContain(BashSecurityCode.WARN_COMMAND)
    })

    it('tags multi-command pipes with MULTI_COMMAND_CHAIN', () => {
      const a = validateBashCommand('ls | sort')
      expect(a.verdict).toBe('allow')
      expect(a.codes).toContain(BashSecurityCode.MULTI_COMMAND_CHAIN)
      expect(a.isReadOnly).toBe(false)
    })

    // Regression: previously `add()` was used for MULTI_COMMAND_CHAIN,
    // which dropped a "检测到命令链（N个命令）- 需要逐个验证" line into
    // `reasons`. When ANOTHER check denied the command, that chain
    // narration was bundled into the deny payload the model received —
    // pure process noise for the trivial `cd dir && cmd` pattern. The
    // code is kept (telemetry); the reason text must NOT leak.
    it('does NOT add a MULTI_COMMAND_CHAIN narration to reasons', () => {
      const a = validateBashCommand('cd src && ls')
      expect(a.codes).toContain(BashSecurityCode.MULTI_COMMAND_CHAIN)
      expect(a.reasons.join(' ')).not.toMatch(/命令链/)
      expect(a.reasons.join(' ')).not.toMatch(/逐个验证/)
    })

    // Regression: the production payload that triggered this fix bundled
    // an XP_UNCLOSED_QUOTE deny with the chain narration. Confirm the
    // deny payload now contains ONLY the actionable quote message.
    it('emits clean deny payload for `unclosed-quote && cmd` (no chain noise)', () => {
      const a = validateBashCommand('echo "broken && python -V')
      expect(a.verdict).toBe('deny')
      const joined = a.reasons.join('; ')
      expect(joined).toMatch(/未闭合/)
      expect(joined).not.toMatch(/命令链/)
    })

    it('warns chmod 777 with WARN_CHMOD_777', () => {
      const a = validateBashCommand('chmod 777 /tmp/x')
      expect(a.verdict).toBe('warn')
      expect(a.codes).toContain(BashSecurityCode.WARN_CHMOD_777)
    })

    it('warns git push --force with WARN_GIT_PUSH_FORCE', () => {
      const a = validateBashCommand('git push --force origin main')
      expect(a.verdict).toBe('warn')
      expect(a.codes).toContain(BashSecurityCode.WARN_GIT_PUSH_FORCE)
    })
  })

  describe('analyzeCommand', () => {
    it('splits pipes into multiple commands', () => {
      const parts = analyzeCommand('cat a | grep b | wc -l')
      expect(parts.length).toBe(3)
      expect(parts[0].commandName).toBe('cat')
      expect(parts[1].commandName).toBe('grep')
      expect(parts[2].commandName).toBe('wc')
    })

    it('marks hasPipe on piped raw string', () => {
      const parts = analyzeCommand('ls | sort')
      expect(parts.every((p) => p.hasPipe)).toBe(true)
    })
  })

  describe('isCommandReadOnly', () => {
    it('is true only for allow + read-only analysis', () => {
      expect(isCommandReadOnly('pwd')).toBe(true)
      expect(isCommandReadOnly('rm x')).toBe(false)
      expect(isCommandReadOnly('git push')).toBe(false)
    })
  })

  describe('security fixes — absolute-path bypass, shell -c, eval string', () => {
    it('denies /bin/rm (absolute path bypass)', () => {
      const a = validateBashCommand('/bin/rm -rf /')
      expect(a.verdict).toBe('deny')
      expect(a.codes).toContain(BashSecurityCode.DANGEROUS_COMMAND)
    })

    it('denies /usr/bin/rm (absolute path bypass)', () => {
      const a = validateBashCommand('/usr/bin/rm foo')
      expect(a.verdict).toBe('deny')
      expect(a.codes).toContain(BashSecurityCode.DANGEROUS_COMMAND)
    })

    it('denies /sbin/mkfs (absolute path bypass)', () => {
      const a = validateBashCommand('/sbin/mkfs /dev/sda')
      expect(a.verdict).toBe('deny')
      expect(a.codes).toContain(BashSecurityCode.DANGEROUS_COMMAND)
    })

    it('denies bash -c (direct shell execution)', () => {
      const a = validateBashCommand('bash -c "rm -rf /"')
      expect(a.verdict).toBe('deny')
      expect(a.codes).toContain(BashSecurityCode.STRING_PIPE_TO_SHELL)
    })

    it('denies sh -c (direct shell execution)', () => {
      const a = validateBashCommand('sh -c "whoami"')
      expect(a.verdict).toBe('deny')
      expect(a.codes).toContain(BashSecurityCode.STRING_PIPE_TO_SHELL)
    })

    it('denies /bin/bash -c (absolute path shell execution)', () => {
      const a = validateBashCommand('/bin/bash -c whoami')
      expect(a.verdict).toBe('deny')
      expect(a.codes).toContain(BashSecurityCode.STRING_PIPE_TO_SHELL)
    })

    it('denies /usr/local/bin/bash -c', () => {
      const a = validateBashCommand('/usr/local/bin/bash -c ls')
      expect(a.verdict).toBe('deny')
      expect(a.codes).toContain(BashSecurityCode.STRING_PIPE_TO_SHELL)
    })

    it('denies eval with single-quoted string', () => {
      const a = validateBashCommand("eval 'rm -rf /'")
      expect(a.verdict).toBe('deny')
      expect(a.codes).toContain(BashSecurityCode.STRING_EVAL_SOURCE)
    })

    it('denies eval with double-quoted string', () => {
      const a = validateBashCommand('eval "echo hi"')
      expect(a.verdict).toBe('deny')
      expect(a.codes).toContain(BashSecurityCode.STRING_EVAL_SOURCE)
    })

    it('commandBaseName extracts basename from absolute path', () => {
      const parts = analyzeCommand('/bin/rm -rf /')
      expect(parts[0].commandName).toBe('/bin/rm')
      expect(parts[0].commandBaseName).toBe('rm')
    })

    it('commandBaseName returns raw name when no slash', () => {
      const parts = analyzeCommand('ls -la')
      expect(parts[0].commandName).toBe('ls')
      expect(parts[0].commandBaseName).toBe('ls')
    })
  })

  describe('OpenClaude-class parity (subset)', () => {
    it('denies process substitution <(', () => {
      const a = validateBashCommand('echo <(date)')
      expect(a.verdict).toBe('deny')
      expect(a.codes).toContain(BashSecurityCode.OC_SHELL_METASYNTAX)
    })

    it('denies zmodload (Zsh dangerous builtin)', () => {
      const a = validateBashCommand('zmodload zsh/system')
      expect(a.verdict).toBe('deny')
      expect(a.codes).toContain(BashSecurityCode.OC_ZSH_DANGEROUS_BUILTIN)
    })

    it('denies rmdir on dangerous path (root / drive)', () => {
      if (process.platform === 'win32') {
        const a = validateBashCommand('rmdir C:\\', { cwd: 'C:\\' })
        expect(a.verdict).toBe('deny')
        expect(a.codes).toContain(BashSecurityCode.PATH_DANGEROUS_TARGET)
      } else {
        const a = validateBashCommand('rmdir /', { cwd: '/' })
        expect(a.verdict).toBe('deny')
        expect(a.codes).toContain(BashSecurityCode.PATH_DANGEROUS_TARGET)
      }
    })

    it('denies jq with system() call', () => {
      const a = validateBashCommand(`jq -n 'system("id")'`)
      expect(a.verdict).toBe('deny')
      expect(a.codes).toContain(BashSecurityCode.JQ_SYSTEM)
    })

    it('warns on sed -i (in-place)', () => {
      const a = validateBashCommand("sed -i '' 's/a/b/' x.txt")
      expect(a.verdict).toBe('warn')
      expect(a.codes).toContain(BashSecurityCode.SED_INPLACE)
    })

    it('adds destructive hint for git reset --hard', () => {
      const a = validateBashCommand('git reset --hard')
      expect(a.codes).toContain(BashSecurityCode.DESTRUCTIVE_PATTERN_HINT)
      expect(a.reasons.some((r) => r.includes('uncommitted'))).toBe(true)
    })
  })
})
