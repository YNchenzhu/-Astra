/**
 * Dominance gate (2026-07) — pins the calibrated injection gate in
 * `rankAutoInvocationSkills`:
 *
 *   gate = max(DISCOVERY_INJECTION_MIN_SCORE,
 *              lowerMedian(positive scores) × DISCOVERY_DOMINANCE_MEDIAN_RATIO)
 *
 * Rationale (see discoveryBudget.ts): CJK unigram/bigram overlap gives
 * every doc-heavy skill a nonzero score against ANY Chinese query, so the
 * old 0.08 floor injected doc/PPT/bid skills into pure-code tasks on every
 * tool turn. Truly relevant skills tower over the pack; flat profiles must
 * inject nothing (the explicit DiscoverSkills tool remains the recall path).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { initSkills } from './skillTool'
import {
  _scoreSkillsForCalibration,
  buildSkillDiscoveryInjection,
} from './skillDiscovery'
import {
  DISCOVERY_DOMINANCE_MEDIAN_RATIO,
  DISCOVERY_INJECTION_MIN_SCORE,
} from './discoveryBudget'

let tmpWs = ''

function writeSkill(name: string, description: string, body = ''): void {
  const dir = path.join(tmpWs, '.claude', 'skills', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body || `Body for ${name}.`}`,
  )
}

describe('skill discovery dominance gate', () => {
  beforeAll(() => {
    tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-domgate-'))
    // One skill with a strong, specific CJK corpus (the "dominant" target).
    writeSkill(
      'complaint-writer',
      '撰写政府采购供应商投诉书，将质疑函升级为合规投诉书。适用于用户提到写投诉书、政府采购投诉、质疑没答复要投诉时。',
      '投诉书模板与撰写流程：依据财政部94号令《政府采购质疑和投诉办法》。',
    )
    // Background pack: doc-flavored skills whose descriptions share plenty of
    // common Chinese characters with everyday queries (the noise source).
    writeSkill('arch-diagram', '生成中式分层架构图，帮助用户绘制平台架构、技术栈分层、模块组件总览图。')
    writeSkill('doc-helper', '帮助用户撰写文档、提案、技术方案等结构化内容，提升写作质量。')
    writeSkill('data-conv', '在 JSON、CSV、XML、YAML 等格式之间转换数据，帮助用户处理表格。')
    writeSkill('research-helper', '深度研究专家，帮助用户进行行业调研、方案对比与事实核查。')
    writeSkill('slide-maker', '制作演示文稿与PPT大纲，帮助用户整理汇报内容与页面结构。')
    initSkills(tmpWs)
  })

  afterAll(() => {
    if (tmpWs) fs.rmSync(tmpWs, { recursive: true, force: true })
    // Restore the default (empty) registry for subsequent test files.
    initSkills()
  })

  it('calibrated constants: floor 8, ratio 2.5', () => {
    expect(DISCOVERY_INJECTION_MIN_SCORE).toBe(8)
    expect(DISCOVERY_DOMINANCE_MEDIAN_RATIO).toBe(2.5)
  })

  it('flat profile (pure-code CJK query) injects NOTHING despite nonzero scores', () => {
    const query = '修复这个函数里的空指针异常，然后跑一下相关单测，确认类型检查通过'
    // Precondition for the regression this test pins: common-character
    // overlap must give several skills a positive score (under the old
    // 0.08 floor these WOULD have been injected).
    const scored = _scoreSkillsForCalibration(query)
    expect(scored.filter((s) => s.score > 0).length).toBeGreaterThanOrEqual(3)

    const { injection, surfacedNames } = buildSkillDiscoveryInjection(query)
    expect(surfacedNames).toEqual([])
    expect(injection).toBe('')
  })

  it('dominant match survives the gate and is injected', () => {
    const { surfacedNames } = buildSkillDiscoveryInjection(
      '帮我写一份政府采购投诉书，之前提交的质疑函没有得到答复',
    )
    expect(surfacedNames).toContain('complaint-writer')
    // The flat background pack must not ride along with the dominant match.
    expect(surfacedNames).not.toContain('data-conv')
    expect(surfacedNames).not.toContain('slide-maker')
  })
})
