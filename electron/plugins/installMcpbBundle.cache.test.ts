import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import AdmZip from 'adm-zip'
import { copyMcpbToPluginCache } from './installMcpbBundle'
import { getPluginBundleCacheRoot } from './pluginBundlePaths'

describe('copyMcpbToPluginCache', () => {
  it('copies bundle into userData plugin-cache/bundles', () => {
    const tmpUser = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-plugin-cache-'))
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-mcpb-src-'))
    const src = path.join(srcDir, 'x.mcpb')
    const zip = new AdmZip()
    zip.addFile('manifest.json', Buffer.from(JSON.stringify({ mcpServers: {} }), 'utf8'))
    zip.writeZip(src)

    const r = copyMcpbToPluginCache(tmpUser, src)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(fs.existsSync(r.cachePath)).toBe(true)
    expect(r.cachePath.startsWith(getPluginBundleCacheRoot(tmpUser))).toBe(true)
  })
})
