/**
 * 编辑器读路径的文本解码(2026-07 富文件审计修复)。
 *
 * 此前 `fs:read-file` 无条件 `readFileSync(p, 'utf-8')`:
 *   - GBK/Big5 等 legacy 编码 → 乱码进 Monaco,保存即永久损坏;
 *   - UTF-16(BOM)→ 乱码;
 *   - 附件管线(attachments/text.ts)早已有 chardet+iconv,编辑器没复用。
 *
 * 这里提供与附件管线同源的检测逻辑,但面向编辑器契约:
 *   - 不截断(编辑器需要完整内容);
 *   - 返回检测到的编码名,供写路径决定迁移策略;
 *   - UTF-16 BOM 优先于 chardet(BOM 是确定信号,chardet 是概率信号)。
 */

import chardet from 'chardet'
import iconv from 'iconv-lite'

/** chardet 采样上限 —— 全量扫描 20MB 文件太慢,64KB 足够判定编码。 */
const CHARDET_SAMPLE_BYTES = 64 * 1024

export interface DecodedEditorText {
  content: string
  /**
   * 检测到的磁盘编码。`'utf-8'` / `'utf16le'` 可被写路径原样回写;
   * 其他值(GBK、GB18030、BIG5、UTF-16BE 等)表示 legacy 编码,
   * 写路径会迁移为 UTF-8 并附带 warning。
   */
  encoding: string
}

export function decodeEditorBuffer(raw: Buffer): DecodedEditorText {
  if (raw.length === 0) return { content: '', encoding: 'utf-8' }

  // UTF-16 BOM —— 确定信号,优先处理(也避开二进制 NUL 检测的误伤)。
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
    return { content: raw.toString('utf16le'), encoding: 'utf16le' }
  }
  if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) {
    const swapped = Buffer.from(raw)
    swapped.swap16()
    return { content: swapped.toString('utf16le'), encoding: 'UTF-16BE' }
  }

  const sample = raw.length > CHARDET_SAMPLE_BYTES ? raw.subarray(0, CHARDET_SAMPLE_BYTES) : raw
  const detected = String(chardet.detect(sample) || 'UTF-8').toUpperCase()
  if (detected === 'UTF-8' || detected === 'ASCII') {
    return { content: raw.toString('utf8'), encoding: 'utf-8' }
  }
  try {
    if (iconv.encodingExists(detected)) {
      return { content: iconv.decode(raw, detected), encoding: detected }
    }
  } catch {
    /* fall through to utf-8 */
  }
  return { content: raw.toString('utf8'), encoding: 'utf-8' }
}

/** 文件是否带 UTF-16 BOM(此类文件含大量 NUL,须跳过二进制嗅探)。 */
export function hasUtf16Bom(raw: Buffer): boolean {
  return (
    raw.length >= 2 &&
    ((raw[0] === 0xff && raw[1] === 0xfe) || (raw[0] === 0xfe && raw[1] === 0xff))
  )
}
