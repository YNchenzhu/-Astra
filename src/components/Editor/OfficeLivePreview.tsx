/**
 * OfficeLivePreview —— 编辑器 tab 的 Office 原格式预览。
 *
 * 与 `FilePreview`(走 attachment ingest pipeline 生成 Markdown + 缩略图,
 * 为 chat/AI 消费服务)不同,这个组件是给**用户**看的 —— 目标是尽量接近
 * 在 Microsoft Office 里打开的视觉效果:字体、字号、颜色、段落、表格
 * 边框、合并单元格、图片等。
 *
 * 实现:
 *   - .docx → `docx-preview`(VolodymyrBaydalka/docxjs):纯浏览器渲染,
 *     把 docx 的 XML 转成带 inline style 的 DOM,保留绝大多数原生样式。
 *   - .xlsx → `exceljs` 读 workbook + 自绘 HTML <table>,保留:
 *     • 合并单元格 (rowspan/colspan)
 *     • 字体(family / size / bold / italic / 色)
 *     • 单元格背景 / 边框
 *     • 对齐(horizontal/vertical)
 *     • 列宽 / 行高
 *     • 多 sheet 标签页切换
 *   - 走新 IPC `fs:read-file-binary` 取原始字节,不经 mammoth 的 lossy
 *     Markdown 转换。
 *
 * 这里不处理 .pdf / .doc / .xls / .pptx —— 它们继续走 `FilePreview` 的
 * LibreOffice / pdfjs / mammoth 路径(那些要么是无损的,要么无替代)。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, AlertTriangle, RefreshCw } from 'lucide-react'
import { readFileBinary } from '../../services/fileSystem'
import { onWorkspaceFileChanged } from '../../services/fileSystem'
import './OfficeLivePreview.css'

export interface OfficeLivePreviewProps {
  filePath: string
  fileName: string
}

function getExt(name: string): string {
  const idx = name.lastIndexOf('.')
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : ''
}

type Phase = 'idle' | 'loading' | 'ready' | 'error'

export const OfficeLivePreview: React.FC<OfficeLivePreviewProps> = ({
  filePath,
  fileName,
}) => {
  const ext = useMemo(() => getExt(fileName), [fileName])
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  const [bytes, setBytes] = useState<Uint8Array | null>(null)

  // 读磁盘字节
  useEffect(() => {
    let cancelled = false
    // File-load effect resets the "loading / error" surface before the
    // async read starts. Expressing this in render phase would require
    // a `lastPath` ref dance — exactly the rule's target anti-pattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPhase('loading')
     
    setError(null)
    readFileBinary(filePath)
      .then((b) => {
        if (cancelled) return
        setBytes(b)
        setPhase('ready')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setPhase('error')
      })
    return () => {
      cancelled = true
    }
  }, [filePath, reloadNonce])

  // 文件外部改动 → 自动重载
  useEffect(() => {
    const unsub = onWorkspaceFileChanged((evt) => {
      if (!evt?.filePath) return
      const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
      if (norm(evt.filePath) === norm(filePath)) {
        setReloadNonce((n) => n + 1)
      }
    })
    return () => {
      unsub?.()
    }
  }, [filePath])

  const handleReload = useCallback(() => setReloadNonce((n) => n + 1), [])

  if (phase === 'loading' || phase === 'idle') {
    return (
      <div className="office-preview-status">
        <Loader2 size={18} className="is-spinning" />
        <span>正在加载 {fileName}…</span>
      </div>
    )
  }
  if (phase === 'error') {
    return (
      <div className="office-preview-status is-error">
        <AlertTriangle size={18} />
        <div className="office-preview-error-body">
          <div>打开失败:{error ?? '未知错误'}</div>
          <button
            type="button"
            className="office-preview-retry"
            onClick={handleReload}
          >
            <RefreshCw size={11} /> 重试
          </button>
        </div>
      </div>
    )
  }
  if (!bytes) return null

  if (ext === 'docx') {
    return <DocxPane bytes={bytes} />
  }
  if (ext === 'xlsx') {
    return <XlsxPane bytes={bytes} />
  }
  return (
    <div className="office-preview-status">
      <span>不支持在此预览:{ext}</span>
    </div>
  )
}

// ─── .docx 渲染 ───────────────────────────────────────────────────

const DocxPane: React.FC<{ bytes: Uint8Array }> = ({ bytes }) => {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [renderErr, setRenderErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const host = hostRef.current
    if (!host) return
    // 清空旧 DOM,避免重新渲染时叠加
    host.innerHTML = ''
    setRenderErr(null)

    // 动态 import 减小首屏体积;docx-preview 只在第一次打开 docx 时才加载。
    void import('docx-preview')
      .then((mod) => {
        if (cancelled) return
        const renderAsync =
          (mod as unknown as { renderAsync: (...args: unknown[]) => Promise<unknown> }).renderAsync
        if (typeof renderAsync !== 'function') {
          throw new Error('docx-preview 导出缺失 renderAsync')
        }
        // ArrayBuffer 输入。renderAsync 签名:(data, bodyContainer, styleContainer?, options?)
        return renderAsync(bytes.slice().buffer, host, undefined, {
          className: 'astra-docx',
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          ignoreFonts: false,
          breakPages: true,
          experimental: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          debug: false,
        })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setRenderErr(err instanceof Error ? err.message : String(err))
      })

    return () => {
      cancelled = true
    }
  }, [bytes])

  return (
    <div className="office-preview-scroll">
      {renderErr ? (
        <div className="office-preview-status is-error">
          <AlertTriangle size={14} />
          <span>渲染失败:{renderErr}</span>
        </div>
      ) : null}
      <div ref={hostRef} className="office-preview-docx-host" />
    </div>
  )
}

// ─── .xlsx 渲染(exceljs + 自绘 HTML table,保留样式) ──────────────

interface XlsxSheetVM {
  name: string
  columns: number[] // 每列宽度(近似像素,用于 colgroup)
  rows: XlsxCellVM[][]
  rowHeights: number[] // 每行高度
  mergedMap: Map<string, { rowspan: number; colspan: number }> // key = "r,c"
  skipMap: Set<string> // 被合并吞掉的 "r,c"
}

interface XlsxCellVM {
  value: string
  style: React.CSSProperties
  title?: string
}

const DEFAULT_COL_WIDTH_PX = 92
const DEFAULT_ROW_HEIGHT_PX = 22

function argbToCss(argb: string | undefined): string | undefined {
  if (!argb) return undefined
  // exceljs 返回 "FFRRGGBB" (AARRGGBB);转 rgba
  const m = /^([0-9A-Fa-f]{2})?([0-9A-Fa-f]{6})$/.exec(argb)
  if (!m) return undefined
  const a = m[1] ? parseInt(m[1], 16) / 255 : 1
  const rgb = m[2]!
  return `rgba(${parseInt(rgb.slice(0, 2), 16)}, ${parseInt(rgb.slice(2, 4), 16)}, ${parseInt(rgb.slice(4, 6), 16)}, ${a})`
}

function borderStyle(border: { style?: string; color?: { argb?: string } } | undefined): string | undefined {
  if (!border?.style) return undefined
  const map: Record<string, string> = {
    thin: '1px solid',
    medium: '1.5px solid',
    thick: '2px solid',
    hair: '0.5px solid',
    dashed: '1px dashed',
    dotted: '1px dotted',
    double: '3px double',
    mediumDashed: '1.5px dashed',
    dashDot: '1px dashed',
    mediumDashDot: '1.5px dashed',
    dashDotDot: '1px dotted',
    mediumDashDotDot: '1.5px dotted',
    slantDashDot: '1px dashed',
  }
  const s = map[border.style] ?? '1px solid'
  const color = argbToCss(border.color?.argb) ?? 'var(--border-color, #888)'
  return `${s} ${color}`
}

const XlsxPane: React.FC<{ bytes: Uint8Array }> = ({ bytes }) => {
  const [sheets, setSheets] = useState<XlsxSheetVM[] | null>(null)
  const [activeSheet, setActiveSheet] = useState(0)
  const [renderErr, setRenderErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setRenderErr(null)
    void (async () => {
      try {
        const ExcelJS = (await import('exceljs')).default ?? (await import('exceljs'))
        // exceljs 在 browser 包里既有 default 又有 namespace,做一次兼容兜底
        const Workbook =
          (ExcelJS as unknown as { Workbook: new () => unknown }).Workbook ??
          ((ExcelJS as unknown as { default: { Workbook: new () => unknown } }).default
            ?.Workbook)
        if (!Workbook) throw new Error('exceljs Workbook 构造器不可用')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const wb = new (Workbook as any)()
        await wb.xlsx.load(bytes.slice().buffer)
        if (cancelled) return

        const vms: XlsxSheetVM[] = []
        for (const ws of wb.worksheets) {
          const mergedMap = new Map<string, { rowspan: number; colspan: number }>()
          const skipMap = new Set<string>()
          // exceljs merges:迭代模型里 merges 字段
          const merges = ((ws as unknown as { _merges?: Record<string, { top: number; left: number; bottom: number; right: number }> })._merges) ?? {}
          for (const key of Object.keys(merges)) {
            const m = merges[key]
            if (!m) continue
            const r0 = m.top
            const c0 = m.left
            const rspan = m.bottom - m.top + 1
            const cspan = m.right - m.left + 1
            mergedMap.set(`${r0},${c0}`, { rowspan: rspan, colspan: cspan })
            for (let r = r0; r <= m.bottom; r++) {
              for (let c = c0; c <= m.right; c++) {
                if (r === r0 && c === c0) continue
                skipMap.add(`${r},${c}`)
              }
            }
          }

          const rowCount = ws.rowCount || 0
          const colCount = ws.columnCount || 0
          const columns: number[] = []
          for (let c = 1; c <= colCount; c++) {
            // exceljs getColumn(c).width 是字符宽度,大约 * 7 → 像素近似
            const col = ws.getColumn(c)
            const w =
              col && typeof col.width === 'number' && col.width > 0
                ? Math.round(col.width * 7.5)
                : DEFAULT_COL_WIDTH_PX
            columns.push(w)
          }

          const rows: XlsxCellVM[][] = []
          const rowHeights: number[] = []
          for (let r = 1; r <= rowCount; r++) {
            const row = ws.getRow(r)
            rowHeights.push(
              row && typeof row.height === 'number' && row.height > 0
                ? Math.round(row.height * 1.3)
                : DEFAULT_ROW_HEIGHT_PX,
            )
            const rowVM: XlsxCellVM[] = []
            for (let c = 1; c <= colCount; c++) {
              const cell = ws.getCell(r, c)
              const text = cellText(cell)
              const style = cellCssStyle(cell)
              rowVM.push({ value: text, style, title: text })
            }
            rows.push(rowVM)
          }
          vms.push({ name: ws.name || `Sheet${vms.length + 1}`, columns, rows, rowHeights, mergedMap, skipMap })
        }
        if (cancelled) return
        setSheets(vms)
        setActiveSheet(0)
      } catch (err: unknown) {
        if (cancelled) return
        setRenderErr(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [bytes])

  if (renderErr) {
    return (
      <div className="office-preview-status is-error">
        <AlertTriangle size={14} />
        <span>Excel 渲染失败:{renderErr}</span>
      </div>
    )
  }
  if (!sheets) {
    return (
      <div className="office-preview-status">
        <Loader2 size={18} className="is-spinning" />
        <span>正在解析 Excel…</span>
      </div>
    )
  }
  if (sheets.length === 0) {
    return (
      <div className="office-preview-status">
        <span>文件里没有任何工作表</span>
      </div>
    )
  }

  const sheet = sheets[activeSheet] ?? sheets[0]!

  return (
    <div className="office-preview-xlsx">
      {sheets.length > 1 ? (
        <div className="office-preview-xlsx-tabs" role="tablist">
          {sheets.map((s, i) => (
            <button
              key={s.name}
              type="button"
              role="tab"
              aria-selected={i === activeSheet}
              className={`office-preview-xlsx-tab ${i === activeSheet ? 'is-active' : ''}`}
              onClick={() => setActiveSheet(i)}
            >
              {s.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="office-preview-xlsx-scroll">
        <table className="office-preview-xlsx-table">
          <colgroup>
            <col style={{ width: 36 }} />
            {sheet.columns.map((w, i) => (
              <col key={i} style={{ width: w }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="office-preview-xlsx-corner" />
              {sheet.columns.map((_, i) => (
                <th key={i} className="office-preview-xlsx-colhead">
                  {excelColLabel(i + 1)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((row, rIdx) => {
              const rowNum = rIdx + 1
              return (
                <tr key={rIdx} style={{ height: sheet.rowHeights[rIdx] ?? DEFAULT_ROW_HEIGHT_PX }}>
                  <th className="office-preview-xlsx-rowhead">{rowNum}</th>
                  {row.map((cell, cIdx) => {
                    const cNum = cIdx + 1
                    const key = `${rowNum},${cNum}`
                    if (sheet.skipMap.has(key)) return null
                    const span = sheet.mergedMap.get(key)
                    return (
                      <td
                        key={cIdx}
                        style={cell.style}
                        rowSpan={span?.rowspan}
                        colSpan={span?.colspan}
                        title={cell.title}
                      >
                        {cell.value}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Excel 辅助函数 ──────────────────────────────────────────────

function cellText(cell: unknown): string {
  // exceljs Cell 有多种 value 形式:string / number / Date / object{ richText } /
  // object{ formula, result } / object{ hyperlink, text }
  const v = (cell as { value?: unknown }).value
  if (v == null) return ''
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return String(v)
  }
  if (v instanceof Date) return v.toLocaleString()
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (Array.isArray(o.richText)) {
      return (o.richText as Array<{ text: string }>).map((r) => r.text).join('')
    }
    if (typeof o.text === 'string') return o.text
    if (typeof o.result === 'string' || typeof o.result === 'number') return String(o.result)
    if (o.result instanceof Date) return (o.result as Date).toLocaleString()
  }
  return ''
}

function cellCssStyle(cell: unknown): React.CSSProperties {
  const c = cell as {
    font?: { name?: string; size?: number; bold?: boolean; italic?: boolean; color?: { argb?: string }; underline?: boolean }
    fill?: { type?: string; fgColor?: { argb?: string }; bgColor?: { argb?: string } }
    alignment?: { horizontal?: string; vertical?: string; wrapText?: boolean }
    border?: {
      top?: { style?: string; color?: { argb?: string } }
      bottom?: { style?: string; color?: { argb?: string } }
      left?: { style?: string; color?: { argb?: string } }
      right?: { style?: string; color?: { argb?: string } }
    }
    numFmt?: string
  }
  const style: React.CSSProperties = {}

  // 字体
  if (c.font) {
    if (c.font.name) style.fontFamily = c.font.name
    if (typeof c.font.size === 'number') style.fontSize = `${c.font.size}pt`
    if (c.font.bold) style.fontWeight = 700
    if (c.font.italic) style.fontStyle = 'italic'
    if (c.font.underline) style.textDecoration = 'underline'
    const color = argbToCss(c.font.color?.argb)
    if (color) style.color = color
  }

  // 背景(solid fill 最常见)
  if (c.fill && c.fill.type === 'pattern') {
    const bg = argbToCss(
      c.fill.fgColor?.argb ?? c.fill.bgColor?.argb,
    )
    if (bg) style.backgroundColor = bg
  }

  // 对齐
  if (c.alignment) {
    if (c.alignment.horizontal) {
      const h = c.alignment.horizontal
      style.textAlign =
        h === 'left' || h === 'right' || h === 'center' || h === 'justify'
          ? (h as 'left' | 'right' | 'center' | 'justify')
          : undefined
    }
    if (c.alignment.vertical) {
      const v = c.alignment.vertical
      style.verticalAlign =
        v === 'top' ? 'top' : v === 'bottom' ? 'bottom' : v === 'middle' ? 'middle' : undefined
    }
    if (c.alignment.wrapText) {
      style.whiteSpace = 'pre-wrap'
      style.wordBreak = 'break-word'
    }
  }

  // 边框(exceljs 按四边给出)
  if (c.border) {
    const t = borderStyle(c.border.top)
    const b = borderStyle(c.border.bottom)
    const l = borderStyle(c.border.left)
    const r = borderStyle(c.border.right)
    if (t) style.borderTop = t
    if (b) style.borderBottom = b
    if (l) style.borderLeft = l
    if (r) style.borderRight = r
  }

  return style
}

function excelColLabel(n: number): string {
  let s = ''
  let x = n
  while (x > 0) {
    const r = (x - 1) % 26
    s = String.fromCharCode(65 + r) + s
    x = Math.floor((x - 1) / 26)
  }
  return s
}
