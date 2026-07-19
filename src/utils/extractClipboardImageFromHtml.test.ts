import { describe, expect, it } from 'vitest'
import { extractLargestImageDataUrlFromHtml } from './extractClipboardImageFromHtml'

const big = (n: number) => 'A'.repeat(n)

describe('extractLargestImageDataUrlFromHtml', () => {
  it('returns null when no data:image present', () => {
    expect(extractLargestImageDataUrlFromHtml('<p>hello</p>')).toBeNull()
    expect(extractLargestImageDataUrlFromHtml('')).toBeNull()
  })

  it('extracts a single png data url', () => {
    const b64 = big(64)
    const html = `<img src="data:image/png;base64,${b64}">`
    expect(extractLargestImageDataUrlFromHtml(html)).toEqual({ base64: b64, mediaType: 'image/png' })
  })

  it('normalizes image/jpg to image/jpeg', () => {
    const b64 = big(64)
    const html = `<img src="data:image/jpg;base64,${b64}">`
    expect(extractLargestImageDataUrlFromHtml(html)?.mediaType).toBe('image/jpeg')
  })

  it('picks the largest of multiple images', () => {
    const small = big(40)
    const large = big(200)
    const html = `<img src="data:image/png;base64,${small}"><img src="data:image/webp;base64,${large}">`
    const r = extractLargestImageDataUrlFromHtml(html)
    expect(r?.base64).toBe(large)
    expect(r?.mediaType).toBe('image/webp')
  })

  it('strips embedded whitespace from base64', () => {
    const html = `<img src="data:image/png;base64,${big(32)}\n  ${big(32)}">`
    const r = extractLargestImageDataUrlFromHtml(html)
    expect(r?.base64).toBe(big(64))
  })

  it('rejects tiny payloads under 32 chars', () => {
    const html = `<img src="data:image/png;base64,${big(16)}">`
    expect(extractLargestImageDataUrlFromHtml(html)).toBeNull()
  })

  it('ignores unsupported media types', () => {
    const html = `<img src="data:image/svg+xml;base64,${big(64)}">`
    expect(extractLargestImageDataUrlFromHtml(html)).toBeNull()
  })
})
