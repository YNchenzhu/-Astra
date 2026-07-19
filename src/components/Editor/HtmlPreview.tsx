/**
 * HtmlPreview — 编辑器标签页内的 HTML / SVG 实时预览面板。
 *
 * 在沙箱化的 iframe 里渲染当前 .html / .htm / .svg 文件的内容,跟随
 * Monaco buffer 实时刷新(300ms 静默 debounce —— 用户停止敲击后
 * 才重建 srcDoc,避免每个按键都重载 iframe 闪白)。
 *
 * 安全模型:
 *   - sandbox="allow-scripts" —— 脚本可执行(SVG 里的 <script> 也会
 *     跑),但没有 same-origin,无法读取主进程 Cookie / localStorage /
 *     跨窗口 DOM。
 *   - 没有 allow-top-navigation —— 恶意 location.href 改写无法把用户
 *     带离工作台。
 *   - 没有 allow-forms / allow-popups —— 表单提交、window.open 全部禁用。
 *
 * 已知限制(单文件 srcDoc 渲染的固有约束):
 *   - 相对路径资源(<img src="./logo.png">、外部 .js/.css)无法加载,
 *     因为 iframe 的 origin 是 about:srcdoc。预览只对"自包含 HTML/SVG"
 *     效果完整;团队若需引用本地 assets,后续可加 file:// base URL 或
 *     局部 http server,本期先不做。
 *   - HTML 片段(没有 <html>/<body>)会被自动包一层最小骨架以确保
 *     字体/颜色与编辑器主题协调。
 *   - SVG 模式下原始内容会被居中嵌入一个最小 HTML 文档,并配以棋盘
 *     底纹背景便于辨识透明区域。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import './HtmlPreview.css'

interface HtmlPreviewProps {
  content: string
  className?: string
  /** 当为 true 时把 content 当作 SVG 包进居中显示的最小 HTML 骨架。 */
  asSvg?: boolean
}

/** 300ms 静默 debounce —— 用户停止敲击后才把新内容塞回 iframe。 */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs)
    return () => window.clearTimeout(id)
  }, [value, delayMs])
  return debounced
}

function looksLikeFullHtmlDoc(source: string): boolean {
  return /<!doctype|<html[\s>]/i.test(source)
}

/** 给裸片段补一层最小骨架,继承编辑器深色背景而不是默认白底。 */
function wrapHtmlFragment(source: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:16px;background:#1e1e2e;color:#cdd6f4;font-family:system-ui,-apple-system,sans-serif;}
  </style></head><body>${source}</body></html>`
}

/** SVG → 居中显示在棋盘底纹背景上,便于辨认透明区。 */
function wrapSvgAsHtml(svgSource: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;min-height:100vh;}
    body{
      display:flex;align-items:center;justify-content:center;
      background-color:#1e1e2e;
      background-image:
        linear-gradient(45deg, rgba(255,255,255,0.04) 25%, transparent 25%),
        linear-gradient(-45deg, rgba(255,255,255,0.04) 25%, transparent 25%),
        linear-gradient(45deg, transparent 75%, rgba(255,255,255,0.04) 75%),
        linear-gradient(-45deg, transparent 75%, rgba(255,255,255,0.04) 75%);
      background-size:16px 16px;
      background-position:0 0, 0 8px, 8px -8px, -8px 0;
    }
    svg{max-width:95vw;max-height:95vh;height:auto;width:auto;}
  </style></head><body>${svgSource}</body></html>`
}

export const HtmlPreview: React.FC<HtmlPreviewProps> = ({ content, className, asSvg }) => {
  const [reloadTick, setReloadTick] = useState(0)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  const debouncedContent = useDebouncedValue(content, 300)

  const srcDoc = useMemo(
    () =>
      asSvg
        ? wrapSvgAsHtml(debouncedContent)
        : looksLikeFullHtmlDoc(debouncedContent)
          ? debouncedContent
          : wrapHtmlFragment(debouncedContent),
    [debouncedContent, asSvg],
  )

  const label = asSvg ? 'SVG 预览' : 'HTML 预览'

  return (
    <div className={`html-preview-pane ${asSvg ? 'is-svg' : ''} ${className ?? ''}`}>
      <div className="html-preview-toolbar">
        <span className="html-preview-label">{label}</span>
        <button
          type="button"
          className="html-preview-reload"
          onClick={() => setReloadTick((t) => t + 1)}
          title="重新加载预览(脚本会重新执行)"
        >
          <RefreshCw size={11} /> 重载
        </button>
      </div>
      <iframe
        key={reloadTick}
        ref={iframeRef}
        className="html-preview-iframe"
        title={label}
        sandbox="allow-scripts"
        srcDoc={srcDoc}
      />
    </div>
  )
}
