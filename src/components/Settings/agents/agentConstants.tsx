import React from 'react'
import {
  Brain, Zap, FileText, Users, Terminal, CheckCircle2,
  Folder, HardDrive, Globe, Package, FolderPlus, Edit3,
} from 'lucide-react'
import type { Messages } from '../../../i18n'

type AgentsMessages = Messages['settings']['agents']

// ========== Built-in Agent Metadata ==========

/** Complete tool registry — canonical names matching electron/tools/builtinToolAliases.ts. */
export const ALL_TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash',
  'WebFetch', 'WebSearch', 'Agent', 'Skill', 'ToolSearch',
  'TaskCreate', 'TaskOutput', 'TaskStop', 'TaskList', 'TaskUpdate',
  'TeamStatus', 'SendMessage', 'REPL', 'REP',
  'PowerShell', 'list_files', 'TodoWrite', 'NotebookEdit', 'Config',
  'LSP', 'MemdirScan', 'EnterWorktree', 'ExitWorktree',
  'CronCreate', 'CronList', 'CronDelete', 'RemoteTrigger',
  'TeamCreate', 'TeamDelete', 'KillAllTasks', 'KillAgentTasks',
  'SwarmMultiplexer',
  'AwaySummary', 'MagicDocs', 'PromptSuggestion', 'TeamMemorySync',
] as const

export type ToolName = (typeof ALL_TOOLS)[number]

export interface BuiltinAgentMeta {
  agentType: string
  name: string
  whenToUse: string
  /** Explicit allowed tools (derived to disallowed if not set). */
  tools?: readonly ToolName[]
  /** Explicit disallowed tools (derived to allowed if not set). */
  disallowedTools?: readonly ToolName[]
  isReadOnly?: boolean
  icon: React.FC<{ size?: number }>
  color: string
}

export function buildBuiltinAgentMeta(t: AgentsMessages): BuiltinAgentMeta[] {
  return [
    {
      agentType: 'general-purpose',
      name: t.builtin.generalPurposeName,
      whenToUse: t.builtin.generalPurposeWhen,
      tools: [...ALL_TOOLS],
      isReadOnly: false,
      icon: Brain,
      color: '#89b4fa',
    },
    {
      agentType: 'Explore',
      name: t.builtin.exploreName,
      whenToUse: t.builtin.exploreWhen,
      disallowedTools: ['Agent', 'Write', 'Edit'],
      isReadOnly: true,
      icon: Zap,
      color: '#a6e3a1',
    },
    {
      agentType: 'Plan',
      name: t.builtin.planName,
      whenToUse: t.builtin.planWhen,
      disallowedTools: ['Agent', 'Write', 'Edit'],
      isReadOnly: true,
      icon: FileText,
      color: '#cba6f7',
    },
    {
      agentType: 'Coordinator',
      name: t.builtin.coordinatorName,
      whenToUse: t.builtin.coordinatorWhen,
      disallowedTools: [
        'Write', 'Edit', 'Bash', 'WebFetch', 'WebSearch', 'PowerShell',
        'list_files', 'TodoWrite', 'NotebookEdit', 'Config', 'Skill',
        'LSP', 'MemdirScan', 'EnterWorktree', 'ExitWorktree',
        'CronCreate', 'CronList', 'CronDelete', 'RemoteTrigger',
        'TeamCreate', 'TeamDelete', 'KillAllTasks', 'KillAgentTasks',
        'SwarmMultiplexer', 'AwaySummary', 'MagicDocs', 'PromptSuggestion',
        'TeamMemorySync',
      ],
      isReadOnly: false,
      icon: Users,
      color: '#f9e2af',
    },
    {
      agentType: 'Debug',
      name: t.builtin.debugName,
      whenToUse: t.builtin.debugWhen,
      disallowedTools: [
        'Agent', 'Skill', 'ToolSearch', 'WebSearch', 'PowerShell',
        'TodoWrite', 'NotebookEdit', 'Config', 'LSP', 'MemdirScan',
        'EnterWorktree', 'ExitWorktree',
        'CronCreate', 'CronList', 'CronDelete', 'RemoteTrigger',
        'TeamCreate', 'TeamDelete', 'TeamStatus', 'SwarmMultiplexer',
        'AwaySummary', 'MagicDocs', 'PromptSuggestion', 'TeamMemorySync',
      ],
      isReadOnly: false,
      icon: Terminal,
      color: '#f38ba8',
    },
    {
      agentType: 'Verification',
      name: t.builtin.verificationName,
      whenToUse: t.builtin.verificationWhen,
      disallowedTools: [
        'Write', 'Edit', 'Agent', 'Skill', 'ToolSearch', 'WebSearch',
        'PowerShell', 'list_files', 'TodoWrite', 'NotebookEdit', 'Config',
        'LSP', 'MemdirScan', 'EnterWorktree', 'ExitWorktree',
        'CronCreate', 'CronList', 'CronDelete', 'RemoteTrigger',
        'TeamCreate', 'TeamDelete', 'KillAllTasks', 'KillAgentTasks',
        'SendMessage', 'TeamStatus', 'SwarmMultiplexer', 'REPL', 'REP',
        'AwaySummary', 'MagicDocs', 'PromptSuggestion', 'TeamMemorySync',
      ],
      isReadOnly: true,
      icon: CheckCircle2,
      color: '#94e2d5',
    },
  ]
}

/**
 * UI-facing scope palette. Rendered as badges on each disk-backed agent and
 * as radio options in the "save as" form. Pure visual metadata — the
 * authoritative list of scopes lives in the preload/types.
 */
export type ScopeMeta = Record<
  string,
  { label: string; color: string; Icon: React.FC<{ size?: number }>; hint: string }
>

export function buildScopeMeta(t: AgentsMessages): ScopeMeta {
  return {
    'user-global': {
      label: t.scope.userGlobalLabel,
      color: '#60a5fa',
      Icon: Globe,
      hint: t.scope.userGlobalHint,
    },
    'user-app': {
      label: t.scope.userAppLabel,
      color: '#a78bfa',
      Icon: HardDrive,
      hint: t.scope.userAppHint,
    },
    project: {
      label: t.scope.projectLabel,
      color: '#34d399',
      Icon: Folder,
      hint: t.scope.projectHint,
    },
    extra: {
      label: t.scope.extraLabel,
      color: '#f59e0b',
      Icon: FolderPlus,
      hint: t.scope.extraHint,
    },
    renderer: {
      label: t.scope.rendererLabel,
      color: '#8b5cf6',
      Icon: Edit3,
      hint: t.scope.rendererHint,
    },
    'plugin-disk': { label: t.scope.pluginDiskLabel, color: '#64748b', Icon: Package, hint: t.scope.pluginDiskHint },
    'plugin-env': { label: t.scope.pluginEnvLabel, color: '#64748b', Icon: Package, hint: t.scope.pluginEnvHint },
    'flag-env': { label: t.scope.flagEnvLabel, color: '#ef4444', Icon: Package, hint: t.scope.flagEnvHint },
    'policy-env': { label: t.scope.policyEnvLabel, color: '#ef4444', Icon: Package, hint: t.scope.policyEnvHint },
  }
}

export function buildModelOptions(t: AgentsMessages) {
  return [
    { value: 'inherit', label: t.modelInherit },
    { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { value: 'claude-opus-4-6', label: 'Opus 4.6' },
    { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  ]
}
