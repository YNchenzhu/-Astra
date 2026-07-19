import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MCPClientManager } from './client'

describe('MCP system', () => {
  describe('server status type', () => {
    it('should cover all 6 states', () => {
      const statuses: Array<
        'unconfigured' | 'ready' | 'connecting' | 'connected' | 'error' | 'disconnected'
      > = [
        'unconfigured',
        'ready',
        'connecting',
        'connected',
        'error',
        'disconnected',
      ]
      expect(statuses).toHaveLength(6)
    })
  })

  describe('MCPClientManager persistence', () => {
    let tmp: string
    let configPath: string

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'))
      configPath = path.join(tmp, 'mcp-servers.json')
    })

    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true })
    })

    it('mergeServerConfigIntoFile keeps other saved servers when one connects', async () => {
      const m = new MCPClientManager(configPath)
      fs.writeFileSync(
        configPath,
        JSON.stringify(
          [
            { name: 'a', transport: 'stdio', command: 'npx', args: ['-y', 'pkg-a'] },
            { name: 'b', transport: 'stdio', command: 'npx', args: ['-y', 'pkg-b'] },
          ],
          null,
          2,
        ),
      )

      await m.mergeServerConfigIntoFile({
        name: 'a',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'pkg-a'],
        lastConnectedAt: 123,
        resourceCount: 2,
      })

      const list = m.loadConfigs()
      expect(list).toHaveLength(2)
      expect(list.find((c) => c.name === 'a')?.lastConnectedAt).toBe(123)
      expect(list.find((c) => c.name === 'a')?.resourceCount).toBe(2)
      expect(list.find((c) => c.name === 'b')?.args).toEqual(['-y', 'pkg-b'])
    })

    it('listServersDetailed reports disconnected rows from file', () => {
      const m = new MCPClientManager(configPath)
      fs.writeFileSync(
        configPath,
        JSON.stringify(
          [{ name: 'x', transport: 'sse', command: '', args: [], url: 'http://x', lastError: 'boom' }],
          null,
          2,
        ),
      )
      const rows = m.listServersDetailed()
      expect(rows).toHaveLength(1)
      expect(rows[0].connected).toBe(false)
      expect(rows[0].status).toBe('error')
      expect(rows[0].lastError).toBe('boom')
    })
  })
})
