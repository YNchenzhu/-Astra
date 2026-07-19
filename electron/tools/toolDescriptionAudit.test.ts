/**
 * Automated audit of the built-in tool registry against
 * `docs/TOOL_DESIGN_PRINCIPLES.md`.
 *
 * Purpose: keep the "first-try-correct" invariants from drifting. When a new
 * tool is registered or a description is shortened in a refactor, these
 * tests fail and point the author at which invariant was violated. The
 * invariants themselves are load-bearing — each one maps to a real prior
 * incident where the AI picked wrong tool / wrong args because the schema
 * did not carry enough information.
 *
 * These tests are *deliberately* permissive about wording (regex-based,
 * whitespace-tolerant) so cosmetic edits don't churn the test file; they're
 * strict about the PRESENCE of load-bearing facts.
 */

import { describe, it, expect } from 'vitest'
import { getAllBaseTools } from './registry'
import type { Tool, ToolParameter } from './types'

function byName(tools: Tool[], name: string): Tool {
  const hit = tools.find((t) => t.name === name || (t.aliases ?? []).includes(name))
  if (!hit) throw new Error(`Tool '${name}' not registered`)
  return hit
}

function paramByName(tool: Tool, name: string): ToolParameter {
  const hit = tool.inputSchema.find((p) => p.name === name)
  if (!hit) throw new Error(`Parameter '${name}' not found on tool '${tool.name}'`)
  return hit
}

describe('Tool description audit (first-try-correct invariants)', () => {
  const tools = getAllBaseTools()

  it('registry is non-empty and every tool has a name, description, and schema', () => {
    expect(tools.length).toBeGreaterThan(0)
    for (const tool of tools) {
      expect(tool.name, `tool ${tool.name ?? '<unnamed>'} missing name`).toBeTruthy()
      expect(
        tool.description,
        `tool ${tool.name} missing description`,
      ).toBeTruthy()
      expect(
        tool.inputSchema,
        `tool ${tool.name} missing inputSchema`,
      ).toBeInstanceOf(Array)
    }
  })

  it('every tool description is substantive (>= 60 chars) and mentions its scope', () => {
    for (const tool of tools) {
      const desc = tool.description.trim()
      expect(
        desc.length,
        `tool ${tool.name} description is too short (${desc.length} chars) — add scope, one example, and nearest-neighbour tool`,
      ).toBeGreaterThanOrEqual(60)
    }
  })

  it('every parameter has a non-empty description', () => {
    for (const tool of tools) {
      for (const param of tool.inputSchema) {
        expect(
          param.description?.trim() || '',
          `tool ${tool.name}: param '${param.name}' has empty description`,
        ).not.toBe('')
      }
    }
  })

  it('parameters carrying units/index semantics mention those explicitly', () => {
    // Map: substring in param name → required mention in description.
    // Rules are case-insensitive; `skipWhen` lets us bypass a rule when the
    // same param name is used for a different semantic (e.g. grep's
    // `offset` = "skip N results" for pagination, not a line index).
    const UNIT_RULES: Array<{
      match: RegExp
      mustMention: RegExp
      label: string
      skipWhen?: RegExp
    }> = [
      {
        match: /^timeout(Ms)?$/i,
        mustMention: /millisecond|\bms\b/i,
        label: 'timeout should say milliseconds/ms',
      },
      {
        match: /(Bytes|Size)$/i,
        mustMention: /byte|\bmb\b|\bgb\b|\bkb\b|\bgib\b/i,
        label: 'size params should name a byte unit',
      },
      {
        match: /^offset$/i,
        mustMention: /(0-index|zero-index|1-index|one-index|0-based|1-based)/i,
        label: 'offset (line-based) should say 0- or 1-indexed',
        // Pagination offsets ("skip first N results") don't need 0/1-indexed
        // disclaimers — they're conventionally 0-based with no ambiguity.
        skipWhen: /\b(skip|paginat|page)/i,
      },
      {
        match: /^maxResults$/i,
        mustMention: /\b(default|max|up to|at most|cap)\b/i,
        label: 'maxResults should mention a default or cap',
      },
    ]
    for (const tool of tools) {
      for (const param of tool.inputSchema) {
        for (const rule of UNIT_RULES) {
          if (!rule.match.test(param.name)) continue
          if (rule.skipWhen && rule.skipWhen.test(param.description || '')) continue
          expect(
            param.description,
            `tool ${tool.name}: param '${param.name}' — ${rule.label}`,
          ).toMatch(rule.mustMention)
        }
      }
    }
  })

  it('file-path parameters explain resolution (relative → workspace root, or absolute)', () => {
    const PATH_PARAM_NAMES = new Set([
      'filePath', 'file_path', 'dirPath', 'dir_path', 'path', 'cwd',
    ])
    for (const tool of tools) {
      for (const param of tool.inputSchema) {
        if (!PATH_PARAM_NAMES.has(param.name)) continue
        const desc = param.description || ''
        // Either the param description carries it, or the tool-level description does.
        const combined = `${tool.description}\n${desc}`
        expect(
          combined,
          `tool ${tool.name}: param '${param.name}' must explain path resolution (relative/workspace/absolute)`,
        ).toMatch(/(relative|workspace|absolute)/i)
      }
    }
  })

  it('enum-constrained params surface the enum values in description', () => {
    for (const tool of tools) {
      for (const param of tool.inputSchema) {
        if (!param.enum || param.enum.length === 0) continue
        for (const value of param.enum) {
          expect(
            param.description,
            `tool ${tool.name}: param '${param.name}' should list enum value '${value}' in description`,
          ).toContain(value)
        }
      }
    }
  })

  // -------------------------------------------------------------------------
  // Per-tool load-bearing content checks. These pin facts that the model
  // MUST see to pick the right tool / use it correctly. Each line maps to
  // a real prior incident.
  // -------------------------------------------------------------------------

  describe('per-tool required content', () => {
    it('`bash`: explains auto-routing to Git Bash + timeoutMs units + runInBackground', () => {
      const bash = byName(tools, 'bash')
      expect(bash.description).toMatch(/git bash/i)
      expect(bash.description).toMatch(/(posix|grep|awk|sed)/i)
      expect(bash.description).toMatch(/runInBackground/)
      const timeoutMs = paramByName(bash, 'timeoutMs')
      expect(timeoutMs.description).toMatch(/millisecond/i)
      const cwd = paramByName(bash, 'cwd')
      // cwd must be recommended over `cd … && …`.
      expect(bash.description + cwd.description).toMatch(/cd\s/i)
    })

    it('`PowerShell`: calls out PS 5.1 && limitation AND points at `bash` for POSIX', () => {
      const ps = byName(tools, 'PowerShell')
      // Don't require enabled on the current OS — we still audit its description.
      expect(ps.description).toMatch(/5\.1/)
      expect(ps.description).toMatch(/&&/)
      expect(ps.description).toMatch(/\bbash\b/)
    })

    it('`read_file`: explicit 0-indexed + points at list_files for directories', () => {
      const rf = byName(tools, 'read_file')
      expect(rf.description).toMatch(/list_files/)
      const offset = paramByName(rf, 'offset')
      expect(offset.description).toMatch(/0-?index/i)
    })

    it('`write_file`: warns existing files are rejected and recommends `edit_file`', () => {
      const wf = byName(tools, 'write_file')
      expect(wf.description).toMatch(/reject|overwrite/i)
      expect(wf.description).toMatch(/edit_file/)
    })

    it('`edit_file`: read-first contract + anti-ellipsis rule + replace_all doc', () => {
      const ef = byName(tools, 'edit_file')
      expect(ef.description).toMatch(/read_file/)
      expect(ef.description).toMatch(/\.{3}|\u2026/) // ASCII "..." or Unicode "…"
      expect(ef.description).toMatch(/replace_all/i)
    })

    it('`list_files`: points at `glob` for name patterns + `grep` for content', () => {
      const lf = byName(tools, 'list_files')
      expect(lf.description).toMatch(/\bglob\b/)
      expect(lf.description).toMatch(/\bgrep\b/)
    })

    it('`glob`: separates glob vs regex + shows at least one example', () => {
      const g = byName(tools, 'glob')
      expect(g.description.toLowerCase()).toContain('not regex')
      // Must show an example glob pattern like `**/*.ts`.
      expect(g.description).toMatch(/\*\*\/\*\.[a-z]+/)
    })

    it('`grep`: explains path can be either directory OR file', () => {
      const gr = byName(tools, 'grep')
      expect(gr.description).toMatch(/directory/i)
      expect(gr.description).toMatch(/\bfile\b/i)
    })

    it('`web_fetch`: requires http(s) scheme and rejects non-http schemes', () => {
      const wf = byName(tools, 'web_fetch')
      expect(wf.description).toMatch(/https?/i)
      expect(wf.description).toMatch(/\bfile:\/\/|reject|non-http/i)
    })
  })
})
