/**
 * outlineParser —— 从 markdown/纯文本里提取层级标题 (Sprint 9.2+)。
 *
 * 设计取舍:
 *   - **不走完整 markdown AST**(remark)—— 只识别以 `#` 开头的 ATX
 *     标题即可。setext (`===` / `---` 下划线式)占比极低,跳过。
 *   - **忽略代码块内部的 `#`** —— 用 ``` 栅栏开关状态;缩进式(4 空格)
 *     代码块忽略(写作场景不常见)。
 *   - **标题层级直接用 # 个数**。1-6。>6 个按 6 处理。
 *   - **返回扁平数组**,带 level。由 UI 层用 level 渲染缩进层级
 *     (不构建嵌套树 —— 扁平数组对大纲跳转足够,也避免构建 tree 时
 *     处理 level 跳跃的复杂度)。
 */

export interface OutlineItem {
  /** 1-6 */
  level: number
  /** 标题文本(# 之后,去掉行尾 `#{1,}` 闭合标记) */
  text: string
  /** 1-indexed 行号,给 Editor.requestJump 用 */
  line: number
}

/**
 * 支持的文件扩展名 → 是否视为文档格式。
 * .md / .markdown / .mdx / .txt 都走文档大纲逻辑。其它文件大纲为空。
 */
const DOC_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.mdx',
  '.txt',
])

export function isDocumentFile(path: string | undefined | null): boolean {
  if (!path) return false
  const lower = path.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return false
  return DOC_EXTENSIONS.has(lower.slice(dot))
}

/**
 * 解析内容为 outline 条目。非 markdown 类文件(.txt)仍按 # 规则走,
 * 但大多数 txt 没有 #,结果就是空 —— 由 UI 显示 "当前文件无大纲"。
 */
export function parseOutline(content: string): OutlineItem[] {
  const lines = content.split(/\r?\n/)
  const items: OutlineItem[] = []

  // 代码栅栏(``` 或 ~~~)的打开状态
  let fenceOpen = false
  let fenceChar: '`' | '~' | null = null

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (raw === undefined) continue

    // 栅栏识别 —— 3+ 个 ` 或 ~ 起头,可带 info string
    const fenceMatch = raw.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (fenceMatch) {
      const ch = fenceMatch[1]!.charAt(0) as '`' | '~'
      if (!fenceOpen) {
        fenceOpen = true
        fenceChar = ch
      } else if (ch === fenceChar) {
        // 闭合:要求字符相同(``` 不闭合 ~~~)
        fenceOpen = false
        fenceChar = null
      }
      continue
    }
    if (fenceOpen) continue

    // ATX 标题: 行首 0-3 空格 + 1-6 个 # + 空格 + 文本
    // GFM: # 后必须有空白(排除 issue 引用式 `#123`)
    const headingMatch = raw.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (!headingMatch) continue

    const level = Math.min(headingMatch[1]!.length, 6)
    const text = headingMatch[2]!.trim()
    if (!text) continue

    items.push({ level, text, line: i + 1 })
  }

  return items
}
