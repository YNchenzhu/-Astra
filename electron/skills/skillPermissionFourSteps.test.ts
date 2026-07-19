/**
 * AC-9.6 — four-step matrix (documented parity with upstream SkillTool §9.3–9.6):
 * 1) SAFE_SKILL_PROPERTIES whitelist
 * 2) `skill:` permission rules
 * 3) Plan-mode ask skip for safe-frontmatter Skill tool
 * 4) PreSkillUse phase (hook engine) callable contract
 */

import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  SAFE_SKILL_PROPERTIES,
  shouldSkipPlanModeAskForSafeSkill,
  skillUsesOnlySafeFrontmatterKeys,
} from './safeSkillProperties'
import { resolveToolPermissionMode } from '../ai/permissionRuleMatch'
import { runPreSkillUsePhase } from '../ai/hookIntegration'
import { resetHooks, setHooksConfig } from '../tools/hooks/config'

describe('Skill permission four steps (AC-9.6)', () => {
  afterEach(() => {
    resetHooks()
    vi.unstubAllGlobals()
  })

  it('step 1: whitelist size and unknown key rejection', () => {
    expect(SAFE_SKILL_PROPERTIES.size).toBe(38)
    expect(skillUsesOnlySafeFrontmatterKeys(['name', 'description'])).toBe(true)
    expect(skillUsesOnlySafeFrontmatterKeys(['name', 'unsafe-key'])).toBe(false)
  })

  it('step 2: skill: pattern resolves deny for Skill tool', () => {
    const { effectiveMode } = resolveToolPermissionMode(
      'Skill',
      'ask',
      [{ id: 'r1', pattern: 'skill:alpha-beta', mode: 'deny' }],
      { skillInvocationName: 'alpha-beta' },
    )
    expect(effectiveMode).toBe('deny')
  })

  it('step 3: plan-mode ask skip only when frontmatter keys are all safe', () => {
    const findSkill = vi.fn((name: string) =>
      name === 'safe-skill'
        ? { frontmatterKeys: ['name', 'description'] }
        : { frontmatterKeys: ['name', 'unsafe-key'] },
    )
    expect(
      shouldSkipPlanModeAskForSafeSkill({
        toolName: 'Skill',
        skillInvocationName: 'safe-skill',
        currentMode: 'plan',
        requiresAsk: true,
        findSkill,
      }),
    ).toBe(true)
    expect(
      shouldSkipPlanModeAskForSafeSkill({
        toolName: 'Skill',
        skillInvocationName: 'bad-skill',
        currentMode: 'plan',
        requiresAsk: true,
        findSkill,
      }),
    ).toBe(false)
    expect(
      shouldSkipPlanModeAskForSafeSkill({
        toolName: 'Read',
        skillInvocationName: 'safe-skill',
        currentMode: 'plan',
        requiresAsk: true,
        findSkill,
      }),
    ).toBe(false)
  })

  it('step 4: PreSkillUse runs without blocking when no hooks configured', async () => {
    resetHooks()
    const pre = await runPreSkillUsePhase('any-skill', { skill: 'any-skill', args: '' }, process.cwd())
    expect(pre.blocked).toBe(false)
  })

  it('step 4b: PreSkillUse blocks when hook returns deny', async () => {
    setHooksConfig(
      [
        {
          id: 'block-skill',
          event: 'PreSkillUse',
          command: 'node -e "console.log(JSON.stringify({continue:false}))"',
          enabled: true,
          matcher: 'blocked-skill',
        },
      ],
      false,
    )
    const pre = await runPreSkillUsePhase(
      'blocked-skill',
      { skill: 'blocked-skill', args: '' },
      process.cwd(),
    )
    expect(pre.blocked).toBe(true)
  })
})
