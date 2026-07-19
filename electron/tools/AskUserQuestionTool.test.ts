import { describe, it, expect } from 'vitest'
import {
  normalizeAskUserQuestionsInput,
  validateAskUserQuestionUniqueness,
  validateHtmlPreview,
} from './AskUserQuestionTool'
import { formatAskUserQuestionToolResultText } from './askUserQuestionPrompt'

describe('normalizeAskUserQuestionsInput', () => {
  it('accepts canonical shape', () => {
    const out = normalizeAskUserQuestionsInput({
      questions: [
        {
          header: 'H',
          question: 'Q?',
          options: [
            { label: 'A', description: 'da' },
            { label: 'B', description: 'db' },
          ],
        },
      ],
    })
    expect(out).toHaveLength(1)
    expect(out?.[0].header).toBe('H')
    expect(out?.[0].options[0].description).toBe('da')
  })

  it('maps title/text and fills missing option descriptions', () => {
    const out = normalizeAskUserQuestionsInput({
      questions: [
        {
          title: 'Pick',
          text: 'Which?',
          options: [{ label: 'One' }, { label: 'Two', description: 'second' }],
        },
      ],
    } as Record<string, unknown>)
    expect(out?.[0].header).toBe('Pick')
    expect(out?.[0].question).toBe('Which?')
    expect(out?.[0].options[0].description).toBe('One')
    expect(out?.[0].options[1].description).toBe('second')
  })

  it('parses JSON string questions', () => {
    const json = JSON.stringify([
      {
        header: 'X',
        question: 'Y?',
        options: ['a', 'b'],
      },
    ])
    const out = normalizeAskUserQuestionsInput({ questions: json })
    expect(out?.[0].options).toEqual([
      { label: 'a', description: 'a' },
      { label: 'b', description: 'b' },
    ])
  })

  it('wraps single question object into array', () => {
    const out = normalizeAskUserQuestionsInput({
      questions: {
        header: 'S',
        question: 'OK?',
        options: [{ value: 'v1' }, { label: 'L2', detail: 'd2' }],
      },
    } as Record<string, unknown>)
    expect(out).toHaveLength(1)
    expect(out?.[0].options[0].label).toBe('v1')
    expect(out?.[0].options[0].description).toBe('v1')
    expect(out?.[0].options[1].description).toBe('d2')
  })

  it('returns null for too few options', () => {
    expect(
      normalizeAskUserQuestionsInput({
        questions: [{ header: 'H', question: 'Q', options: [{ label: 'only' }] }],
      } as Record<string, unknown>),
    ).toBeNull()
  })

  it('returns null when more than 4 options (OpenClaude cap)', () => {
    const labels = ['a', 'b', 'c', 'd', 'e']
    expect(
      normalizeAskUserQuestionsInput({
        questions: [
          {
            header: '核心功能',
            question: 'Which?',
            multiSelect: true,
            options: labels.map((l) => ({ label: l, description: l })),
          },
        ],
      }),
    ).toBeNull()
  })

  it('returns null for duplicate question texts', () => {
    expect(
      normalizeAskUserQuestionsInput({
        questions: [
          { header: 'A', question: 'Same?', options: ['x', 'y'] },
          { header: 'B', question: 'Same?', options: ['p', 'q'] },
        ],
      } as Record<string, unknown>),
    ).toBeNull()
  })

  it('returns null for duplicate option labels in one question', () => {
    expect(
      normalizeAskUserQuestionsInput({
        questions: [
          {
            header: 'H',
            question: 'Q?',
            options: [
              { label: 'dup', description: '1' },
              { label: 'dup', description: '2' },
            ],
          },
        ],
      }),
    ).toBeNull()
  })
})

describe('validateAskUserQuestionUniqueness', () => {
  it('accepts unique questions and labels', () => {
    expect(
      validateAskUserQuestionUniqueness([
        {
          header: 'a',
          question: 'Q1?',
          options: [
            { label: 'x', description: 'x' },
            { label: 'y', description: 'y' },
          ],
        },
      ]),
    ).toBe(true)
  })
})

describe('validateHtmlPreview', () => {
  it('rejects full document markers', () => {
    expect(validateHtmlPreview('<html><p>x</p></html>')).toMatch(/fragment/)
  })

  it('accepts minimal fragment', () => {
    expect(validateHtmlPreview('<div>ok</div>')).toBeNull()
  })
})

describe('formatAskUserQuestionToolResultText', () => {
  it('matches OpenClaude-style tool_result prose', () => {
    const s = formatAskUserQuestionToolResultText({
      answers: { 'Pick one?': 'A' },
    })
    expect(s).toContain('User has answered your questions:')
    expect(s).toContain('"Pick one?"="A"')
    expect(s).toContain("user's answers")
  })
})
