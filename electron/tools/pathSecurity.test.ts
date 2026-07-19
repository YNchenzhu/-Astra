import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  validateToolPath,
  isPathForbidden,
  isPathWithinWorkspace,
  isSensitiveFile,
  realResolveAbsolutePath,
} from './pathSecurity'

describe('pathSecurity', () => {
  describe('validateToolPath', () => {
    it('denies forbidden system paths on POSIX', () => {
      if (process.platform === 'win32') return
      const r = validateToolPath('/etc/passwd', 'read', '/tmp/proj')
      expect(r.verdict).toBe('deny')
      expect(r.isForbidden).toBe(true)
    })

    it('denies typical Windows system roots when path matches blocklist', () => {
      if (process.platform !== 'win32') return
      const r = validateToolPath('C:\\Windows\\System32\\config\\SAM', 'read', 'C:\\workspace')
      expect(r.verdict).toBe('deny')
      expect(r.isForbidden).toBe(true)
    })

    it('denies write outside workspace when workspace is set', () => {
      const ws = path.join(os.tmpdir(), `pole-ws-${Date.now()}`)
      fs.mkdirSync(ws, { recursive: true })
      try {
        const outside = path.join(os.tmpdir(), `outside-${Date.now()}.txt`)
        const r = validateToolPath(outside, 'write', ws)
        expect(r.verdict).toBe('deny')
        expect(r.isWithinWorkspace).toBe(false)
      } finally {
        fs.rmSync(ws, { recursive: true, force: true })
      }
    })

    it('allows read inside workspace', () => {
      const ws = path.join(os.tmpdir(), `pole-ws-in-${Date.now()}`)
      fs.mkdirSync(ws, { recursive: true })
      const inner = path.join(ws, 'file.txt')
      fs.writeFileSync(inner, 'x')
      try {
        const r = validateToolPath(inner, 'read', ws)
        expect(r.verdict).toBe('allow')
        expect(r.isWithinWorkspace).toBe(true)
      } finally {
        fs.rmSync(ws, { recursive: true, force: true })
      }
    })

    it('detects sensitive filenames for write', () => {
      const ws = path.join(os.tmpdir(), `pole-ws-env-${Date.now()}`)
      fs.mkdirSync(ws, { recursive: true })
      const envFile = path.join(ws, '.env')
      try {
        const r = validateToolPath(envFile, 'write', ws)
        expect(r.isSensitive).toBe(true)
        expect(r.verdict).toBe('warn')
      } finally {
        fs.rmSync(ws, { recursive: true, force: true })
      }
    })
  })

  describe('realResolveAbsolutePath and symlink', () => {
    let workspace: string
    let outsideFile: string

    beforeAll(() => {
      workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-sym-ws-'))
      outsideFile = path.join(os.tmpdir(), `pole-secret-${Date.now()}.txt`)
      fs.writeFileSync(outsideFile, 'secret')
    })

    afterAll(() => {
      try {
        fs.rmSync(workspace, { recursive: true, force: true })
      } catch {
        // ignore
      }
      try {
        fs.unlinkSync(outsideFile)
      } catch {
        // ignore
      }
    })

    it('resolves symlink to real path for traversal checks', () => {
      const linkPath = path.join(workspace, 'link-out')
      try {
        fs.symlinkSync(outsideFile, linkPath)
      } catch {
        return
      }
      const normalized = realResolveAbsolutePath(linkPath)
      expect(fs.existsSync(normalized)).toBe(true)
      expect(isPathWithinWorkspace(normalized, workspace)).toBe(false)
    })
  })

  describe('helpers', () => {
    it('isPathForbidden matches passwd on Unix', () => {
      if (process.platform === 'win32') return
      expect(isPathForbidden('/etc/passwd').forbidden).toBe(true)
    })

    it('isSensitiveFile matches .env basename', () => {
      expect(isSensitiveFile('/tmp/.env')).toBe(true)
    })
  })
})
