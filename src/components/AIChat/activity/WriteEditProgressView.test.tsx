import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { getNextMultiEditVisibleCount } from './multiEditProgress'
import { WriteEditProgressView } from './WriteEditProgressView'

const edits = [
  { oldString: 'const a = 1', newString: 'const a = 2' },
  { oldString: 'const b = 1', newString: 'const b = 2' },
  { oldString: 'const c = 1', newString: 'const c = 2' },
]

function countMountedSections(html: string): number {
  return html.match(/class="wep-multi-edit-section"/g)?.length ?? 0
}

describe('WriteEditProgressView multi-edit reveal', () => {
  it('reveals at most one additional card per scheduled step', () => {
    expect(getNextMultiEditVisibleCount(1, 5, true)).toBe(2)
    expect(getNextMultiEditVisibleCount(4, 5, true)).toBe(5)
    expect(getNextMultiEditVisibleCount(1, 5, false)).toBe(5)
  })

  it('mounts only the first card initially for a live batch', () => {
    const partialJson = JSON.stringify({ filePath: 'sample.ts', edits })
    const html = renderToStaticMarkup(
      <WriteEditProgressView
        toolName="multi_edit_file"
        input={{}}
        streamingInput={{ partialJson }}
        status="running"
      />,
    )

    expect(countMountedSections(html)).toBe(1)
    expect(html).toContain('data-edit-index="0"')
    expect(html).not.toContain('data-edit-index="1"')
  })

  it('renders every card immediately for completed history', () => {
    const html = renderToStaticMarkup(
      <WriteEditProgressView
        toolName="multi_edit_file"
        input={{ filePath: 'sample.ts', edits }}
        status="completed"
      />,
    )

    expect(countMountedSections(html)).toBe(3)
    expect(html).toContain('data-edit-index="2"')
  })
})
