import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { resolveAgentTools } from './subAgentRunner'
import {
  GENERAL_PURPOSE_AGENT,
  COORDINATOR_AGENT,
  VERIFICATION_AGENT,
  EXPLORE_AGENT,
  PLAN_AGENT,
  DEBUG_AGENT,
  SESSION_MEMORY_INTERNAL_AGENT,
  getBuiltInAgent,
} from './builtInAgents'
import type { BuiltInAgentDefinition, CustomAgentDefinition } from './types'
import {
  getAlwaysAvailableSubagentTools,
  IN_PROCESS_TEAMMATE_ALLOWED_TOOLS,
} from './types'
import { rebuildAgentDefinitions, toolRegistry } from '../tools/registry'
import { taskStopTool } from '../tools/TaskStopTool'
import { taskOutputTool } from '../tools/TaskOutputTool'
import { teamStatusTool } from '../tools/TeamCreateTool'
import { exitPlanModeTool } from '../tools/ExitPlanModeTool'
import { todoWriteTool } from '../tools/TodoWriteTool'
import { setPermissionMode } from '../ai/interactionState'
import { EDIT_TOOL_NAME, registryPrimaryToolName } from '../tools/builtinToolAliases'

describe('resolveAgentTools (OpenClaude §7.1 global deny)', () => {
  beforeEach(() => {
    rebuildAgentDefinitions(null, undefined)
    toolRegistry.register(taskStopTool)
    toolRegistry.register(taskOutputTool)
    toolRegistry.register(teamStatusTool)
    toolRegistry.register(exitPlanModeTool)
    toolRegistry.register(todoWriteTool)
  })

  afterEach(() => {
    setPermissionMode('default')
  })

  it('removes Agent and TaskOutput from general-purpose (*)', () => {
    const tools = resolveAgentTools(GENERAL_PURPOSE_AGENT)
    const names = new Set(tools.map((t) => t.name))
    expect(names.has('Agent')).toBe(false)
    expect(names.has('TaskOutput')).toBe(false)
    expect(names.has('TaskStop')).toBe(false)
    expect(names.has('read_file')).toBe(true)
  })

  it('keeps OC coordinator core tools including TaskOutput (SyntheticOutput analogue)', () => {
    const tools = resolveAgentTools(COORDINATOR_AGENT)
    const names = new Set(tools.map((t) => t.name))
    expect(names.has('Agent')).toBe(true)
    expect(names.has('TaskStop')).toBe(true)
    expect(names.has('TaskOutput')).toBe(true)
    expect(names.has('read_file')).toBe(true)
    expect(names.has('TeamStatus')).toBe(true)
  })

  it('ASTRA_COORDINATOR_STRICT_OC_TOOLS=1 keeps only core four', () => {
    const prev = process.env.ASTRA_COORDINATOR_STRICT_OC_TOOLS
    try {
      process.env.ASTRA_COORDINATOR_STRICT_OC_TOOLS = '1'
      const tools = resolveAgentTools(COORDINATOR_AGENT)
      const names = new Set(tools.map((t) => t.name))
      expect(names.has('Agent')).toBe(true)
      expect(names.has('TaskOutput')).toBe(true)
      expect(names.has('read_file')).toBe(false)
      expect(names.has('TeamStatus')).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.ASTRA_COORDINATOR_STRICT_OC_TOOLS
      else process.env.ASTRA_COORDINATOR_STRICT_OC_TOOLS = prev
    }
  })

  it('Verification allowlist has no TaskOutput after global deny', () => {
    const tools = resolveAgentTools(VERIFICATION_AGENT)
    const names = new Set(tools.map((t) => t.name))
    expect(names.has('TaskOutput')).toBe(false)
    expect(names.has('read_file')).toBe(true)
  })

  it('exposes new built-in agent types from the report §2.4', () => {
    expect(getBuiltInAgent('statusline-setup')).toBeTruthy()
    expect(getBuiltInAgent('claude-code-guide')).toBeTruthy()
  })

  it('Explore uses async_agent profile intersecting OC-style allowlist', () => {
    const tools = resolveAgentTools(EXPLORE_AGENT)
    const names = new Set(tools.map((t) => t.name))
    expect(names.has('Agent')).toBe(false)
    expect(names.has('Write')).toBe(false)
    expect(names.has('read_file')).toBe(true)
    expect(names.has('bash')).toBe(true)
  })

  it('plan permission injects ExitPlanMode for sub-agents (§7.2)', () => {
    setPermissionMode('plan')
    const tools = resolveAgentTools(GENERAL_PURPOSE_AGENT)
    const names = new Set(tools.map((t) => t.name))
    expect(names.has('ExitPlanMode')).toBe(true)
  })

  it('plan permission injects ExitPlanMode even for async_agent profile', () => {
    setPermissionMode('plan')
    const tools = resolveAgentTools(EXPLORE_AGENT)
    expect(tools.some((t) => t.name === 'ExitPlanMode')).toBe(true)
  })

  it('IN_PROCESS_TEAMMATE_ALLOWED_TOOLS matches report §7.1 teammate extras', () => {
    expect(IN_PROCESS_TEAMMATE_ALLOWED_TOOLS.has('SendMessage')).toBe(true)
    expect(IN_PROCESS_TEAMMATE_ALLOWED_TOOLS.has('TaskList')).toBe(true)
  })

  it('in_process_teammate profile keeps Agent on wildcard agents', () => {
    const teammate: BuiltInAgentDefinition = {
      ...GENERAL_PURPOSE_AGENT,
      agentType: 'TeammateProbe',
      subagentToolProfile: 'in_process_teammate',
    }
    const tools = resolveAgentTools(teammate)
    const names = new Set(tools.map((t) => t.name))
    expect(names.has('Agent')).toBe(true)
    expect(names.has('TaskOutput')).toBe(false)
  })

  it('report §4.2 simple toolset: only read_file, edit_file, bash', () => {
    const prev = process.env.ASTRA_SIMPLE_TOOLSET
    try {
      process.env.ASTRA_SIMPLE_TOOLSET = '1'
      const tools = resolveAgentTools(GENERAL_PURPOSE_AGENT)
      const names = new Set(tools.map((t) => t.name))
      expect(names.has('read_file')).toBe(true)
      expect(names.has('edit_file')).toBe(true)
      expect(names.has('bash')).toBe(true)
      expect(names.has('glob_file_search')).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.ASTRA_SIMPLE_TOOLSET
      else process.env.ASTRA_SIMPLE_TOOLSET = prev
    }
  })
})

/**
 * Guards the logic in {@link subAgentRunner} that decides whether to inject
 * `EDIT_FILE_CONTRACT_BLOCK` into a sub-agent's system prompt. The check has
 * to normalize snake_case (registry names like `edit_file`) against
 * PascalCase (upstream canonical `Edit`) — a naive `t.name === EDIT_TOOL_NAME`
 * comparison silently never matches, turning the whole contract into dead code.
 */
describe('sub-agent edit-contract detection (subAgentRunner wiring)', () => {
  beforeEach(() => {
    rebuildAgentDefinitions(null, undefined)
    toolRegistry.register(taskStopTool)
    toolRegistry.register(taskOutputTool)
    toolRegistry.register(teamStatusTool)
    toolRegistry.register(exitPlanModeTool)
    toolRegistry.register(todoWriteTool)
  })

  const hasEditTool = (agentDef: BuiltInAgentDefinition): boolean => {
    const tools = resolveAgentTools(agentDef)
    const editRegistryName = registryPrimaryToolName(EDIT_TOOL_NAME)
    return tools.some((t) => registryPrimaryToolName(t.name) === editRegistryName)
  }

  it('detects Edit via snake_case registry name (regression: PascalCase-only check was dead code)', () => {
    // The tool registry uses `edit_file`; EDIT_TOOL_NAME is 'Edit'.
    // Normalization via registryPrimaryToolName must unify them so the
    // subAgentRunner detection works regardless of which spelling the
    // tool surface uses.
    expect(registryPrimaryToolName(EDIT_TOOL_NAME)).toBe('edit_file')
    expect(registryPrimaryToolName('edit_file')).toBe('edit_file')
    expect(registryPrimaryToolName('Edit')).toBe('edit_file')
  })

  it('general-purpose agent has Edit on its surface (→ contract injected)', () => {
    expect(hasEditTool(GENERAL_PURPOSE_AGENT)).toBe(true)
  })

  it('Debug agent has Edit on its surface (→ contract injected)', () => {
    expect(hasEditTool(DEBUG_AGENT)).toBe(true)
  })

  it('session-memory-internal has Edit on its surface (→ contract injected)', () => {
    // Regression guard: this is the "会话笔记" sub-agent — a fork that reads
    // then edits/writes ~/.claude/session-memory/*.md. Without the contract
    // it hallucinates old_string and corrupts the markdown on merge.
    expect(hasEditTool(SESSION_MEMORY_INTERNAL_AGENT)).toBe(true)
  })

  it('Explore is read-only — no Edit surface (→ contract NOT injected)', () => {
    expect(hasEditTool(EXPLORE_AGENT)).toBe(false)
  })

  it('Plan is read-only — no Edit surface (→ contract NOT injected)', () => {
    expect(hasEditTool(PLAN_AGENT)).toBe(false)
  })

  it('Verification is read-only — no Edit surface (contract not needed, read-only tool surface)', () => {
    // VERIFICATION_AGENT has isReadOnly: true and a tool allowlist that
    // excludes Edit by design; the contract block is irrelevant and
    // correctly skipped. This asserts the allowlist hasn't silently drifted
    // to include Edit (which would also require revisiting isReadOnly).
    expect(hasEditTool(VERIFICATION_AGENT)).toBe(false)
  })

  it('Coordinator delegates writes — no Edit surface (contract not needed)', () => {
    // Coordinator's whenToUse explicitly states "You cannot edit files
    // directly — delegate writes to sub-agents." The contract block is
    // correctly skipped; delegated sub-agents get the contract via their
    // own detection.
    expect(hasEditTool(COORDINATOR_AGENT)).toBe(false)
  })
})

/**
 * Guards the runtime-protocol tool injection (see
 * `subAgentRunner.injectAlwaysAvailableTools` and
 * `ALWAYS_AVAILABLE_SUBAGENT_TOOLS`). The workbench relies on this path so
 * user-imported bundles with curated `tools: ['read_file', 'grep', ...]`
 * lists still get `TodoWrite` for progress tracking without asking every
 * bundle author to list it explicitly.
 */
describe('always-available sub-agent tools (TodoWrite auto-injection)', () => {
  // 星构Astra coexist extension (2026-05): the default mode is now
  // `'coexist'`, which makes BOTH `TodoWrite` and `Task*` available
  // to sub-agents (`getAlwaysAvailableSubagentTools` returns the
  // union). The assertions in this block specifically pin the V1
  // contract surface, so we force `'v1-only'` for the whole block
  // — this keeps targeted V1 coverage while the coexist contract
  // is exercised separately (see the V1/V2/coexist split in
  // `conversation/loadConversationTodoRestore.test.ts`).
  let prevTodoV1Env: string | undefined
  beforeAll(() => {
    prevTodoV1Env = process.env.ASTRA_TODO_V1
    process.env.ASTRA_TODO_V1 = '1'
  })
  afterAll(() => {
    if (prevTodoV1Env === undefined) delete process.env.ASTRA_TODO_V1
    else process.env.ASTRA_TODO_V1 = prevTodoV1Env
  })

  beforeEach(() => {
    rebuildAgentDefinitions(null, undefined)
    toolRegistry.register(taskStopTool)
    toolRegistry.register(taskOutputTool)
    toolRegistry.register(teamStatusTool)
    toolRegistry.register(exitPlanModeTool)
    toolRegistry.register(todoWriteTool)
  })

  afterEach(() => {
    setPermissionMode('default')
  })

  it('function returns TodoWrite in V1 mode (source of truth for workbench UI mirror)', () => {
    expect(getAlwaysAvailableSubagentTools().has('TodoWrite')).toBe(true)
  })

  it('wildcard agent (general-purpose) still has TodoWrite', () => {
    const tools = resolveAgentTools(GENERAL_PURPOSE_AGENT)
    expect(tools.some((t) => t.name === 'TodoWrite')).toBe(true)
  })

  it('curated-whitelist agent from a user bundle gets TodoWrite injected', () => {
    // Typical shape emitted by `bundleAgentsToDefinitions` for a workpackage
    // agent that only lists domain tools.
    const bundleAgent: CustomAgentDefinition = {
      source: 'custom',
      agentType: 'legal-review-specialist',
      whenToUse: 'Review contracts and draft change proposals.',
      tools: ['read_file', 'grep', 'glob', 'bash'],
      getSystemPrompt: () => 'You are a legal-review specialist.',
    }
    const tools = resolveAgentTools(bundleAgent)
    const names = new Set(tools.map((t) => t.name))
    expect(names.has('TodoWrite')).toBe(true)
    // Injection must not leak other domain tools the bundle didn't ask for.
    expect(names.has('write_file')).toBe(false)
    expect(names.has('edit_file')).toBe(false)
  })

  it('disallowedTools is the escape hatch (TodoWrite removed when listed)', () => {
    const strictAgent: CustomAgentDefinition = {
      source: 'custom',
      agentType: 'audit-readonly',
      whenToUse: 'Strict read-only audit with no side effects.',
      tools: ['read_file', 'grep'],
      disallowedTools: ['TodoWrite'],
      getSystemPrompt: () => 'You are a strict auditor.',
    }
    const tools = resolveAgentTools(strictAgent)
    expect(tools.some((t) => t.name === 'TodoWrite')).toBe(false)
  })

  it('Verification default allowlist now gets TodoWrite (opt-out via disallowedTools)', () => {
    const tools = resolveAgentTools(VERIFICATION_AGENT)
    const names = new Set(tools.map((t) => t.name))
    expect(names.has('TodoWrite')).toBe(true)
    // The rest of Verification's strict surface should be unchanged.
    expect(names.has('TaskOutput')).toBe(false)
    expect(names.has('write_file')).toBe(false)
    expect(names.has('edit_file')).toBe(false)
  })

  it('Debug default allowlist now gets TodoWrite', () => {
    const tools = resolveAgentTools(DEBUG_AGENT)
    expect(tools.some((t) => t.name === 'TodoWrite')).toBe(true)
  })

  it('Coordinator default excludes TodoWrite (Phase D — strict OC four-tool surface is default)', () => {
    // upstream parity (`constants/tools.ts:104-112`): Coordinator's
    // surface is exclusively orchestration tools (Agent / TaskStop /
    // SendMessage / TaskOutput, plus the loose extensions). The
    // always-available injection ALWAYS skips Coordinator regardless
    // of the strict env knob, because progress-tracking is the
    // workers' job, not the coordinator's.
    const tools = resolveAgentTools(COORDINATOR_AGENT)
    expect(tools.some((t) => t.name === 'TodoWrite')).toBe(false)
  })

  it('Coordinator strict OC mode also excludes TodoWrite (strict knob is now redundant for injection)', () => {
    const prev = process.env.ASTRA_COORDINATOR_STRICT_OC_TOOLS
    try {
      process.env.ASTRA_COORDINATOR_STRICT_OC_TOOLS = '1'
      const tools = resolveAgentTools(COORDINATOR_AGENT)
      expect(tools.some((t) => t.name === 'TodoWrite')).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.ASTRA_COORDINATOR_STRICT_OC_TOOLS
      else process.env.ASTRA_COORDINATOR_STRICT_OC_TOOLS = prev
    }
  })

  it('in_process_teammate profile does NOT auto-inject TodoWrite (minimal surface)', () => {
    // Teammate bundles typically ship a curated whitelist of team-protocol
    // tools; the injection path must be skipped so the teammate surface
    // stays tight. (Wildcard-`*` teammates inherit TodoWrite through the
    // generic wildcard path, which is fine because they opted into the
    // full registry; see `in_process_teammate profile keeps Agent on
    // wildcard agents` above.)
    const curatedTeammate: CustomAgentDefinition = {
      source: 'custom',
      agentType: 'teammate-probe-curated',
      whenToUse: 'Curated teammate.',
      tools: ['read_file', 'grep', 'SendMessage'],
      subagentToolProfile: 'in_process_teammate',
      getSystemPrompt: () => 'You are a curated teammate.',
    }
    const tools = resolveAgentTools(curatedTeammate)
    expect(tools.some((t) => t.name === 'TodoWrite')).toBe(false)
  })

  it('async_agent profile (Explore) still gets TodoWrite via the profile allowlist', () => {
    // TodoWrite was already in ASYNC_AGENT_ALLOWED_TOOLS before this change;
    // this is a regression guard so the new injection doesn't accidentally
    // strip it when the profile filter runs.
    const tools = resolveAgentTools(EXPLORE_AGENT)
    expect(tools.some((t) => t.name === 'TodoWrite')).toBe(true)
  })

  it('injection is idempotent — TodoWrite appears exactly once', () => {
    const tools = resolveAgentTools(GENERAL_PURPOSE_AGENT)
    const count = tools.filter((t) => t.name === 'TodoWrite').length
    expect(count).toBe(1)
  })

  it('disallow wins even against wildcard agents', () => {
    const wildcardButMuted: BuiltInAgentDefinition = {
      ...GENERAL_PURPOSE_AGENT,
      agentType: 'general-purpose-muted',
      disallowedTools: ['TodoWrite'],
    }
    const tools = resolveAgentTools(wildcardButMuted)
    expect(tools.some((t) => t.name === 'TodoWrite')).toBe(false)
  })
})

// 星构Astra coexist extension (2026-05): the always-available set
// returned by `getAlwaysAvailableSubagentTools()` must reflect the
// active mode. The block above pins V1-only mode; this block exercises
// the coexist and V2-only branches that the union / narrowing logic
// depends on.
describe('getAlwaysAvailableSubagentTools — three-mode contract', () => {
  let prevV1Env: string | undefined
  let prevModeEnv: string | undefined
  beforeEach(() => {
    prevV1Env = process.env.ASTRA_TODO_V1
    prevModeEnv = process.env.ASTRA_TODO_MODE
    delete process.env.ASTRA_TODO_V1
    delete process.env.ASTRA_TODO_MODE
  })
  afterEach(() => {
    if (prevV1Env === undefined) delete process.env.ASTRA_TODO_V1
    else process.env.ASTRA_TODO_V1 = prevV1Env
    if (prevModeEnv === undefined) delete process.env.ASTRA_TODO_MODE
    else process.env.ASTRA_TODO_MODE = prevModeEnv
  })

  it('coexist mode (default) returns the union — both TodoWrite AND the Task* quad', () => {
    const tools = getAlwaysAvailableSubagentTools()
    expect(tools.has('TodoWrite')).toBe(true)
    expect(tools.has('TaskCreate')).toBe(true)
    expect(tools.has('TaskUpdate')).toBe(true)
    expect(tools.has('TaskList')).toBe(true)
    expect(tools.has('TaskGet')).toBe(true)
    expect(tools.size).toBe(5)
  })

  it("v2-only mode returns only the Task* quad (no TodoWrite)", () => {
    process.env.ASTRA_TODO_MODE = 'v2-only'
    const tools = getAlwaysAvailableSubagentTools()
    expect(tools.has('TodoWrite')).toBe(false)
    expect(tools.has('TaskCreate')).toBe(true)
    expect(tools.has('TaskUpdate')).toBe(true)
    expect(tools.has('TaskList')).toBe(true)
    expect(tools.has('TaskGet')).toBe(true)
    expect(tools.size).toBe(4)
  })

  it("v1-only mode (via ASTRA_TODO_V1) returns only TodoWrite", () => {
    process.env.ASTRA_TODO_V1 = '1'
    const tools = getAlwaysAvailableSubagentTools()
    expect(tools.has('TodoWrite')).toBe(true)
    expect(tools.has('TaskCreate')).toBe(false)
    expect(tools.size).toBe(1)
  })
})
