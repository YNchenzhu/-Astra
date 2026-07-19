/**
 * ReadDiagnostics Tool — AI 可读诊断工具
 *
 * Reads the main-process {@link diagnosticsStore}: Monaco markers (via `lsp:sync-diagnostics`)
 * merged with subprocess language-server `publishDiagnostics` (via passive feedback).
 */

import path from 'node:path'
import { diagnosticsStore } from './DiagnosticsStore'
import { getWorkspacePath } from './workspaceState'
import { buildTool } from './buildTool'
import { validateNoOp } from './toolValidateCommon'
import { readDiagnosticsInputZod } from './toolInputZod'

const severityLabels: Record<string, string> = {
  error: '错误',
  warning: '警告',
  information: '信息',
  hint: '提示',
}

export const readDiagnosticsTool = buildTool({
  name: 'ReadDiagnostics',
  description:
    '读取当前工作区的 LSP 诊断信息（错误、警告、信息、提示）。' +
    '可以不传参数获取全部问题的摘要，也可以指定 file 参数获取特定文件的详细问题列表。',
  inputSchema: [
    {
      name: 'file',
      type: 'string',
      description: '可选。文件路径（绝对路径或相对路径），只读取该文件的诊断。不传则返回所有文件的摘要',
      required: false,
    },
    {
      name: 'severity',
      type: 'string',
      description: '可选。过滤严重程度：error/warning/information/hint/all。默认 all',
      required: false,
    },
  ],
  isReadOnly: true,
  isConcurrencySafe: true,
  zInputSchema: readDiagnosticsInputZod,
  searchHint: 'lsp errors warnings problems diagnostics',
  validateInput: validateNoOp,
  async call({ file, severity }) {
    let diags = file
      ? diagnosticsStore.getForFile(resolveFilePath(file))
      : diagnosticsStore.getAll()

    // Filter by severity
    if (severity && severity !== 'all') {
      const validSeverities = ['error', 'warning', 'information', 'hint']
      if (validSeverities.includes(severity)) {
        diags = diags.filter((d) => d.severity === severity)
      }
    }

    if (diags.length === 0) {
      const scope = file ? `（${file}）` : '（整个工作区）'
      return {
        success: true,
        output: `工作区诊断${scope}：未发现问题。`,
      }
    }

    // Build summary
    const errorCount = diags.filter((d) => d.severity === 'error').length
    const warningCount = diags.filter((d) => d.severity === 'warning').length
    const infoCount = diags.filter((d) => d.severity === 'information').length
    const hintCount = diags.filter((d) => d.severity === 'hint').length

    const workspacePath = getWorkspacePath()
    const parts: string[] = []

    parts.push(`工作区诊断摘要：共 ${diags.length} 个问题（${errorCount} 错误，${warningCount} 警告，${infoCount} 信息，${hintCount} 提示）`)
    parts.push('')

    // Group by file for detailed output
    const byFile = new Map<string, typeof diags>()
    for (const d of diags) {
      if (!byFile.has(d.file)) byFile.set(d.file, [])
      byFile.get(d.file)!.push(d)
    }

    for (const [filePath, fileDiags] of byFile.entries()) {
      const relativePath = workspacePath
        ? path.relative(workspacePath, filePath).replace(/\\/g, '/')
        : filePath

      parts.push(`文件: ${relativePath} (${fileDiags.length} 个问题)`)
      for (const d of fileDiags) {
        parts.push(
          `  [${severityLabels[d.severity]}] 第 ${d.line} 行, 第 ${d.column} 列: ${d.message}` +
          (d.source ? ` (${d.source})` : '')
        )
      }
      parts.push('')
    }

    return { success: true, output: parts.join('\n') }
  },
})

function resolveFilePath(filePath: string): string {
  // Normalize forward/back slashes
  const normalized = filePath.replace(/\\/g, '/')
  if (path.isAbsolute(normalized)) return normalized

  // Try workspace path first, then cwd as fallback
  const workspacePath = getWorkspacePath()
  const basePath = workspacePath || process.cwd()

  return path.join(basePath, normalized).replace(/\\/g, '/')
}
