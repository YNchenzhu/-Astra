/**
 * 必须在首屏加载 Monaco 之前执行：
 * - 默认 @monaco-editor/loader 从 CDN 拉脚本，离线/内网/部分网络下会永远卡在 Loading
 * - 使用本地 monaco-editor 包并配置 Vite worker，避免依赖外网
 *
 * 关键：Monaco 本体 + 各 language services 解包后 ~5MB，顶层 `await import('monaco-editor')`
 * 会把 `main.tsx` 的 `createRoot().render(<App />)` 一并挂起 1–3 秒，造成用户看到的"窗口
 * 出来后空白若干秒"。本文件现在只同步配置 worker，Monaco 模块在后台异步下载；消费方
 * （EditorArea / DiffEditorView 等）在渲染 `<Editor>` 之前等待 {@link monacoReadyPromise}
 * resolve，确保 `loader.config({ monaco })` 先于 `loader.init()` 执行，不会回退到 CDN。
 */
import { useEffect, useState } from 'react'
import { loader } from '@monaco-editor/react'

import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

const g = globalThis as typeof globalThis & {
  MonacoEnvironment?: {
    getWorker: (moduleId: string, label: string) => Worker
  }
}

g.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    switch (label) {
      case 'json':
        return new JsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker()
      case 'typescript':
      case 'javascript':
        return new TsWorker()
      default:
        return new EditorWorker()
    }
  },
}

let ready = false

/**
 * 后台加载 Monaco 并配置 `@monaco-editor/react` 的 loader。
 * - 不使用顶层 await，模块导入瞬间完成，React 首屏不被阻塞。
 * - 第一次导入会触发 Vite 分包下载 monaco-editor chunk；完成后才 resolve。
 * - 任何需要在 `<Editor>` mount 前调用 `loader.init()` 的代码，应 await 本 promise
 *   （或用它取代 loader.init()），避免 loader 在配置前初始化、误回落到 CDN 路径。
 */
export const monacoReadyPromise: Promise<typeof import('monaco-editor')> = import(
  'monaco-editor'
).then((monaco) => {
  loader.config({ monaco })
  ready = true
  return monaco
})

/** 同步判断 Monaco 是否已配置完毕（供 useState 初值等场景使用）。 */
export function isMonacoReady(): boolean {
  return ready
}

/**
 * React hook：组件内获取"Monaco 是否配置完毕"的 state。
 *
 * 用途：所有会挂载 `<Editor>` / `<DiffEditor>` 的组件都应 gate 在本 hook
 * 返回 true 之后再 mount — 否则 `@monaco-editor/react` 内部会在 mount 时
 * 以**未 config** 状态调 `loader.init()`，触发 loader 回退去 CDN（jsdelivr）
 * 拉 `loader.js` 并被 CSP `script-src 'self'` 阻断。
 */
export function useMonacoReady(): boolean {
  const [isReady, setIsReady] = useState<boolean>(ready)
  useEffect(() => {
    if (ready) return
    let cancelled = false
    void monacoReadyPromise.then(() => {
      if (!cancelled) setIsReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return isReady
}

// Monaco 在 dispose 内联补全 / CancellationToken 时会 reject 为 Canceled，属预期行为，避免控制台「Uncaught (in promise)」
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (event) => {
    const r = event.reason
    if (
      r === 'Canceled' ||
      r === 'canceled' ||
      (r && typeof r === 'object' && (r as { name?: string }).name === 'Canceled') ||
      (r && typeof r === 'object' && (r as { message?: string }).message === 'Canceled')
    ) {
      event.preventDefault()
    }
  })
}
