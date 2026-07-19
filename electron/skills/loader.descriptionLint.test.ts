/**
 * Description quality lint (skill-attention uplift, 2026-07) tests.
 */

import { describe, expect, it } from 'vitest'
import { lintSkillDescriptionQuality } from './loader'

function lint(
  description: string,
  overrides: Partial<{ whenToUse: string; disableModelInvocation: boolean }> = {},
): string | null {
  return lintSkillDescriptionQuality({
    description,
    disableModelInvocation: overrides.disableModelInvocation ?? false,
    ...(overrides.whenToUse !== undefined ? { whenToUse: overrides.whenToUse } : {}),
  })
}

describe('lintSkillDescriptionQuality', () => {
  it('passes a capability + "Use when" description', () => {
    expect(
      lint(
        'Comprehensive code review for quality and security. Use when users request code review, security audit, or performance analysis.',
      ),
    ).toBeNull()
  })

  it('passes Chinese trigger phrasing (适用于 / 触发场景 / 当用户)', () => {
    expect(
      lint('自主深度研究专家，具备多轮搜索与交叉验证能力。适用于行业调研、技术方案对比、复杂事实核查。'),
    ).toBeNull()
    expect(
      lint('撰写政府采购投诉书的合规写作助手，覆盖94号令要求的全部要素。触发场景：当用户要求写投诉书或升级质疑函时。'),
    ).toBeNull()
  })

  it('flags very short descriptions', () => {
    expect(lint('Review code')).toMatch(/very short/)
  })

  it('flags long descriptions without any trigger scenario', () => {
    expect(
      lint(
        'A sophisticated toolkit that provides many capabilities around code transformation and formatting for large projects.',
      ),
    ).toMatch(/no trigger scenarios/)
  })

  it('a separate when_to_use field satisfies the trigger half', () => {
    expect(
      lint(
        'A sophisticated toolkit that provides many capabilities around code transformation and formatting for large projects.',
        { whenToUse: 'Use when the user asks to reformat or migrate code style.' },
      ),
    ).toBeNull()
  })

  it('never flags manual-only skills', () => {
    expect(lint('x', { disableModelInvocation: true })).toBeNull()
  })
})
