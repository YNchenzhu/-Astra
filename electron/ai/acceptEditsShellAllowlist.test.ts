import { describe, it, expect } from 'vitest'
import {
  firstShellSegment,
  isAcceptEditsFilesystemShellCommand,
  posixLeadingCommandName,
  powershellLeadingCommandName,
} from './acceptEditsShellAllowlist'

describe('acceptEditsShellAllowlist', () => {
  it('firstShellSegment stops at && and ;', () => {
    expect(firstShellSegment('mkdir a && curl b')).toBe('mkdir a')
    expect(firstShellSegment('touch x; rm y')).toBe('touch x')
  })

  it('posix: allows report §5.1 examples', () => {
    expect(isAcceptEditsFilesystemShellCommand('mkdir -p dist', 'posix')).toBe(true)
    expect(isAcceptEditsFilesystemShellCommand('touch a.txt', 'posix')).toBe(true)
    expect(isAcceptEditsFilesystemShellCommand('rm -f x', 'posix')).toBe(true)
    expect(isAcceptEditsFilesystemShellCommand(`sed -i '' 's/a/b/' f`, 'posix')).toBe(true)
    expect(isAcceptEditsFilesystemShellCommand('tee out.log', 'posix')).toBe(true)
    expect(isAcceptEditsFilesystemShellCommand('patch -p1 < fix.diff', 'posix')).toBe(true)
  })

  it('posix: skips sudo / env prefix', () => {
    expect(isAcceptEditsFilesystemShellCommand('sudo mkdir foo', 'posix')).toBe(true)
    expect(isAcceptEditsFilesystemShellCommand('env VAR=1 mkdir foo', 'posix')).toBe(true)
  })

  it('posix: rejects non-filesystem commands', () => {
    expect(isAcceptEditsFilesystemShellCommand('curl https://x', 'posix')).toBe(false)
    expect(isAcceptEditsFilesystemShellCommand('git status', 'posix')).toBe(false)
  })

  it('posixLeadingCommandName strips .exe basename', () => {
    expect(posixLeadingCommandName('mkdir.exe foo')).toBe('mkdir')
  })

  it('powershell: New-Item / Remove-Item / mkdir', () => {
    expect(isAcceptEditsFilesystemShellCommand('mkdir tmp', 'powershell')).toBe(true)
    expect(isAcceptEditsFilesystemShellCommand('New-Item -ItemType Directory x', 'powershell')).toBe(
      true,
    )
    expect(isAcceptEditsFilesystemShellCommand('Out-File -FilePath x.txt -InputObject a', 'powershell')).toBe(
      true,
    )
    expect(isAcceptEditsFilesystemShellCommand('Rename-Item a b', 'powershell')).toBe(true)
    expect(isAcceptEditsFilesystemShellCommand('Remove-Item -Recurse z', 'powershell')).toBe(true)
  })

  it('powershell: rejects Invoke-WebRequest', () => {
    expect(isAcceptEditsFilesystemShellCommand('Invoke-WebRequest https://x', 'powershell')).toBe(
      false,
    )
  })

  it('powershellLeadingCommandName skips leading &', () => {
    expect(powershellLeadingCommandName('& mkdir a')).toBe('mkdir')
  })
})
