/**
 * Tool-surface slimming regression (2026-06 audit fix 5) — the Office
 * families (`excel_*` / `word_*`) are `shouldDefer: true`:
 *
 *   1. hidden from the default model tool listing until discovered,
 *   2. discoverable via ToolSearch (`markToolsDiscovered`),
 *   3. direct calls before discovery get the educative block message,
 *   4. sub-agent / bundle whitelists bypass deferral entirely.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { excelTools } from './excelTool'
import { wordTools } from './wordTool'
import { toolRegistry } from '../registry'
import {
  getToolDefinitions,
  resetToolDefinitionsSessionCacheForTests,
} from '../schema'
import {
  markToolsDiscovered,
  resetDeferredDiscovery,
} from '../deferredDiscovery'
import { getDeferredToolExecutionBlockMessage } from '../deferredToolExecutionGuard'
import { resolveAgentTools } from '../../agents/subAgentToolResolver'
import type { CustomAgentDefinition } from '../../agents/types'

afterEach(() => {
  resetDeferredDiscovery()
  resetToolDefinitionsSessionCacheForTests()
})

describe('Office 工具家族延迟加载', () => {
  it('every excel_* / word_* tool is marked shouldDefer', () => {
    expect(excelTools.length).toBeGreaterThanOrEqual(20)
    expect(wordTools.length).toBeGreaterThanOrEqual(5)
    for (const t of [...excelTools, ...wordTools]) {
      expect(t.shouldDefer, `${t.name} should defer`).toBe(true)
      expect(t.alwaysLoad ?? false, `${t.name} must not alwaysLoad`).toBe(false)
    }
  })

  it('default tool listing hides the Office families before discovery', () => {
    resetDeferredDiscovery()
    resetToolDefinitionsSessionCacheForTests()
    const names = new Set(getToolDefinitions().map((d) => d.name))
    for (const t of [...excelTools, ...wordTools]) {
      expect(names.has(t.name), `${t.name} should be hidden`).toBe(false)
    }
    // Core surface is untouched.
    expect(names.has('read_file')).toBe(true)
    expect(names.has('edit_file')).toBe(true)
  })

  it('ToolSearch discovery brings a tool back into the listing', () => {
    resetDeferredDiscovery()
    resetToolDefinitionsSessionCacheForTests()
    markToolsDiscovered(['excel_read_sheet'])
    const names = new Set(getToolDefinitions().map((d) => d.name))
    expect(names.has('excel_read_sheet')).toBe(true)
    // Sibling tools stay hidden until individually discovered.
    expect(names.has('excel_delete_sheet')).toBe(false)
  })

  it('undiscovered direct call gets the educative ToolSearch-first block message', () => {
    resetDeferredDiscovery()
    const tool = toolRegistry.get('excel_write_cell')
    expect(tool).toBeTruthy()
    const msg = getDeferredToolExecutionBlockMessage(tool!)
    expect(msg).toContain('ToolSearch')
    expect(msg).toContain('select:excel_write_cell')
    // After discovery the guard releases.
    markToolsDiscovered(['excel_write_cell'])
    expect(getDeferredToolExecutionBlockMessage(tool!)).toBeNull()
  })

  it('primary-chat override deny-path hides Office families too (consistency with default path)', async () => {
    resetDeferredDiscovery()
    const { resolvePrimaryChatTools } = await import('../../ai/resolvePrimaryChatTools')
    // 只配黑名单（无白名单点名）→ 延迟工具必须与默认路径一样隐藏。
    const tools = resolvePrimaryChatTools({
      tools: undefined,
      disallowedTools: ['bash'],
      mcpServers: undefined,
    })
    expect(tools).not.toBeNull()
    const names = new Set(tools!.map((t) => t.name))
    expect(names.has('excel_read_sheet')).toBe(false)
    expect(names.has('word_read_text')).toBe(false)
    expect(names.has('read_file')).toBe(true)
    expect(names.has('bash')).toBe(false)
  })

  it('primary-chat override allowlist still bypasses deferral (explicit naming = explicit grant)', async () => {
    resetDeferredDiscovery()
    const { resolvePrimaryChatTools } = await import('../../ai/resolvePrimaryChatTools')
    const tools = resolvePrimaryChatTools({
      tools: ['read_file', 'excel_read_sheet'],
      disallowedTools: undefined,
      mcpServers: undefined,
    })
    expect(tools).not.toBeNull()
    const names = new Set(tools!.map((t) => t.name))
    expect(names.has('excel_read_sheet')).toBe(true)
  })

  it('sub-agent whitelists bypass deferral (Excel 专员 keeps full schema)', () => {
    resetDeferredDiscovery()
    const excelAgent: CustomAgentDefinition = {
      source: 'custom',
      agentType: 'excel-specialist-probe',
      whenToUse: 'Edit spreadsheets.',
      tools: ['read_file', 'excel_read_sheet', 'excel_write_cell'],
      getSystemPrompt: () => 'You are an Excel specialist.',
    }
    const names = new Set(resolveAgentTools(excelAgent).map((t) => t.name))
    expect(names.has('excel_read_sheet')).toBe(true)
    expect(names.has('excel_write_cell')).toBe(true)
  })
})
