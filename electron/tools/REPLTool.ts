import type { Tool } from './types'
import { buildTool } from './buildTool'
import { replToolInputZod } from './toolInputZod'
import { validateRequiredStringFields } from './toolValidateCommon'
import { getAgentContext } from '../agents/agentContext'
import { runSubAgent, findAgentDefinition } from '../agents/subAgentRunner'
import { getAllAgentDefinitions } from './registry'
import { emit as emitStreamEvent } from '../ai/interactionState'
import type { AgentDefinitionUnion } from '../agents/types'

const MAX_REPL_DEPTH = 3

/**
 * Normalize legacy agent type names. "REPL" is mapped to "Debug" for
 * backward compatibility after the REPL -> Debug migration.
 */
function normalizeAgentType(raw: string): string {
  const upper = raw.toUpperCase()
  if (upper === 'REPL' || upper === 'REP') return 'Debug'
  return raw
}

function createReplLikeTool(name: 'REPL' | 'REP'): Tool {
  return buildTool({
    name,
    zInputSchema: replToolInputZod,
    description:
      'Launch a nested Debug/REPL sub-agent for focused inner tool loops or structured debugging. ' +
      'Useful for decomposing hard tasks into contained sub-iterations or running evidence-driven diagnostics.',
    inputSchema: [
    {
      name: 'prompt',
      type: 'string',
      description: 'Task for the nested sub-agent.',
      required: true,
    },
    {
      name: 'agentType',
      type: 'string',
      description: 'Optional sub-agent type (default: Debug). Legacy value "REPL" is auto-mapped to Debug.',
    },
    {
      name: 'maxTurns',
      type: 'number',
      description:
        'Optional max iteration count for the nested sub-agent. ' +
        'When omitted, the chosen sub-agent\'s own default applies (Debug = 150). ' +
        'When supplied, the value is clamped to [10, 50] — passing tiny values ' +
        '(e.g. 3) is a self-inflicted trap because even a trivial `echo` task ' +
        'usually needs at least 2-3 turns once you include thought + tool + ' +
        'verification, and reactive recovery cycles eat several more. ' +
        'Pass a generous budget; the sub-agent will exit early if it finishes sooner.',
    },
    {
      name: 'model',
      type: 'string',
      description: 'Optional model override.',
    },
    ],
    isReadOnly: false,
    isDestructive: true,
    searchHint: 'nested debug repl subagent inner loop',
    aliases: name === 'REPL' ? ['repl', 'Debug'] : ['rep'],
    validateInput: validateRequiredStringFields('prompt'),
    async call({ prompt, agentType: rawAgentType = 'Debug', maxTurns, model }, _ctx) {
    const parent = getAgentContext()
    if (!parent) {
      return {
        success: false,
        error: 'Debug/REPL can only be launched during an active agent run.',
      }
    }

    if (!prompt || !prompt.trim()) {
      return {
        success: false,
        error: 'Debug/REPL requires a non-empty prompt.',
      }
    }

    const depth = parent.replDepth ?? 0
    if (depth >= MAX_REPL_DEPTH) {
      return {
        success: false,
        error: `Debug/REPL nesting depth limit reached (${MAX_REPL_DEPTH}).`,
      }
    }

    const agentType = normalizeAgentType(rawAgentType)
    const all = getAllAgentDefinitions()
    const selected = findAgentDefinition(agentType, all)
    if (!selected) {
      return {
        success: false,
        error: `Unknown agent type: ${agentType}. Available: ${all.map(a => a.agentType).join(', ')}`,
      }
    }

    // Clamp the model-supplied budget to a sane window. Floor at 10 because
    // even trivial tasks burn 2-3 turns on thought/tool/verify before they can
    // reach a terminal state, and the agentic loop reserves a couple more for
    // reactive recovery (compact / overload). Anything below 10 routinely
    // surfaces as "Stopped at iteration limit; response may be incomplete."
    // even when the sub-agent did nothing wrong. Cap at 50 to bound runaway.
    const MAX_TURNS_FLOOR = 10
    const MAX_TURNS_CAP = 50
    const finalAgent: AgentDefinitionUnion = {
      ...selected,
      maxTurns:
        typeof maxTurns === 'number'
          ? Math.max(MAX_TURNS_FLOOR, Math.min(MAX_TURNS_CAP, Math.floor(maxTurns)))
          : selected.maxTurns,
      model: model || selected.model,
    }

    const result = await runSubAgent({
      description: `REPL: ${prompt.slice(0, 60)}`,
      teamName: parent.teamId,
      config: parent.config,
      model: model || parent.model,
      agentDef: finalAgent,
      prompt,
      parentMessages: parent.messages,
      parentSystemPrompt: parent.systemPrompt,
      signal: parent.signal,
      onEvent: (event) => {
        emitStreamEvent(event as unknown as Record<string, unknown>)
      },
    })

    if (!result.success) {
      return {
        success: false,
        error: result.output || 'Nested sub-agent failed.',
      }
    }

    return {
      success: true,
      output: `Nested ${result.agentType} completed (turns<=${finalAgent.maxTurns ?? selected.maxTurns ?? '?'}, tools=${result.totalToolUses}, duration=${result.totalDurationMs}ms).\n\n${result.output}`,
    }
  },
  })
}

export const replTool = createReplLikeTool('REPL')
