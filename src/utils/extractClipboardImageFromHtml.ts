/**
 * Rich paste (Word, some browsers) exposes images as `data:image/...;base64,...` inside `text/html`.
 */
export function extractLargestImageDataUrlFromHtml(
  html: string,
): { base64: string; mediaType: string } | null {
  if (!html?.includes('data:image')) return null
  const re = /data:(image\/(?:png|jpeg|jpg|gif|webp));base64,([A-Za-z0-9+/=\s]+)/gi
  let best: { base64: string; mediaType: string; len: number } | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const base64 = m[2]!.replace(/\s+/g, '')
    const rawMt = m[1]!.toLowerCase()
    const mediaType = rawMt === 'image/jpg' ? 'image/jpeg' : rawMt
    if (base64.length > (best?.len ?? 0)) {
      best = { base64, mediaType, len: base64.length }
    }
  }
  if (!best || best.len < 32) return null
  return { base64: best.base64, mediaType: best.mediaType }
}
