/**
 * Regression tests for the 2026-07 tool-subsystem audit fixes (B-P0-1…B-P0-4):
 *   1. single-level `$(...)` bodies get hard-deny scans
 *   2. wrapper binaries (`command`/`env`/`busybox`/`xargs`/`sudo`) can't smuggle blacklisted binaries
 *   3. `find -delete` / `find -exec rm` and destructive inline interpreter payloads deny
 *   4. `cd` is simulated so path checks see the segment's real cwd
 */

import { describe, expect, it } from 'vitest'
import { validateBashCommand } from './validateBashCommand'
import { BashSecurityCode as BC } from './bashCodes'

describe('B-P0-1 — single-level command substitution bodies are scanned', () => {
  it('denies echo $(rm -rf /)', () => {
    const r = validateBashCommand('echo $(rm -rf /)')
    expect(r.verdict).toBe('deny')
    expect(r.codes).toContain(BC.DANGEROUS_COMMAND)
  })

  it('denies touch $(dd if=/dev/zero of=/dev/sda)', () => {
    const r = validateBashCommand('touch $(dd if=/dev/zero of=/dev/sda)')
    expect(r.verdict).toBe('deny')
  })

  it('still allows benign substitution: git checkout $(git rev-parse HEAD)', () => {
    const r = validateBashCommand('git checkout $(git rev-parse HEAD)')
    expect(r.verdict).not.toBe('deny')
  })

  it('still allows echo $(date)', () => {
    const r = validateBashCommand('echo $(date)')
    expect(r.verdict).toBe('allow')
  })
})

describe('B-P0-2 — wrapper prefixes cannot bypass the blacklist', () => {
  it.each([
    'command rm -rf /',
    'env rm -rf /tmp/important',
    'busybox rm -rf /',
    'nohup rm -rf /var 2>/dev/null',
    'sudo rm -rf /etc',
    'timeout 5 rm -rf .',
  ])('denies %s', (cmd) => {
    const r = validateBashCommand(cmd)
    expect(r.verdict).toBe('deny')
    expect(r.codes).toContain(BC.WRAPPED_DANGEROUS_COMMAND)
  })

  it('denies pipe into xargs rm', () => {
    const r = validateBashCommand('git ls-files | xargs rm')
    expect(r.verdict).toBe('deny')
    expect(r.codes).toContain(BC.WRAPPED_DANGEROUS_COMMAND)
  })

  it('allows command -v rm (existence lookup)', () => {
    const r = validateBashCommand('command -v rm')
    expect(r.verdict).not.toBe('deny')
  })

  it('keeps sudo apt install as a warn, not a deny', () => {
    const r = validateBashCommand('sudo apt install jq')
    expect(r.verdict).toBe('warn')
  })
})

describe('B-P0-3 — find/-delete and destructive inline interpreters', () => {
  it('denies find . -delete', () => {
    const r = validateBashCommand('find . -delete')
    expect(r.verdict).toBe('deny')
    expect(r.codes).toContain(BC.FIND_DESTRUCTIVE)
  })

  it('denies find . -name "*.log" -exec rm {} \\;', () => {
    const r = validateBashCommand('find . -name "*.log" -exec rm {} \\;')
    expect(r.verdict).toBe('deny')
    expect(r.codes).toContain(BC.FIND_DESTRUCTIVE)
  })

  it('allows find . -name "*.ts" -exec grep -l foo {} \\;', () => {
    const r = validateBashCommand('find . -name "*.ts" -exec grep -l foo {} \\;')
    expect(r.verdict).not.toBe('deny')
  })

  it('denies python -c with shutil.rmtree', () => {
    const r = validateBashCommand(`python -c "import shutil; shutil.rmtree('/')"`)
    expect(r.verdict).toBe('deny')
    expect(r.codes).toContain(BC.INLINE_INTERPRETER_DESTRUCTIVE)
  })

  it('denies node -e with fs.rmSync', () => {
    const r = validateBashCommand(
      `node -e "require('fs').rmSync('/',{recursive:true,force:true})"`,
    )
    expect(r.verdict).toBe('deny')
    expect(r.codes).toContain(BC.INLINE_INTERPRETER_DESTRUCTIVE)
  })

  it('denies perl -e with unlink glob', () => {
    const r = validateBashCommand(`perl -e 'unlink glob "/tmp/*"'`)
    expect(r.verdict).toBe('deny')
    expect(r.codes).toContain(BC.INLINE_INTERPRETER_DESTRUCTIVE)
  })

  it('does not deny a benign python -c print', () => {
    const r = validateBashCommand(`python -c "print('hello')"`)
    expect(r.codes).not.toContain(BC.INLINE_INTERPRETER_DESTRUCTIVE)
    expect(r.verdict).not.toBe('deny')
  })
})

describe('B-P0-4 — cd is simulated for path danger checks', () => {
  it('denies cd / && rmdir important_dir (resolves against /)', () => {
    const r = validateBashCommand('cd / && rmdir important_dir', {
      cwd: 'C:/work/project',
    })
    expect(r.verdict).toBe('deny')
    expect(r.codes).toContain(BC.PATH_DANGEROUS_TARGET)
  })

  it('still allows rmdir of a nested relative dir in the workspace', () => {
    const r = validateBashCommand('rmdir build/tmp/cache-dir', {
      cwd: 'C:/work/project',
    })
    expect(r.codes).not.toContain(BC.PATH_DANGEROUS_TARGET)
  })

  it('does not resolve relative targets against a stale cwd after dynamic cd', () => {
    // `cd $DIR` makes the cwd statically unknown — the relative rmdir target
    // must be skipped (not resolved against the initial cwd), and the $DIR
    // expansion itself already trips the sensitive-expansion checks upstream.
    const r = validateBashCommand('cd "$DIR" && rmdir sub', { cwd: 'C:/work/project' })
    // No PATH_DANGEROUS_TARGET false-positive from resolving `sub` against C:/work/project.
    expect(r.codes).not.toContain(BC.PATH_DANGEROUS_TARGET)
  })
})
