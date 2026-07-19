import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import AdmZip from 'adm-zip'
import {
  addPluginScopeToServerName,
  resolvePluginMcpEnvironment,
  loadDotMcpJson,
  loadPluginManifestMcpServers,
} from './pluginMcpIntegration'

describe('pluginMcpIntegration', () => {
  it('addPluginScopeToServerName escapes colons', () => {
    expect(addPluginScopeToServerName('p', 'srv')).toBe('plugin:p:srv')
  })

  it('resolvePluginMcpEnvironment expands plugin root and user_config', () => {
    expect(
      resolvePluginMcpEnvironment('${ASTRA_PLUGIN_ROOT}/x', {
        pluginRoot: '/tmp/p',
        userConfig: { K: 'uv' },
        processEnv: { PATH: '/bin' },
      }),
    ).toBe('/tmp/p/x')
    expect(
      resolvePluginMcpEnvironment('${CLAUDE_PLUGIN_ROOT}/y', {
        pluginRoot: '/tmp/p',
        userConfig: {},
        processEnv: {},
      }),
    ).toBe('/tmp/p/y')
    expect(
      resolvePluginMcpEnvironment('${user_config.K}', {
        pluginRoot: '/tmp/p',
        userConfig: { K: 'uv' },
        processEnv: {},
      }),
    ).toBe('uv')
    expect(
      resolvePluginMcpEnvironment('${PATH}', {
        pluginRoot: '/tmp/p',
        userConfig: {},
        processEnv: { PATH: '/bin' },
      }),
    ).toBe('/bin')
  })

  it('loadDotMcpJson reads mcpServers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-mcp-int-'))
    fs.writeFileSync(
      path.join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          fs: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
          },
        },
      }),
      'utf8',
    )
    const { entries, issues } = loadDotMcpJson(dir, {}, process.env)
    expect(issues.length).toBe(0)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.config.name).toBe('fs')
    expect(entries[0]!.source).toBe('dot_mcp_json')
  })

  it('loadPluginManifestMcpServers reads plugin.json mcpServers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-mcp-plug-'))
    const plugDir = path.join(dir, '.claude', 'plugins', 'demo')
    fs.mkdirSync(plugDir, { recursive: true })
    fs.writeFileSync(
      path.join(plugDir, 'plugin.json'),
      JSON.stringify({
        name: 'demo',
        mcpServers: {
          echo: { command: 'echo', args: [] },
        },
      }),
      'utf8',
    )
    const { entries, issues } = loadPluginManifestMcpServers(dir, {}, process.env)
    expect(issues.length).toBe(0)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.config.name).toBe('plugin:demo:echo')
    expect(entries[0]!.pluginId).toBe('demo')
  })

  it('loadPluginManifestMcpServers reads .mcpb bundle reference', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-mcp-mcpb-'))
    const plugDir = path.join(dir, '.claude', 'plugins', 'bund')
    fs.mkdirSync(plugDir, { recursive: true })
    const bundlePath = path.join(plugDir, 'srv.mcpb')
    const zip = new AdmZip()
    zip.addFile(
      'manifest.json',
      Buffer.from(
        JSON.stringify({
          mcpServers: {
            z: { command: 'node', args: ['-e', '0'] },
          },
        }),
        'utf8',
      ),
    )
    zip.writeZip(bundlePath)
    fs.writeFileSync(
      path.join(plugDir, 'plugin.json'),
      JSON.stringify({ name: 'bund', mcpServers: 'srv.mcpb' }),
      'utf8',
    )
    const { entries, issues } = loadPluginManifestMcpServers(dir, {}, process.env)
    expect(issues.length).toBe(0)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.config.name).toBe('plugin:bund:z')
  })
})
