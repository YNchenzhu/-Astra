import fs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  encodePowerShellCommand,
  getToolShellSpawnSpec,
  looksLikePosixPipeline,
  looksLikePosixShellOneShot,
  looksLikePosixUtilityInvocation,
  parseDefaultShell,
} from './defaultShellSpawn'

describe('parseDefaultShell', () => {
  it('accepts valid ids', () => {
    expect(parseDefaultShell('cmd')).toBe('cmd')
    expect(parseDefaultShell('zsh')).toBe('zsh')
  })

  it('falls back for unknown', () => {
    const v = parseDefaultShell('nope')
    expect(['bash', 'powershell']).toContain(v)
  })
})

describe('looksLikePosixShellOneShot', () => {
  it('is false for empty or plain cmd', () => {
    expect(looksLikePosixShellOneShot('')).toBe(false)
    expect(looksLikePosixShellOneShot('dir /b')).toBe(false)
    expect(looksLikePosixShellOneShot('echo hi')).toBe(false)
  })

  it('detects POSIX patterns', () => {
    expect(looksLikePosixShellOneShot('echo $(date)')).toBe(true)
    expect(looksLikePosixShellOneShot('echo `whoami`')).toBe(true)
    expect(looksLikePosixShellOneShot('[[ -f x ]] && echo y')).toBe(true)
    expect(looksLikePosixShellOneShot("export FOO=bar\necho ok")).toBe(true)
    expect(looksLikePosixShellOneShot('cat <<EOF\nx\nEOF')).toBe(true)
  })

  it('detects `&&` and `||` chain operators (PowerShell 5.1 rejects these)', () => {
    // Regression: the bundled `powershell.exe` on Windows is PS 5.1 which
    // parses `&&` / `||` as errors. If we route such a command to PS we get
    // a mojibake'd parser error. Always prefer Git Bash when present.
    expect(looksLikePosixShellOneShot('cd foo && python -c "print(1)"')).toBe(true)
    expect(looksLikePosixShellOneShot('npm run build && npm test')).toBe(true)
    expect(looksLikePosixShellOneShot('false || echo fallback')).toBe(true)
  })

  it('does NOT mistake a single `&` (background op) for `&&`', () => {
    expect(looksLikePosixShellOneShot('long_task &')).toBe(false)
    expect(looksLikePosixShellOneShot('echo hi & echo bye')).toBe(false)
  })
})

describe('looksLikePosixPipeline', () => {
  it('detects pipes to Unix utilities and GNU find', () => {
    expect(looksLikePosixPipeline('find . -name "*.ts" | head -20')).toBe(true)
    expect(looksLikePosixPipeline('grep -r foo . | tail -5')).toBe(true)
    expect(looksLikePosixPipeline('find G:/x -not -path "*/node_modules/*"')).toBe(true)
    expect(looksLikePosixPipeline('echo hi')).toBe(false)
  })

  it('detects common grep flags beyond the original r/R/l/L/c/i set', () => {
    // Regression: `grep -n "pattern" file.ts` used to slip through the
    // heuristic and get routed to PowerShell, where it failed with
    // "grep is not a cmdlet".
    expect(looksLikePosixPipeline('grep -n "delete_chapter" src/core/config.py')).toBe(true)
    expect(looksLikePosixPipeline('grep -E "foo|bar" file')).toBe(true)
    expect(looksLikePosixPipeline('grep -A 3 needle haystack')).toBe(true)
    expect(looksLikePosixPipeline('grep -B 2 needle haystack')).toBe(true)
    expect(looksLikePosixPipeline('grep --line-number needle file')).toBe(true)
  })

  it('detects pipes into grep/wc/sort/uniq/cut/tr/tee', () => {
    expect(looksLikePosixPipeline('ls | grep foo')).toBe(true)
    expect(looksLikePosixPipeline('cat file | wc -l')).toBe(true)
    expect(looksLikePosixPipeline('ls | sort -u')).toBe(true)
    expect(looksLikePosixPipeline('cat x | uniq')).toBe(true)
    expect(looksLikePosixPipeline('cat x | cut -d: -f1')).toBe(true)
    expect(looksLikePosixPipeline('echo HI | tr A-Z a-z')).toBe(true)
    expect(looksLikePosixPipeline('echo hi | tee out.txt')).toBe(true)
  })
})

describe('looksLikePosixUtilityInvocation', () => {
  it('flags bare POSIX utilities as needing a POSIX userland', () => {
    // The core regression: Windows default shell = PowerShell. Without this
    // check, `grep -n "x" file` routes to powershell.exe which cannot resolve
    // `grep` at all. We now detect it up front and route via Git Bash.
    expect(looksLikePosixUtilityInvocation('grep -n "foo" file.ts')).toBe(true)
    expect(looksLikePosixUtilityInvocation('awk \'{print $1}\' file')).toBe(true)
    expect(looksLikePosixUtilityInvocation('sed -n \'1,10p\' file')).toBe(true)
    expect(looksLikePosixUtilityInvocation('head -5 file')).toBe(true)
    expect(looksLikePosixUtilityInvocation('tail -n 20 file')).toBe(true)
    expect(looksLikePosixUtilityInvocation('wc -l file')).toBe(true)
    expect(looksLikePosixUtilityInvocation('sort file')).toBe(true)
    expect(looksLikePosixUtilityInvocation('uniq file')).toBe(true)
    expect(looksLikePosixUtilityInvocation('cut -d: -f1 /etc/passwd')).toBe(true)
    expect(looksLikePosixUtilityInvocation('tr A-Z a-z')).toBe(true)
    expect(looksLikePosixUtilityInvocation('xargs echo')).toBe(true)
    expect(looksLikePosixUtilityInvocation('rg TODO')).toBe(true)
    expect(looksLikePosixUtilityInvocation('which node')).toBe(true)
  })

  it('accepts absolute paths to POSIX utilities (/usr/bin/grep …)', () => {
    expect(looksLikePosixUtilityInvocation('/usr/bin/grep foo file')).toBe(true)
    expect(looksLikePosixUtilityInvocation('/bin/awk "{print}" file')).toBe(true)
  })

  it('does NOT flag plain Windows or shell-neutral commands', () => {
    expect(looksLikePosixUtilityInvocation('echo hi')).toBe(false)
    expect(looksLikePosixUtilityInvocation('dir /b')).toBe(false)
    expect(looksLikePosixUtilityInvocation('npm run build')).toBe(false)
    expect(looksLikePosixUtilityInvocation('node scripts/x.js')).toBe(false)
  })

  it('does NOT flag `find` or `cat` alone (ambiguous with Windows/PS built-ins)', () => {
    // `find` on Windows is find.exe (syntactically different); `cat` is a
    // PowerShell alias for Get-Content. Users rely on those resolving natively
    // unless paired with GNU flags (picked up by looksLikePosixPipeline).
    expect(looksLikePosixUtilityInvocation('find "needle" file.txt')).toBe(false)
    expect(looksLikePosixUtilityInvocation('cat file.txt')).toBe(false)
  })

  it('ignores lines starting with a non-utility command', () => {
    expect(looksLikePosixUtilityInvocation('echo hi ; grep foo bar')).toBe(false)
    expect(looksLikePosixUtilityInvocation('npm test && grep foo bar')).toBe(false)
  })

  it('tolerates leading whitespace and is case-insensitive for tool names', () => {
    expect(looksLikePosixUtilityInvocation('   grep -n "x" file')).toBe(true)
    expect(looksLikePosixUtilityInvocation('GREP -n "x" file')).toBe(true)
  })
})

describe('encodePowerShellCommand', () => {
  it('produces a stable base64 of UTF-16-LE bytes', () => {
    // Empty string encodes to empty base64.
    expect(encodePowerShellCommand('')).toBe('')
    // "hi" → UTF-16-LE is 68 00 69 00 → base64 aABpAA==
    expect(encodePowerShellCommand('hi')).toBe('aABpAA==')
  })

  it('round-trips losslessly via Buffer.from(base64, utf16le)', () => {
    const script = 'Select-String -Path src/**.ts -Pattern "foo" | ForEach-Object { $_.LineNumber }'
    const encoded = encodePowerShellCommand(script)
    const decoded = Buffer.from(encoded, 'base64').toString('utf16le')
    expect(decoded).toBe(script)
  })

  it('preserves `$_` through encoding (the core regression)', () => {
    const script = '1..3 | ForEach-Object { $_ * 2 }'
    const decoded = Buffer.from(encodePowerShellCommand(script), 'base64').toString('utf16le')
    expect(decoded).toContain('$_')
    expect(decoded.indexOf('$_')).toBeGreaterThan(-1)
  })

  it('preserves Chinese / wide characters', () => {
    const script = 'Write-Host "你好，世界"'
    const decoded = Buffer.from(encodePowerShellCommand(script), 'base64').toString('utf16le')
    expect(decoded).toBe(script)
  })
})

describe('getToolShellSpawnSpec', () => {
  it('routes Windows cmd + POSIX-looking command to Git Bash when installed', () => {
    const orig = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const spy = vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    try {
      const spec = getToolShellSpawnSpec('cmd', 'echo $(echo hi)')
      expect(spec.file).toMatch(/bash\.exe$/i)
      expect(spec.args).toEqual(['-lc', 'echo $(echo hi)'])
    } finally {
      spy.mockRestore()
      Object.defineProperty(process, 'platform', { value: orig, configurable: true })
    }
  })

  it('uses cmd with chcp wrapper on Windows', () => {
    if (process.platform !== 'win32') return
    const spec = getToolShellSpawnSpec('cmd', 'echo hi')
    expect(spec.file.toLowerCase()).toMatch(/cmd\.exe$/)
    expect(spec.args[0]).toBe('/d')
    expect(spec.args[1]).toBe('/s')
    expect(spec.args[2]).toBe('/c')
    expect(spec.args[3]).toContain('chcp 65001')
    expect(spec.args[3]).toContain('echo hi')
  })

  it('routes Windows PowerShell + | head to Git Bash when installed', () => {
    const orig = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const spy = vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    try {
      const spec = getToolShellSpawnSpec('powershell', 'find . -name "*.ts" | head -20')
      expect(spec.file).toMatch(/bash\.exe$/i)
      expect(spec.args[0]).toBe('-lc')
      expect(spec.args[1]).toContain('head')
    } finally {
      spy.mockRestore()
      Object.defineProperty(process, 'platform', { value: orig, configurable: true })
    }
  })

  it('routes bare `grep -n ...` to Git Bash when installed (regression)', () => {
    // Was failing: `grep -n` lacked r/R/l/L/c/i, slipped through, ended up
    // in PowerShell as `grep -n ...` → "grep is not a cmdlet".
    const orig = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const spy = vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    try {
      const spec = getToolShellSpawnSpec('powershell', 'grep -n "delete_chapter" src/core/config.py')
      expect(spec.file).toMatch(/bash\.exe$/i)
      expect(spec.args[0]).toBe('-lc')
      expect(spec.args[1]).toContain('grep -n')
    } finally {
      spy.mockRestore()
      Object.defineProperty(process, 'platform', { value: orig, configurable: true })
    }
  })

  it('routes `cd foo && python ...` chains to Git Bash (PS 5.1 cannot parse `&&`)', () => {
    const orig = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const spy = vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    try {
      const spec = getToolShellSpawnSpec(
        'powershell',
        'cd G:\\workspace-code\\projects\\book-deconstruction && python -c "print(1)"',
      )
      expect(spec.file).toMatch(/bash\.exe$/i)
      expect(spec.args[0]).toBe('-lc')
      expect(spec.args[1]).toContain('&&')
    } finally {
      spy.mockRestore()
      Object.defineProperty(process, 'platform', { value: orig, configurable: true })
    }
  })

  it('routes bare `awk` / `sed` invocations to Git Bash when installed', () => {
    const orig = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const spy = vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    try {
      for (const cmd of ['awk \'{print $1}\' file', 'sed -n \'1,5p\' file']) {
        const spec = getToolShellSpawnSpec('powershell', cmd)
        expect(spec.file).toMatch(/bash\.exe$/i)
        expect(spec.args[0]).toBe('-lc')
      }
    } finally {
      spy.mockRestore()
      Object.defineProperty(process, 'platform', { value: orig, configurable: true })
    }
  })

  it('uses `-EncodedCommand` (not `-Command`) when falling back to PowerShell', () => {
    // Guarantees PS never receives the script via double-quoted command-line,
    // which is what stripped `$_` on the previous code path.
    const orig = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const spy = vi.spyOn(fs, 'existsSync').mockReturnValue(false) // No Git Bash
    try {
      const spec = getToolShellSpawnSpec(
        'powershell',
        'Get-Process | ForEach-Object { $_.Id }',
      )
      expect(spec.file).toMatch(/powershell\.exe$/i)
      expect(spec.args).toContain('-EncodedCommand')
      expect(spec.args).not.toContain('-Command')
      // Decode back and verify `$_` survived.
      const b64 = spec.args[spec.args.indexOf('-EncodedCommand') + 1]
      const decoded = Buffer.from(b64, 'base64').toString('utf16le')
      expect(decoded).toContain('$_.Id')
    } finally {
      spy.mockRestore()
      Object.defineProperty(process, 'platform', { value: orig, configurable: true })
    }
  })

  it('cmd default still falls through to cmd.exe for non-POSIX commands', () => {
    const orig = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const spy = vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    try {
      const spec = getToolShellSpawnSpec('cmd', 'dir /b')
      expect(spec.file.toLowerCase()).toMatch(/cmd\.exe$/)
      expect(spec.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    } finally {
      spy.mockRestore()
      Object.defineProperty(process, 'platform', { value: orig, configurable: true })
    }
  })

  it('uses login bash on Unix', () => {
    if (process.platform === 'win32') return
    const spec = getToolShellSpawnSpec('bash', 'true')
    expect(spec.args[0]).toBe('-lc')
    expect(spec.args[1]).toBe('true')
  })
})
