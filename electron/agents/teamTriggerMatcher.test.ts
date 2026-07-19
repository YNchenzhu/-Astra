/**
 * Tests for `teamTriggerMatcher` — the pure heuristic that maps user text to
 * the most-relevant `TeamTemplate` in the active Bundle.
 */
import { describe, expect, it } from 'vitest'
import {
  formatSuggestionHint,
  matchTeamTrigger,
  tokenise,
  TEAM_SUGGEST_MIN_SCORE,
} from './teamTriggerMatcher'
import type { TeamTemplate } from './bundles/types'

function tpl(
  id: string,
  name: string,
  description: string,
  members: Array<{ agentType: string; role?: string }>,
  triggers?: TeamTemplate['triggers'],
): TeamTemplate {
  return {
    id,
    name,
    description,
    coordination: 'parallel',
    members,
    ...(triggers ? { triggers } : {}),
  }
}

describe('tokenise', () => {
  it('extracts lowercased Latin words ≥ 2 chars', () => {
    const { words } = tokenise('Find the AuthService crash in session-memory')
    expect(words.has('find')).toBe(true)
    expect(words.has('authservice')).toBe(true)
    expect(words.has('crash')).toBe(true)
    expect(words.has('session-memory')).toBe(true)
    // 'in' is only 2 chars — included. 't', 'e' etc. filtered by ≥2 rule.
    expect(words.has('the')).toBe(true)
  })

  it('extracts sliding CJK bigrams', () => {
    const { cjkBigrams } = tokenise('帮我审这份合同的条款')
    // 帮我 / 我审 / 审这 / 这份 / 份合 / 合同 / 同的 / 的条 / 条款
    expect(cjkBigrams.has('合同')).toBe(true)
    expect(cjkBigrams.has('条款')).toBe(true)
    expect(cjkBigrams.has('我审')).toBe(true)
  })

  it('handles mixed CJK + Latin', () => {
    const { words, cjkBigrams } = tokenise('用 Verification agent 跑一遍测试')
    expect(words.has('verification')).toBe(true)
    expect(words.has('agent')).toBe(true)
    expect(cjkBigrams.has('跑一')).toBe(true)
    expect(cjkBigrams.has('测试')).toBe(true)
  })

  it('empty / whitespace → empty sets', () => {
    expect(tokenise('').words.size).toBe(0)
    expect(tokenise('   ').cjkBigrams.size).toBe(0)
  })
})

describe('matchTeamTrigger', () => {
  const teams: TeamTemplate[] = [
    tpl(
      'contract-review',
      '合同审阅三人组',
      '条款核查 判例比对 风险识别',
      [
        { agentType: '条款核查员', role: 'clause-verifier' },
        { agentType: '判例比对员', role: 'precedent-matcher' },
        { agentType: '风险识别员', role: 'risk-scanner' },
      ],
    ),
    tpl(
      'incident-postmortem',
      'Incident Postmortem Team',
      'Analyse an outage: timeline, root cause, action items',
      [
        { agentType: 'Explore', role: 'timeline-reconstructor' },
        { agentType: 'Debug', role: 'root-cause-analyst' },
        { agentType: 'Verification', role: 'action-item-scribe' },
      ],
    ),
    tpl(
      'sales-prep',
      '售前准备小组',
      '需求梳理 方案草拟 报价估算',
      [
        { agentType: '需求分析师' },
        { agentType: '方案设计师' },
      ],
    ),
  ]

  it('Chinese legal prompt ranks the legal template first', () => {
    const matches = matchTeamTrigger('帮我审一下这份合同的条款和风险', teams)
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0]?.template.id).toBe('contract-review')
    expect(matches[0]?.matchedCjkBigrams).toContain('合同')
  })

  it('English postmortem prompt ranks the postmortem template first', () => {
    const matches = matchTeamTrigger(
      'Our auth service crashed last night — find the root cause and write action items',
      teams,
    )
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0]?.template.id).toBe('incident-postmortem')
    expect(matches[0]?.matchedWords.join(',')).toMatch(/root|cause|action/)
  })

  it('returns empty when user text has no overlap with any template', () => {
    const matches = matchTeamTrigger('random text nothing matches', teams)
    expect(matches).toHaveLength(0)
  })

  it('returns empty for empty input', () => {
    expect(matchTeamTrigger('', teams)).toHaveLength(0)
    expect(matchTeamTrigger('   ', teams)).toHaveLength(0)
  })

  it('returns empty when teams array is empty', () => {
    expect(matchTeamTrigger('anything goes here', [])).toHaveLength(0)
  })

  it('respects the minimum-score threshold (one-bigram hits stay below)', () => {
    // A single CJK bigram hit = 1 point, below TEAM_SUGGEST_MIN_SCORE (2).
    expect(TEAM_SUGGEST_MIN_SCORE).toBeGreaterThanOrEqual(2)
    const weakMatches = matchTeamTrigger('合x', teams)
    expect(weakMatches).toHaveLength(0)
  })

  it('is stable-ordered: same score → insertion order preserved', () => {
    // Two templates that will score identically on a generic prompt.
    const twins: TeamTemplate[] = [
      tpl('alpha', 'Alpha Team', 'write code review', [{ agentType: 'A' }]),
      tpl('beta', 'Beta Team', 'write code review', [{ agentType: 'B' }]),
    ]
    const matches = matchTeamTrigger('write code review', twins)
    expect(matches.map((m) => m.template.id)).toEqual(['alpha', 'beta'])
  })
})

describe('formatSuggestionHint', () => {
  const teams: TeamTemplate[] = [
    tpl(
      'contract-review',
      '合同审阅三人组',
      '条款核查 判例比对 风险识别',
      [{ agentType: '条款核查员', role: 'clause-verifier' }],
    ),
  ]

  it('returns null when no matches', () => {
    expect(formatSuggestionHint('hello world', [])).toBeNull()
  })

  it('renders a TeamCreate call in the hint body', () => {
    const matches = matchTeamTrigger('审一下合同条款', teams)
    const hint = formatSuggestionHint('审一下合同条款', matches)
    expect(hint).not.toBeNull()
    expect(hint).toContain('合同审阅三人组')
    expect(hint).toContain('TeamCreate')
    expect(hint).toContain('template: "contract-review"')
    expect(hint).toContain('advisory')
  })

  it('includes matched-token breadcrumbs so the AI can sanity-check', () => {
    const matches = matchTeamTrigger('帮我核查合同条款', teams)
    const hint = formatSuggestionHint('帮我核查合同条款', matches)
    expect(hint).toMatch(/中文关键词/)
    // Matched bigrams like 合同 / 条款 / 核查 should appear.
    expect(hint).toMatch(/合同|条款|核查/)
  })
})

describe('matchTeamTrigger — explicit triggers', () => {
  it('keywords: any-of hit wins over implicit competitor', () => {
    // Two candidates: explicit-keyword template vs implicit-only template
    // whose surface tokens accidentally overlap with the user message a lot.
    const sales = tpl(
      'sales-pipeline',
      '销售流水',
      '处理客户接洽与报价',  // surface tokens won't fire on "deals"
      [{ agentType: '销售员' }],
      [{ keywords: ['deal', 'pipeline', 'quote'] }],
    )
    const noisy = tpl(
      'noisy',
      '客户接洽与报价 处理 deal pipeline quote 销售',
      '客户 接洽 报价 deal pipeline quote 销售 处理',
      [{ agentType: 'A' }],
    )
    const matches = matchTeamTrigger('Update the deal pipeline for Acme', [noisy, sales])
    expect(matches[0]?.template.id).toBe('sales-pipeline')
    expect(matches[0]?.explicit).toBeDefined()
    expect(matches[0]?.explicit?.matchedKeywords.sort()).toEqual(['deal', 'pipeline'])
  })

  it('allKeywords: requires every keyword present', () => {
    const tplStrict = tpl(
      'strict',
      'Strict Match Team',
      '',
      [{ agentType: 'A' }],
      [{ allKeywords: ['migrate', 'database'] }],
    )
    // Only one of the two → no allKeywords bonus, no loose `keywords` field
    // either, so the rule scores 0 → no match.
    expect(matchTeamTrigger('migrate the auth code', [tplStrict])).toEqual([])
    // Both present → allKeywords satisfied.
    const matches = matchTeamTrigger('migrate the database to v2', [tplStrict])
    expect(matches).toHaveLength(1)
    expect(matches[0]?.explicit?.allKeywordsSatisfied).toBe(true)
  })

  it('regex: case-insensitive match contributes a hit', () => {
    const re = tpl(
      'incident',
      'Incident',
      '',
      [{ agentType: 'A' }],
      [{ regex: ['\\b(p[0-3]|sev[0-2])\\b'] }],
    )
    expect(matchTeamTrigger('We have a P1 outage', [re])).toHaveLength(1)
    expect(matchTeamTrigger('Sev2 incident reported', [re])).toHaveLength(1)
    expect(matchTeamTrigger('routine maintenance', [re])).toHaveLength(0)
  })

  it('regex: malformed pattern is silently skipped (does not crash matcher)', () => {
    const broken = tpl(
      'broken',
      'Broken Regex',
      '',
      [{ agentType: 'A' }],
      [{ regex: ['(unbalanced'] }],
    )
    // No throw — matcher returns empty (no rule scored).
    expect(() => matchTeamTrigger('anything', [broken])).not.toThrow()
    expect(matchTeamTrigger('anything', [broken])).toEqual([])
  })

  it('excludeKeywords: vetoes the rule even when keywords would otherwise hit', () => {
    const t = tpl(
      'release',
      'Release Pipeline',
      '',
      [{ agentType: 'A' }],
      [{ keywords: ['release'], excludeKeywords: ['release notes'] }],
    )
    expect(matchTeamTrigger('start a release', [t])).toHaveLength(1)
    // "release notes" present → veto, no match
    expect(matchTeamTrigger('write the release notes', [t])).toHaveLength(0)
  })

  it('excludeKeywords: also blocks the implicit fallback (author intent dominates)', () => {
    // The template's surface tokens (`release pipeline ship deploy`)
    // would otherwise fire on the implicit path; the explicit veto must
    // override that, otherwise excludeKeywords would be a no-op whenever
    // the template's own description echoes the user's text.
    const t = tpl(
      'release',
      'Release Pipeline',
      'release pipeline ship deploy',
      [{ agentType: 'A' }],
      [{ keywords: ['release'], excludeKeywords: ['release notes'] }],
    )
    const matches = matchTeamTrigger('write the release notes for v1.2', [t])
    expect(matches).toHaveLength(0)
  })

  it('multiple triggers: best-scoring non-vetoed rule wins', () => {
    const t = tpl(
      'multi',
      'Multi Rule',
      '',
      [{ agentType: 'A' }],
      [
        { keywords: ['draft'] }, // light hit
        { allKeywords: ['draft', 'contract'] }, // heavier hit when both present
      ],
    )
    const matchesLight = matchTeamTrigger('draft a memo', [t])
    expect(matchesLight).toHaveLength(1)
    const matchesHeavy = matchTeamTrigger('draft this contract', [t])
    expect(matchesHeavy).toHaveLength(1)
    // The heavy match must score strictly higher than the light one.
    expect(matchesHeavy[0]!.score).toBeGreaterThan(matchesLight[0]!.score)
  })

  it('explicit fully vetoed → falls back to implicit on the same template', () => {
    // Veto the explicit rule, then the same template still has implicit
    // surface tokens that should make it match the message anyway.
    const t = tpl(
      'fallback-test',
      'Fallback',
      '诊断 病情 三人组',
      [{ agentType: '诊断员' }],
      [{ keywords: ['stop'], excludeKeywords: ['stop'] }],
    )
    // "stop" → vetoed AND vetoed keyword === keyword (so explicit returns null).
    // But implicit surface includes 诊断/病情/三人组 → should fire on 中文 prompt.
    const matches = matchTeamTrigger('帮我诊断这个病情', [t])
    expect(matches).toHaveLength(1)
    expect(matches[0]?.explicit).toBeUndefined() // came from implicit path
  })

  it('minConfidence raises the bar above a single hit', () => {
    const t = tpl(
      'high-bar',
      'High Bar',
      '',
      [{ agentType: 'A' }],
      [{ keywords: ['report'], minConfidence: 1000 }],
    )
    // One keyword hit ≈ 100, well below 1000 → rule scores 0 → no match.
    expect(matchTeamTrigger('write a report', [t])).toEqual([])
  })

  it('explicit hint surfaces the "high confidence" tag and matched keywords', () => {
    const t = tpl(
      'q1-review',
      'Q1 Review Team',
      '',
      [{ agentType: 'A' }],
      [{ keywords: ['quarterly', 'q1'] }],
    )
    const matches = matchTeamTrigger('Run the q1 quarterly review', [t])
    const hint = formatSuggestionHint('Run the q1 quarterly review', matches)
    expect(hint).toContain('高置信度')
    expect(hint).toContain('作者声明关键词')
    expect(hint).toMatch(/quarterly|q1/i)
  })

  it('legacy bundles without `triggers` keep working via implicit fallback', () => {
    // Same shape as the original tests — no triggers field anywhere.
    const legacy = tpl(
      'legacy',
      '应急响应',
      '事故 排查 修复',
      [{ agentType: '排查员' }],
    )
    const matches = matchTeamTrigger('帮我事故排查', [legacy])
    expect(matches).toHaveLength(1)
    expect(matches[0]?.explicit).toBeUndefined()
  })
})
