/**
 * Tests for Gap 2: `.cursor/agents/` directory scanning.
 *
 * Until this change, `loadProjectScopedAgents` only scanned `.claude/agents/`.
 * Community agents shared via the IDE's "custom agents" feature live under
 * `.cursor/agents/`, and users shouldn't have to duplicate the file tree to
 * use the same agent across both upstream and our host.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PROJECT_AGENT_DIR_RELATIVE_PATHS,
  loadProjectScopedAgents,
} from './customAgents'

const AGENT_MD = (name: string, description: string, prompt: string): string =>
  `---
name: ${name}
description: ${description}
tools:
  - read_file
  - grep
---
${prompt}
`

describe('loadProjectScopedAgents — .cursor/agents/ parity (Gap 2)', () => {
  let tmpRoot: string
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-agent-scan-'))
  })
  afterEach(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('scan list includes both .claude/agents and .cursor/agents (canonical constant)', () => {
    expect(PROJECT_AGENT_DIR_RELATIVE_PATHS).toContain(path.join('.claude', 'agents'))
    expect(PROJECT_AGENT_DIR_RELATIVE_PATHS).toContain(path.join('.cursor', 'agents'))
  })

  it('loads agents from .claude/agents when present', () => {
    const dir = path.join(tmpRoot, '.claude', 'agents')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'reviewer.md'),
      AGENT_MD('claude-reviewer', 'Review code quality', 'You are a code reviewer.'),
    )
    const agents = loadProjectScopedAgents(tmpRoot)
    expect(agents.map((a) => a.agentType)).toContain('claude-reviewer')
  })

  it('loads agents from .cursor/agents when present', () => {
    const dir = path.join(tmpRoot, '.cursor', 'agents')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'explorer.md'),
      AGENT_MD('cursor-explorer', 'Explore the codebase', 'You are an explorer.'),
    )
    const agents = loadProjectScopedAgents(tmpRoot)
    expect(agents.map((a) => a.agentType)).toContain('cursor-explorer')
  })

  it('loads agents from BOTH dirs when both exist (precedence: later wins)', () => {
    const claudeDir = path.join(tmpRoot, '.claude', 'agents')
    const cursorDir = path.join(tmpRoot, '.cursor', 'agents')
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.mkdirSync(cursorDir, { recursive: true })
    fs.writeFileSync(
      path.join(claudeDir, 'shared.md'),
      AGENT_MD('shared', 'claude version', 'claude body'),
    )
    fs.writeFileSync(
      path.join(cursorDir, 'shared.md'),
      AGENT_MD('shared', 'cursor version', 'cursor body'),
    )

    const agents = loadProjectScopedAgents(tmpRoot)
    // `.cursor/` comes after `.claude/` in PROJECT_AGENT_DIR_RELATIVE_PATHS;
    // the raw loader returns both entries (de-dup happens in the merge layer).
    const namesInOrder = agents.map((a) => a.agentType)
    expect(namesInOrder).toEqual(['shared', 'shared'])
    // Sanity: prompts + whenToUse differ, so we can tell which file won.
    const fromClaude = agents.find((a) => a.getSystemPrompt().includes('claude body'))
    const fromCursor = agents.find((a) => a.getSystemPrompt().includes('cursor body'))
    expect(fromClaude?.whenToUse).toBe('claude version')
    expect(fromCursor?.whenToUse).toBe('cursor version')
  })

  it('returns empty list when neither dir exists', () => {
    const agents = loadProjectScopedAgents(tmpRoot)
    expect(agents).toEqual([])
  })

  it('ignores non-agent files in .cursor/agents', () => {
    const dir = path.join(tmpRoot, '.cursor', 'agents')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'README.txt'), 'not an agent')
    fs.writeFileSync(path.join(dir, 'rules.mdc'), 'Cursor rule file — not an agent')
    fs.writeFileSync(
      path.join(dir, 'valid.md'),
      AGENT_MD('only-valid', 'The only agent here', 'prompt body'),
    )
    const agents = loadProjectScopedAgents(tmpRoot)
    expect(agents.map((a) => a.agentType)).toEqual(['only-valid'])
  })
})
