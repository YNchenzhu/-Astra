/**
 * Decode a text file buffer with UTF-8 (optional BOM) or UTF-16 LE/BE (BOM).
 */

import { stripUtf8Bom } from './lineEndings'

export function decodeTextFileBuffer(buf: Buffer): string {
  if (buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) {
      let t = new TextDecoder('utf-16le').decode(buf.subarray(2))
      if (t.charCodeAt(0) === 0xfeff) t = t.slice(1)
      return t
    }
    if (buf[0] === 0xfe && buf[1] === 0xff) {
      let t = new TextDecoder('utf-16be').decode(buf.subarray(2))
      if (t.charCodeAt(0) === 0xfeff) t = t.slice(1)
      return t
    }
  }
  return stripUtf8Bom(buf.toString('utf8')).body
}

export function fileStartsWithUtf16Bom(buf: Buffer): boolean {
  return (
    buf.length >= 2 &&
    ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))
  )
}
