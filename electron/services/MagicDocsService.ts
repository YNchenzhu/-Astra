import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteFile } from '../diff/atomicWriter'
import { fileHistoryTrackEdit } from '../fs/fileHistory'
import { validatePathWithinWorkspace } from '../tools/workspaceState'

export interface MagicDocsResult {
  markdown: string
  outputPath?: string
}

const IGNORE_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'dist-electron',
  '.vite',
  '.cache',
])

function walkTree(root: string, depth = 0, maxDepth = 3): string[] {
  if (depth > maxDepth) return []

  const entries = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => !IGNORE_NAMES.has(e.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))

  const lines: string[] = []
  for (const ent of entries) {
    const prefix = `${'  '.repeat(depth)}- ${ent.name}${ent.isDirectory() ? '/' : ''}`
    lines.push(prefix)

    if (ent.isDirectory() && depth < maxDepth) {
      lines.push(...walkTree(path.join(root, ent.name), depth + 1, maxDepth))
    }
  }

  return lines
}

function guessModuleDescription(name: string): string {
  const n = name.toLowerCase()
  if (n.includes('electron')) return '主进程/系统集成模块'
  if (n === 'src') return '渲染进程与 UI 逻辑'
  if (n.includes('memory')) return '记忆存储与召回'
  if (n.includes('session')) return '会话状态与工作记录'
  if (n.includes('context')) return '上下文压缩与 token 管理'
  if (n.includes('tools')) return '工具实现与注册中心'
  if (n.includes('mcp')) return 'MCP 协议与外部工具接入'
  if (n.includes('lsp')) return '代码智能（定义/引用/符号）'
  if (n.includes('docs')) return '文档目录'
  return '功能模块'
}

export function buildMagicDocs(workspacePath: string): MagicDocsResult {
  const projectName = path.basename(workspacePath)
  const topLevel = fs
    .readdirSync(workspacePath, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !IGNORE_NAMES.has(e.name))
    .map((e) => e.name)
    .sort()

  const tree = walkTree(workspacePath, 0, 2)
  const moduleLines = topLevel.map((name) => `- \`${name}/\`：${guessModuleDescription(name)}`)

  const markdown = [
    `# ${projectName} 模块文档（MagicDocs）`,
    '',
    `生成时间：${new Date().toISOString()}`,
    '',
    '## 项目概述',
    '',
    `${projectName} 是一个多模块工程。下方给出目录结构和各目录职责，方便快速定位代码。`,
    '',
    '## 目录结构（概览）',
    '',
    '```text',
    `${projectName}/`,
    ...tree,
    '```',
    '',
    '## 模块职责',
    '',
    ...moduleLines,
    '',
    '## 建议阅读顺序',
    '',
    '1. 先看入口与启动链路（主进程/渲染入口）',
    '2. 再看核心能力模块（tools / ai / memory / session）',
    '3. 最后看扩展模块（mcp / skills / lsp 等）',
    '',
  ].join('\n')

  return { markdown }
}

/**
 * Write the generated MagicDocs markdown to disk.
 *
 * Async because we now `await fileHistoryTrackEdit` to snapshot whatever
 * the user had in the target path before we overwrite it (a hand-edited
 * `docs/MAGIC_DOCS.md` from a previous run, customisations, etc.). The
 * MagicDocsTool that drives this is already async, so promoting this
 * function to async ripples cleanly.
 */
export async function writeMagicDocs(
  workspacePath: string,
  outputRelPath = 'docs/MAGIC_DOCS.md',
): Promise<MagicDocsResult> {
  const result = buildMagicDocs(workspacePath)
  const outputPath = path.isAbsolute(outputRelPath)
    ? outputRelPath
    : path.join(workspacePath, outputRelPath)

  // Validate output path is within workspace to prevent path traversal
  const pathCheck = validatePathWithinWorkspace(outputPath)
  if (!pathCheck.safe) {
    throw new Error(`writeMagicDocs: output path blocked — ${pathCheck.reason}`)
  }

  fs.mkdirSync(path.dirname(pathCheck.resolved), { recursive: true })

  // Snapshot any previous version of the docs file BEFORE we overwrite
  // it. MagicDocs is regenerable from sources, but a user-customised
  // `docs/MAGIC_DOCS.md` is not — fileHistory lets the user revert if
  // an unexpected regeneration trampled their hand-edits.
  await fileHistoryTrackEdit(pathCheck.resolved)

  // Atomic write — crash-safe, symlink-aware, permission-preserving.
  const writeRes = atomicWriteFile(pathCheck.resolved, {
    expectedContentHash: null,
    newContent: result.markdown,
  })
  if (!writeRes.ok) {
    throw new Error(
      `writeMagicDocs failed (${writeRes.code}): ${writeRes.message}`,
    )
  }

  return { ...result, outputPath: pathCheck.resolved }
}
