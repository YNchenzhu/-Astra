import { describe, it, expect } from 'vitest'
import { parseNpxMcpArgs } from './npxArgs'

describe('parseNpxMcpArgs', () => {
  it('parses -y then scoped package and forwards path args', () => {
    expect(
      parseNpxMcpArgs(['-y', '@modelcontextprotocol/server-filesystem', 'C:\\workspace']),
    ).toEqual({
      pkgName: '@modelcontextprotocol/server-filesystem',
      forwardedArgs: ['C:\\workspace'],
    })
  })

  it('parses package without -y', () => {
    expect(parseNpxMcpArgs(['some-pkg', '--foo'])).toEqual({
      pkgName: 'some-pkg',
      forwardedArgs: ['--foo'],
    })
  })

  it('parses fetch preset package name for packaged npx rewrite', () => {
    expect(parseNpxMcpArgs(['-y', 'mcp-server-fetch-typescript'])).toEqual({
      pkgName: 'mcp-server-fetch-typescript',
      forwardedArgs: [],
    })
  })

  it('returns null when only flags', () => {
    expect(parseNpxMcpArgs(['-y', '--yes'])).toBeNull()
  })

  it('parses mcp-remote with URL forwarded for Vercel preset', () => {
    expect(parseNpxMcpArgs(['-y', 'mcp-remote', 'https://mcp.vercel.com'])).toEqual({
      pkgName: 'mcp-remote',
      forwardedArgs: ['https://mcp.vercel.com'],
    })
  })
})
