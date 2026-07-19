/**
 * upstream 报告 §11.1 — CronCreate / CronDelete / CronList 工具。
 *
 * AC-11.1: 标准5字段cron + recurring + durable + permanent + 50上限 + Teammate限制
 */

import { buildTool } from './buildTool'
import { cronCreate, cronDelete, cronListJobs, validateCronExpression } from './cronScheduler'
import type { CronTask } from './cronScheduler'
import { cronCreateInputZod, cronDeleteInputZod, emptyToolInputZod } from './toolInputZod'

export const cronCreateTool = buildTool({
  name: 'CronCreate',
  zInputSchema: cronCreateInputZod,
  description:
    'Schedule a task using standard 5-field cron expressions (minute hour day-of-month month day-of-week, local time). ' +
    'Supports recurring (default true, auto-expires after 7 days unless permanent), durable (persists to .claude/scheduled_tasks.json), ' +
    'and permanent (no auto-expiry) flags. Maximum 50 tasks. Teammates cannot create durable cron tasks.',
  inputSchema: [
    {
      name: 'cron',
      type: 'string',
      description: 'Standard 5-field cron expression (e.g. "*/5 * * * *" = every 5 min, "0 9 * * 1-5" = 9am weekdays). (alias: intervalMinutes — legacy, converted to */N * * * *)',
      required: true,
    },
    { name: 'prompt', type: 'string', description: 'Prompt or shell command to execute when fired (alias: command)', required: true },
    { name: 'recurring', type: 'boolean', description: 'Whether to repeat (default true; 7-day auto-expiry unless permanent)' },
    { name: 'durable', type: 'boolean', description: 'Persist to scheduled_tasks.json for cross-session survival (default false)' },
    { name: 'permanent', type: 'boolean', description: 'No auto-expiry (default false)' },
    { name: 'id', type: 'string', description: 'Optional stable id for updates' },
    { name: 'label', type: 'string', description: 'Optional human-readable label shown in CronList output (alias: description)' },
    {
      name: 'description',
      type: 'string',
      description: 'Alias for `label` — accepted because LLMs gravitate toward "description" as the generic annotation name. UI / telemetry only; no effect on execution.',
    },
    {
      name: 'intervalMinutes',
      type: 'number',
      description: 'Legacy alias: converted to a 5-field cron expression (`*/N * * * *` or `0 */H * * *`). Prefer `cron` for new code.',
    },
    {
      name: 'command',
      type: 'string',
      description: 'Legacy alias for `prompt` — accepted for back-compat. Prefer `prompt`.',
    },
  ],
  isReadOnly: false,
  isDestructive: true,
  isConcurrencySafe: false,
  maxResultChars: 8_000,
  async call(input, _ctx) {
    let cronExpr = String(input.cron ?? '').trim()
    const prompt = String(input.prompt ?? input.command ?? '').trim()

    if (!prompt) {
      return { success: false, error: 'prompt is required.' }
    }

    // Back-compat: legacy intervalMinutes → cron expression
    if (!cronExpr && typeof input.intervalMinutes === 'number' && input.intervalMinutes > 0) {
      const mins = Math.max(1, Math.floor(input.intervalMinutes))
      cronExpr = mins >= 60
        ? `0 */${Math.floor(mins / 60)} * * *`
        : `*/${mins} * * * *`
    }

    if (!cronExpr) {
      return { success: false, error: 'cron expression is required (5 fields: minute hour day month weekday).' }
    }

    const validation = validateCronExpression(cronExpr)
    if (!validation.valid) {
      return { success: false, error: `Invalid cron: ${validation.error}` }
    }

    const result = await cronCreate({
      cron: cronExpr,
      prompt,
      recurring: input.recurring,
      durable: input.durable,
      permanent: input.permanent,
      id: input.id,
      label: input.label ?? input.description,
    })

    if ('error' in result) {
      return { success: false, error: result.error }
    }

    const flags = [
      result.recurring !== false ? 'recurring' : 'one-shot',
      result.durable ? 'durable' : 'memory-only',
      result.permanent ? 'permanent' : '7-day-expiry',
    ].join(', ')

    return {
      success: true,
      output: `Cron task created: id=${result.id} cron="${result.cron}" [${flags}]\nPrompt: ${result.prompt.slice(0, 200)}`,
    }
  },
})

export const cronListTool = buildTool({
  name: 'CronList',
  zInputSchema: emptyToolInputZod,
  description: 'List all scheduled cron tasks (both in-memory and durable).',
  inputSchema: [],
  isReadOnly: true,
  isConcurrencySafe: true,
  maxResultChars: 50_000,
  async call() {
    const list = await cronListJobs()
    if (list.length === 0) {
      return { success: true, output: '(no cron tasks)' }
    }
    const lines = list.map((t: CronTask) => {
      const flags = [
        t.recurring !== false ? 'recurring' : 'one-shot',
        t.durable ? 'durable' : 'memory',
        t.permanent ? 'permanent' : '',
        t.agentId ? `agent:${t.agentId}` : '',
      ].filter(Boolean).join(',')
      const lastFired = t.lastFiredAt ? new Date(t.lastFiredAt).toISOString() : 'never'
      return `${t.id}\t${t.cron}\t[${flags}]\tlast:${lastFired}\t${t.prompt.slice(0, 100)}`
    })
    return {
      success: true,
      output: `${list.length}/${50} tasks:\n${lines.join('\n')}`,
    }
  },
})

export const cronDeleteTool = buildTool({
  name: 'CronDelete',
  zInputSchema: cronDeleteInputZod,
  description: 'Delete a cron task by id.',
  inputSchema: [{ name: 'id', type: 'string', description: 'Task id from CronList', required: true }],
  isReadOnly: false,
  isConcurrencySafe: false,
  maxResultChars: 2_000,
  async call({ id: idRaw }, _ctx) {
    const id = String(idRaw ?? '').trim()
    if (!id) return { success: false, error: 'id is required.' }
    const ok = await cronDelete(id)
    return ok
      ? { success: true, output: `Deleted cron task ${id}` }
      : { success: false, error: `No cron task with id ${id}` }
  },
})
