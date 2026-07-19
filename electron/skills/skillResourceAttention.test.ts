/**
 * Skill-resource attention uplift (2026-07) tests.
 *
 * Covers:
 *   - `extractReferenceHint` — heading / prose / frontmatter / fence rules
 *   - loader integration — `referenceHints` populated, bounded, B2-safe
 *   - `buildSkillResourceManifest` — full paths, hints, scripts, assets
 *   - discovery corpus — reference hints count as ranking signal
 */

import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { clearDynamicSkills, extractReferenceHint, loadSkillsFromDir } from './loader'
import { buildSkillResourceManifest } from './skillTool'
import { scoreSkillRelevanceLexical } from './skillDiscovery'
import { REFERENCE_HINT_MAX_CHARS, MAX_HINTED_REFERENCES } from './discoveryBudget'
import type { SkillDefinition } from './types'

// Platform-aware fixture paths: manifest normalization to forward slashes
// is win32-gated (parity with every other SKILL.md path hint in the repo).
const IS_WIN = process.platform === 'win32'
const BASE_NATIVE = IS_WIN ? 'G:\\skills\\demo' : '/skills/demo'
const BASE_FWD = IS_WIN ? 'G:/skills/demo' : '/skills/demo'

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: 'demo',
    description: 'demo skill',
    source: 'project',
    userInvocable: true,
    disableModelInvocation: false,
    context: 'inline',
    promptContent: 'Body',
    resolvedPath: BASE_NATIVE,
    ...overrides,
  }
}

describe('extractReferenceHint', () => {
  it('prefers the first markdown heading', () => {
    expect(extractReferenceHint('intro prose\n# Real Heading\nmore')).toBe('Real Heading')
  })

  it('falls back to the first prose line', () => {
    expect(extractReferenceHint('First prose line.\nSecond line.')).toBe('First prose line.')
  })

  it('skips YAML frontmatter and code fences', () => {
    expect(
      extractReferenceHint('---\ntitle: x\n---\n```bash\necho hi\n# not a heading, fenced\n## Usage guide\n'),
    ).toBe('not a heading, fenced')
  })

  it('clamps to REFERENCE_HINT_MAX_CHARS', () => {
    const hint = extractReferenceHint(`# ${'H'.repeat(500)}`)
    expect(hint!.length).toBeLessThanOrEqual(REFERENCE_HINT_MAX_CHARS)
    expect(hint!.endsWith('…')).toBe(true)
  })

  it('returns undefined for empty / whitespace heads', () => {
    expect(extractReferenceHint('')).toBeUndefined()
    expect(extractReferenceHint('\n\n  \n')).toBeUndefined()
  })
})

describe('loader — referenceHints integration', () => {
  let tmp: string | null = null
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
    tmp = null
    clearDynamicSkills()
  })

  function writeSkillWithRefs(refs: Record<string, string>): string {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-refhint-'))
    const dir = path.join(tmp, 'hinted')
    fs.mkdirSync(path.join(dir, 'references'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      '---\nname: hinted\ndescription: hinted skill\n---\nBody.',
    )
    for (const [name, content] of Object.entries(refs)) {
      fs.writeFileSync(path.join(dir, 'references', name), content)
    }
    return tmp
  }

  it('populates hints from file heads (bodies stay on disk)', () => {
    const root = writeSkillWithRefs({
      'wiring.md': '# Widget wiring protocol\n\nGiant body here.',
      'empty.md': '',
    })
    const [skill] = loadSkillsFromDir(root, 'project')
    expect(skill.referenceHints).toEqual({ 'wiring.md': 'Widget wiring protocol' })
    // Filename list still carries BOTH files.
    expect(skill.references).toEqual(expect.arrayContaining(['wiring.md', 'empty.md']))
  })

  it('caps hinted files at MAX_HINTED_REFERENCES', () => {
    const refs: Record<string, string> = {}
    for (let i = 0; i < MAX_HINTED_REFERENCES + 5; i++) {
      refs[`r${String(i).padStart(2, '0')}.md`] = `# Doc ${i}`
    }
    const root = writeSkillWithRefs(refs)
    const [skill] = loadSkillsFromDir(root, 'project')
    expect(Object.keys(skill.referenceHints ?? {}).length).toBe(MAX_HINTED_REFERENCES)
  })
})

describe('buildSkillResourceManifest', () => {
  it('returns empty for skills without resolvedPath or resources', () => {
    expect(buildSkillResourceManifest(makeSkill({ resolvedPath: undefined }))).toBe('')
    expect(buildSkillResourceManifest(makeSkill())).toBe('')
  })

  it('renders full forward-slash paths with hints for references', () => {
    const manifest = buildSkillResourceManifest(
      makeSkill({
        references: ['wiring.md', 'faq.md'],
        referenceHints: { 'wiring.md': 'Widget wiring protocol' },
      }),
    )
    expect(manifest).toContain('<skill-resources skill="demo">')
    expect(manifest).toContain(`- ${BASE_FWD}/references/wiring.md — Widget wiring protocol`)
    // No hint → path row without the dash suffix.
    expect(manifest).toContain(`- ${BASE_FWD}/references/faq.md`)
    expect(manifest).toContain('read_file it BEFORE executing')
    expect(manifest).toContain('</skill-resources>')
  })

  it('renders scripts and assets sections when present', () => {
    const manifest = buildSkillResourceManifest(
      makeSkill({
        scripts: ['run.sh'],
        assets: [IS_WIN ? 'G:\\skills\\demo\\assets\\logo.png' : '/skills/demo/assets/logo.png'],
      }),
    )
    expect(manifest).toContain(`- ${BASE_FWD}/scripts/run.sh`)
    expect(manifest).toContain('prefer running these over re-implementing')
    expect(manifest).toContain(`- ${BASE_FWD}/assets/logo.png`)
  })
})

describe('modular-router skills — resourceDocs (bidding-writer-pro shape)', () => {
  let tmp: string | null = null
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
    tmp = null
    clearDynamicSkills()
  })

  /** Replicates `C:\...\.claude\skills\bidding-writer-pro`: SKILL.md router
   *  + common/ + modules/ with CJK filenames, plus _meta.json noise. */
  function writeRouterSkill(): string {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-router-'))
    const dir = path.join(tmp, 'bidding-writer-pro')
    fs.mkdirSync(path.join(dir, 'common'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'modules'), { recursive: true })
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      '---\nname: bidding-writer-pro\ndescription: 投标文件编制专家。适用于撰写投标文件章节。\n---\n任何章节落笔前必须先 Read common/00-前置核心铁律.md。',
    )
    fs.writeFileSync(path.join(dir, '_meta.json'), '{"slug":"bidding-writer-pro"}')
    fs.writeFileSync(
      path.join(dir, 'common', '00-前置核心铁律.md'),
      '# 前置核心铁律\n\n视角、评分原词、空行规则。',
    )
    fs.writeFileSync(
      path.join(dir, 'modules', '05-项目难点分析及解决方案.md'),
      '# 项目难点分析及解决方案\n\n难点章节写作要点。',
    )
    fs.writeFileSync(path.join(dir, 'modules', 'notes.bin'), 'BINARY')
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: x')
    return tmp
  }

  it('loader collects docs from non-standard subdirs with relPath + hint (sorted, filtered)', () => {
    const root = writeRouterSkill()
    const [skill] = loadSkillsFromDir(root, 'project')
    expect(skill.resourceDocs).toEqual([
      { relPath: 'common/00-前置核心铁律.md', hint: '前置核心铁律' },
      { relPath: 'modules/05-项目难点分析及解决方案.md', hint: '项目难点分析及解决方案' },
    ])
    // Standard trio untouched by the new scan; no zombie [].
    expect(skill.references).toBeUndefined()
  })

  it('manifest resolves relative router paths to absolute read_file targets', () => {
    const root = writeRouterSkill()
    const [skill] = loadSkillsFromDir(root, 'project')
    const manifest = buildSkillResourceManifest(skill)
    const base = (skill.resolvedPath ?? '').replace(/\\/g, '/')
    expect(manifest).toContain(`- ${base}/common/00-前置核心铁律.md — 前置核心铁律`)
    expect(manifest).toContain(`- ${base}/modules/05-项目难点分析及解决方案.md`)
    expect(manifest).toContain('Instruction documents')
    expect(manifest).toContain('do not paraphrase it from memory')
    // Bodies stay on disk.
    expect(manifest).not.toContain('难点章节写作要点')
  })

  it('CJK module filenames contribute to discovery ranking', () => {
    const root = writeRouterSkill()
    const [skill] = loadSkillsFromDir(root, 'project')
    const stripped: SkillDefinition = { ...skill, resourceDocs: undefined }
    const q = '帮我写项目难点分析及解决方案'
    expect(scoreSkillRelevanceLexical(q, skill)).toBeGreaterThan(
      scoreSkillRelevanceLexical(q, stripped),
    )
  })
})

describe('discovery ranking — reference hints as signal', () => {
  it('reference filename/hint terms contribute to the lexical score', () => {
    const withRefs = makeSkill({
      references: ['telemetry-pipeline.md'],
      referenceHints: { 'telemetry-pipeline.md': 'Telemetry ingestion pipeline setup' },
    })
    const withoutRefs = makeSkill()
    const q = 'set up the telemetry ingestion pipeline'
    expect(scoreSkillRelevanceLexical(q, withRefs)).toBeGreaterThan(
      scoreSkillRelevanceLexical(q, withoutRefs),
    )
  })
})
