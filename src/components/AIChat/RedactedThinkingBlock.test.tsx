/**
 * RedactedThinkingBlock 渲染快照测试。
 *
 * 工作区不依赖 `@testing-library/react`（renderer 测试主要用纯函数测试），
 * 所以这里用 React Test Renderer 风格的 server-side `renderToStaticMarkup`
 * 验证组件输出的 HTML 结构。
 *
 * 测试目标：
 *   1. 组件可调用、无 props 渲染不崩
 *   2. 输出 HTML 包含三段视觉元素（icon / label / hint）
 *   3. 有 `role="note"` 与 `aria-label` 让屏幕阅读器能识别
 */

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RedactedThinkingBlock } from './RedactedThinkingBlock'

describe('RedactedThinkingBlock', () => {
  it('renders without crashing', () => {
    expect(() => renderToStaticMarkup(<RedactedThinkingBlock />)).not.toThrow()
  })

  it('emits role="note" + aria-label for screen readers', () => {
    const html = renderToStaticMarkup(<RedactedThinkingBlock />)
    expect(html).toContain('role="note"')
    expect(html).toMatch(/aria-label="[^"]*加密[^"]*"/)
  })

  it('renders ✻ icon, "Thinking" label, and the encryption hint', () => {
    const html = renderToStaticMarkup(<RedactedThinkingBlock />)
    expect(html).toContain('✻')
    expect(html).toContain('Thinking')
    expect(html).toContain('私密推理已加密')
  })

  it('icon span is aria-hidden so screen readers do not announce the ✻ glyph', () => {
    const html = renderToStaticMarkup(<RedactedThinkingBlock />)
    // React renders aria-hidden={true} as aria-hidden="true" in static markup.
    expect(html).toMatch(/aria-hidden="true"[^>]*>✻/)
  })

  it('uses the expected CSS class names so the standalone CSS file applies', () => {
    const html = renderToStaticMarkup(<RedactedThinkingBlock />)
    expect(html).toContain('redacted-thinking-block')
    expect(html).toContain('redacted-thinking-icon')
    expect(html).toContain('redacted-thinking-label')
    expect(html).toContain('redacted-thinking-hint')
  })
})
