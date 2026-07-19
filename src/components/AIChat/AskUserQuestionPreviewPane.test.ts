import { describe, it, expect } from 'vitest'
import { askQuestionUsesPreviewSidebar } from './askUserQuestionPreviewLayout'

describe('askQuestionUsesPreviewSidebar', () => {
  it('is false for multiSelect', () => {
    expect(
      askQuestionUsesPreviewSidebar(
        {
          multiSelect: true,
          options: [{ preview: 'a' }, { preview: 'b' }],
        },
        'markdown',
      ),
    ).toBe(false)
  })

  it('is false without previews', () => {
    expect(
      askQuestionUsesPreviewSidebar(
        { options: [{}, {}] },
        'markdown',
      ),
    ).toBe(false)
  })

  it('is true for single-select with previews and format', () => {
    expect(
      askQuestionUsesPreviewSidebar(
        { options: [{ preview: 'x' }, { preview: 'y' }] },
        'html',
      ),
    ).toBe(true)
  })
})
