import { describe, expect, it } from 'vitest'
import { isPlanTabName, stripFrontmatter, synthesizePlanMarkdown } from './planTab'
import type { PlanApprovalRequestDisplay } from '../types'

describe('isPlanTabName', () => {
  it('matches *.plan.md case-insensitively', () => {
    expect(isPlanTabName('foo.plan.md')).toBe(true)
    expect(isPlanTabName('FOO.PLAN.MD')).toBe(true)
    expect(isPlanTabName('计划预览.plan.md')).toBe(true)
  })

  it('rejects non-plan names', () => {
    expect(isPlanTabName('foo.md')).toBe(false)
    expect(isPlanTabName('plan.md.txt')).toBe(false)
    expect(isPlanTabName('')).toBe(false)
  })
})

describe('stripFrontmatter', () => {
  it('removes a leading YAML frontmatter block', () => {
    const md = '---\ntitle: x\nstatus: draft\n---\n# Body\ntext'
    expect(stripFrontmatter(md)).toBe('# Body\ntext')
  })

  it('handles CRLF line endings', () => {
    const md = '---\r\ntitle: x\r\n---\r\nBody'
    expect(stripFrontmatter(md)).toBe('Body')
  })

  it('tolerates a leading BOM before frontmatter', () => {
    const md = '\uFEFF---\ntitle: x\n---\nBody'
    expect(stripFrontmatter(md)).toBe('Body')
  })

  it('leaves content without frontmatter untouched', () => {
    expect(stripFrontmatter('# Just a heading\n\nbody')).toBe('# Just a heading\n\nbody')
  })

  it('does not strip a horizontal rule that is not frontmatter', () => {
    const md = '# Title\n\n---\n\nmore'
    expect(stripFrontmatter(md)).toBe(md)
  })
})

describe('synthesizePlanMarkdown', () => {
  it('uses default title when name missing', () => {
    const req = {} as PlanApprovalRequestDisplay
    const out = synthesizePlanMarkdown(req)
    expect(out.startsWith('# 实施计划')).toBe(true)
  })

  it('renders overview and plan markdown sections', () => {
    const req = {
      name: 'My Plan',
      overview: 'the why',
      planMarkdown: 'free-form plan',
    } as PlanApprovalRequestDisplay
    const out = synthesizePlanMarkdown(req)
    expect(out).toContain('# My Plan')
    expect(out).toContain('the why')
    expect(out).toContain('## 计划')
    expect(out).toContain('free-form plan')
  })

  it('renders phases with todo checkboxes and status suffixes', () => {
    const req = {
      name: 'P',
      phases: [
        {
          name: 'Phase 1',
          todos: [
            { content: 'done item', status: 'completed' },
            { content: 'cancelled item', status: 'cancelled' },
            { content: 'active item', status: 'in_progress' },
            { content: 'todo item', status: 'pending' },
          ],
        },
      ],
    } as PlanApprovalRequestDisplay
    const out = synthesizePlanMarkdown(req)
    expect(out).toContain('## Phase 1 (4 项)')
    expect(out).toContain('- [x] done item')
    expect(out).toContain('- [x] cancelled item (已取消)')
    expect(out).toContain('- [ ] active item ⟳ (进行中)')
    expect(out).toContain('- [ ] todo item')
  })

  it('falls back to flat todos when no phases', () => {
    const req = {
      name: 'P',
      todos: [{ content: 'only step', status: 'pending' }],
    } as PlanApprovalRequestDisplay
    const out = synthesizePlanMarkdown(req)
    expect(out).toContain('## 步骤')
    expect(out).toContain('- [ ] only step')
  })

  it('prefers phases over flat todos when both present', () => {
    const req = {
      name: 'P',
      phases: [{ name: 'Ph', todos: [{ content: 'p-todo', status: 'pending' }] }],
      todos: [{ content: 'flat-todo', status: 'pending' }],
    } as PlanApprovalRequestDisplay
    const out = synthesizePlanMarkdown(req)
    expect(out).toContain('p-todo')
    expect(out).not.toContain('flat-todo')
    expect(out).not.toContain('## 步骤')
  })
})
