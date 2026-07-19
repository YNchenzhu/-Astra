import { afterEach, describe, expect, it } from 'vitest'
import {
  getToolSchedulerMode,
  isSchedulerDriveEnabled,
  isSchedulerShadowEnabled,
} from '../scheduler'

const KEYS = [
  'POLE_TOOL_SCHEDULER_MODE',
  'POLE_TOOL_SCHEDULER_ACTIVE',
  'POLE_TOOL_SCHEDULER_DRIVE',
] as const

afterEach(() => {
  for (const key of KEYS) delete process.env[key]
})

describe('ToolScheduler rollout mode', () => {
  it('defaults to legacy', () => {
    expect(getToolSchedulerMode()).toBe('legacy')
    expect(isSchedulerShadowEnabled()).toBe(false)
    expect(isSchedulerDriveEnabled()).toBe(false)
  })

  it('maps legacy ACTIVE to shadow and DRIVE to hold', () => {
    process.env.POLE_TOOL_SCHEDULER_ACTIVE = '1'
    expect(getToolSchedulerMode()).toBe('shadow')
    expect(isSchedulerShadowEnabled()).toBe(true)
    expect(isSchedulerDriveEnabled()).toBe(false)

    process.env.POLE_TOOL_SCHEDULER_DRIVE = '1'
    expect(getToolSchedulerMode()).toBe('hold')
    expect(isSchedulerDriveEnabled()).toBe(true)
  })

  it('gives the new explicit variable precedence', () => {
    process.env.POLE_TOOL_SCHEDULER_ACTIVE = '1'
    process.env.POLE_TOOL_SCHEDULER_DRIVE = '1'
    process.env.POLE_TOOL_SCHEDULER_MODE = 'authoritative'
    expect(getToolSchedulerMode()).toBe('authoritative')
    expect(isSchedulerShadowEnabled()).toBe(true)
    expect(isSchedulerDriveEnabled()).toBe(true)
  })
})
