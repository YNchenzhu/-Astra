import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import AdmZip from 'adm-zip'
import { readMcpbMcpServersRecord } from './mcpbBundle'

describe('mcpbBundle', () => {
  it('extracts mcpServers from zip manifest.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-mcpb-'))
    const bundlePath = path.join(dir, 'test.mcpb')
    const zip = new AdmZip()
    zip.addFile(
      'manifest.json',
      Buffer.from(
        JSON.stringify({
          mcpServers: {
            z: { command: 'echo', args: ['hi'] },
          },
        }),
        'utf8',
      ),
    )
    zip.writeZip(bundlePath)

    const r = readMcpbMcpServersRecord(bundlePath)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.pickedEntry).toMatch(/manifest\.json$/i)
      expect(typeof r.mcpServers).toBe('object')
    }
  })

  it('rejects missing file', () => {
    const r = readMcpbMcpServersRecord(path.join(os.tmpdir(), 'nope-not-there.mcpb'))
    expect(r.ok).toBe(false)
  })
})
