/**
 * Resolve {@link AgentDefinition.mcpServers} refs to connection **names** for MCP tool
 * filtering and {@link ensureMcpServersConnected}.
 */

import type { AgentMcpServerRef, AgentMcpServerSpec } from './types'

/** Parse loose JSON/YAML-derived `mcpServers` arrays (strings or `{ name, config? }`). */
export function parseMcpServersFromUnknown(raw: unknown): AgentMcpServerRef[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const out: AgentMcpServerRef[] = []
  for (const x of raw) {
    if (typeof x === 'string') {
      const s = x.trim()
      if (s) out.push(s)
      continue
    }
    if (x && typeof x === 'object' && !Array.isArray(x)) {
      const o = x as Record<string, unknown>
      const name = typeof o.name === 'string' ? o.name.trim() : ''
      if (!name) continue
      const config =
        o.config && typeof o.config === 'object' && !Array.isArray(o.config)
          ? (o.config as Record<string, unknown>)
          : undefined
      out.push(config ? { name, config } : { name })
    }
  }
  return out.length > 0 ? out : undefined
}

export function isAgentMcpServerSpec(ref: AgentMcpServerRef): ref is AgentMcpServerSpec {
  return typeof ref === 'object' && ref !== null && typeof (ref as AgentMcpServerSpec).name === 'string'
}

export function agentMcpServerRefToName(ref: AgentMcpServerRef): string {
  if (typeof ref === 'string') return ref.trim()
  return String((ref as AgentMcpServerSpec).name ?? '').trim()
}

/** Names only (non-empty), for registry / transport layers. */
export function normalizeMcpServerNameList(refs: AgentMcpServerRef[] | undefined): string[] | undefined {
  if (!refs?.length) return undefined
  const names = refs.map(agentMcpServerRefToName).filter(Boolean)
  return names.length > 0 ? names : undefined
}
