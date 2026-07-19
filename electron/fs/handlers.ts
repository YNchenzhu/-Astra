import type { OpenDialogOptions } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { sanitizeFilePath } from '../ipc/inputSanitizer'
import { resolvePathForWorkspaceAccess } from '../security/workspaceAccess'
import { validateToolPath } from '../tools/pathSecurity'
import { getWorkspacePath } from '../tools/workspaceState'
import { withFileLock } from '../tools/fileLock'
import { atomicWriteFile } from '../diff/atomicWriter'
import { hashFileContent } from '../tools/readFileState'
import {
  assertPreWriteIntegrity,
  verifyPostWriteIntegrity,
} from '../tools/writeIntegrityGuard'
import {
  startWorkspaceExplorerWatcher,
  stopWorkspaceExplorerWatcher,
} from './workspaceExplorerWatcher'
import { notifyWorkspaceFileMutation } from './workspaceFileNotify'
import { validatedHandle } from '../ipc/validatedHandle'
import { isBinaryContent } from '../constants/files'
import { decodeEditorBuffer, hasUtf16Bom } from './editorTextDecode'
import {
  fsCopyFileArgs,
  fsCreateDirArgs,
  fsDeleteArgs,
  fsFileTreeArgs,
  fsRenameArgs,
  fsSearchArgs,
  fsWriteFileArgs,
} from '../ipc/schemas'

// ========== File Tree ==========

interface FileTreeNode {
  name: string
  path: string
  type: 'file' | 'folder'
  children?: FileTreeNode[]
  language?: string
  /**
   * Set on folder nodes when we stopped descending at the depth boundary —
   * the renderer uses this as a marker to trigger a lazy sub-tree fetch the
   * first time the user expands that folder. Without it, the old behavior
   * simply dropped any folder whose subtree wasn't explored, so anything
   * deeper than the initial maxDepth was invisible in the explorer.
   */
  needsLoad?: boolean
}

interface SearchMatch {
  line: number
  text: string
}

interface SearchResultItem {
  file: string
  path: string
  matches: SearchMatch[]
}

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.vscode', '.idea', 'dist', 'dist-electron',
  '.next', '.nuxt', '__pycache__', '.cache', 'coverage', '.turbo',
])

const IGNORE_FILE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.svg',
  '.pdf', '.zip', '.gz', '.tar', '.rar', '.7z',
  '.mp3', '.mp4', '.wav', '.mov', '.avi', '.mkv',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.exe', '.dll', '.so', '.dylib', '.class', '.jar',
  '.bin', '.dat', '.pyc', '.pyo', '.o', '.obj',
  // Office binary containers (zip-wrapped XML / OLE) — readFile(..,'utf-8')
  // turns these into ~1MB cons-strings that cannot be GC'd while the
  // recursive `walk` async-generator is awaiting, blowing large_object_space.
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.pages', '.numbers', '.key',
  '.epub', '.mobi', '.azw', '.azw3',
  '.psd', '.ai', '.sketch', '.tif', '.tiff', '.heic', '.raw',
  '.iso', '.img', '.dmg', '.msi', '.apk', '.ipa',
  '.xz', '.lz4', '.zst', '.br',
])

// Cap the size of any file whose content we eagerly load into memory for a
// substring grep. 2 MB is a generous upper bound for legitimate text files
// in a repo; anything larger is virtually always binary or generated, and
// its UTF-8 decoding is the very allocation that pushes large_object_space
// past the V8 heap limit (see the "Desktop/标书智能体" OOM, 2026-05-17).
const MAX_GREPPABLE_FILE_BYTES = 2 * 1024 * 1024

const LANG_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  json: 'json',
  md: 'markdown',
  css: 'css',
  scss: 'scss',
  html: 'html',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  sh: 'shell',
  bash: 'shell',
  sql: 'sql',
}

function getLanguage(fileName: string): string {
  const ext = fileName.split('.').pop() || ''
  return LANG_MAP[ext] || 'plaintext'
}

/**
 * Yield to the event loop so a deeply-recursive tree walk on a large
 * monorepo doesn't pin the main process for seconds. We yield every
 * {@link YIELD_INTERVAL} directories visited; small projects (< that
 * count) still finish synchronously inside one microtask.
 */
const YIELD_INTERVAL = 32

async function buildFileTreeAsync(
  dirPath: string,
  relativeTo: string,
  maxDepth: number,
  state: { dirsVisited: number },
): Promise<FileTreeNode[]> {
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true })
  } catch {
    return []
  }
  state.dirsVisited += 1
  if (state.dirsVisited % YIELD_INTERVAL === 0) {
    // setImmediate yields back to the libuv loop so IPC / window paint /
    // user input can run between sub-tree expansions on huge trees.
    await new Promise<void>((resolve) => setImmediate(resolve))
  }

  const nodes: FileTreeNode[] = []

  const sorted = entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1
    if (!a.isDirectory() && b.isDirectory()) return 1
    return a.name.localeCompare(b.name)
  })

  for (const entry of sorted) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue
    if (IGNORE_DIRS.has(entry.name)) continue

    const fullPath = path.join(dirPath, entry.name)
    const relativePath = path.relative(relativeTo, fullPath).replace(/\\/g, '/')

    if (entry.isDirectory()) {
      if (maxDepth > 1) {
        const children = await buildFileTreeAsync(fullPath, relativeTo, maxDepth - 1, state)
        nodes.push({
          name: entry.name,
          path: relativePath,
          type: 'folder',
          children,
        })
      } else {
        // At the depth boundary: emit the folder without descending, so the
        // user still sees it and can expand on demand. We check emptiness
        // cheaply (without recursing) by peeking a single readdir result.
        let hasAnyChild = false
        try {
          const iter = await fsp.readdir(fullPath, { withFileTypes: true })
          for (const sub of iter) {
            if (sub.name.startsWith('.') && sub.name !== '.env.example') continue
            if (sub.isDirectory() && IGNORE_DIRS.has(sub.name)) continue
            hasAnyChild = true
            break
          }
        } catch {
          // If we can't read the dir (perm errors etc.) treat it as a leaf
          // folder — dropping it entirely would silently hide it instead.
          hasAnyChild = false
        }
        nodes.push({
          name: entry.name,
          path: relativePath,
          type: 'folder',
          children: [],
          needsLoad: hasAnyChild,
        })
      }
    } else if (entry.isFile()) {
      nodes.push({
        name: entry.name,
        path: relativePath,
        type: 'file',
        language: getLanguage(entry.name),
      })
    }
  }

  return nodes
}

async function searchInWorkspaceAsync(params: {
  dirPath: string
  query: string
  maxResults: number
  maxMatchesPerFile: number
}): Promise<{ results: SearchResultItem[]; truncated: boolean }> {
  const { dirPath, query, maxResults, maxMatchesPerFile } = params
  const queryLower = query.toLowerCase()
  const results: SearchResultItem[] = []
  let totalMatches = 0
  let truncated = false
  let filesProcessed = 0

  const walk = async (currentPath: string): Promise<void> => {
    if (truncated) return

    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(currentPath, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (truncated) break

      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || IGNORE_DIRS.has(entry.name)) continue
        await walk(path.join(currentPath, entry.name))
        continue
      }

      if (!entry.isFile()) continue

      const extension = path.extname(entry.name).toLowerCase()
      if (IGNORE_FILE_EXTENSIONS.has(extension)) continue

      const fullPath = path.join(currentPath, entry.name)
      // Skip files larger than the grep cap before doing readFile — readFile
      // forces a UTF-8 decode and the resulting string is retained on this
      // async-generator's stack frame for as long as the recursive walk is
      // awaiting deeper sub-directories, so even one 5 MB binary file per
      // directory level is enough to fill large_object_space.
      try {
        const st = await fsp.stat(fullPath)
        if (!st.isFile()) continue
        if (st.size > MAX_GREPPABLE_FILE_BYTES) continue
      } catch {
        continue
      }
      let content: string
      try {
        content = await fsp.readFile(fullPath, 'utf-8')
      } catch {
        continue
      }
      filesProcessed += 1
      // Yield to libuv every YIELD_INTERVAL files so a 5k-file scan doesn't
      // pin the main process for seconds. Tied to the same constant used
      // by buildFileTreeAsync above so behavior is consistent.
      if (filesProcessed % YIELD_INTERVAL === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }

      if (!content || content.includes('\u0000')) continue

      const lines = content.split(/\r?\n/)
      const matches: SearchMatch[] = []

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        if (truncated) break
        const line = lines[lineIndex]
        if (!line.toLowerCase().includes(queryLower)) continue

        matches.push({
          line: lineIndex + 1,
          text: line.trim(),
        })

        totalMatches += 1
        if (totalMatches >= maxResults) {
          truncated = true
          break
        }

        if (matches.length >= maxMatchesPerFile) {
          break
        }
      }

      if (matches.length > 0) {
        results.push({
          file: entry.name,
          path: path.relative(dirPath, fullPath).replace(/\\/g, '/'),
          matches,
        })
      }
    }
  }

  await walk(dirPath)
  return { results, truncated }
}

// ========== File Operations ==========

function pathSecurityDenyReason(
  resolvedAbsolutePath: string,
  operation: 'read' | 'write' | 'delete',
): string | null {
  const ws = getWorkspacePath() ?? undefined
  const a = validateToolPath(resolvedAbsolutePath, operation, ws)
  return a.verdict === 'deny' ? a.reason : null
}

/**
 * Windows 上 rename / unlink / rmdir 的瞬态错误码集合。EBUSY 是 share lock,
 * EPERM 出现在 mkdir-then-rmdir 或被杀软短暂拦截时,ENOTEMPTY 是目录还有句
 * 柄没释放。其余 ENOENT/EACCES 等不在此列 —— 那些是终态错误,重试只是浪费
 * 时间还会延迟错误反馈。
 */
const TRANSIENT_LOCK_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY'])

function isTransientLockError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && TRANSIENT_LOCK_CODES.has(code)
}

/**
 * 重试 fs 操作以吃掉瞬态文件锁(自家 chokidar 轮询、AV 扫描、OneDrive 同步
 * 短暂占用)。指数退避到 ~1.5s 总耗时;打开在 Excel 里的 xlsx 这种持久锁
 * 不会被解锁,所以最终仍会冒出原错误,由 caller 翻译给用户看。
 */
async function withFileLockRetry<T>(op: () => T): Promise<T> {
  const delays = [80, 200, 400, 800] // ms; total ~1.5s
  let lastError: unknown
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return op()
    } catch (error) {
      lastError = error
      if (!isTransientLockError(error) || attempt === delays.length) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]))
    }
  }
  throw lastError
}

/**
 * 把 Node 抛出的 EBUSY/EPERM 翻译成给最终用户看的中文解释。其他错误码原样
 * 透出 —— 那些通常已经够清晰(ENOENT / EACCES 等)。
 */
function formatFsOperationError(
  error: unknown,
  context: { operation: 'rename' | 'delete' | 'copy'; targetDisplayPath: string },
): string {
  const raw = getErrorMessage(error)
  if (!isTransientLockError(error)) return raw
  const code = (error as { code?: string }).code
  const fileName = path.basename(context.targetDisplayPath)
  const verb =
    context.operation === 'rename' ? '重命名' : context.operation === 'copy' ? '复制' : '删除'
  // EBUSY ≈ share-deny-write 锁(Office / OneDrive / 编辑器);
  // EPERM ≈ ACL 拒绝或 AV 拦截;两者文案一致避免误导。
  const hint =
    code === 'EBUSY' || code === 'EPERM'
      ? `文件「${fileName}」被其他程序占用,无法${verb}。请关闭打开它的程序(例如 Excel / Word / OneDrive 同步)后重试。`
      : `${verb}失败,目录或文件未释放。请稍后重试。`
  return `${hint}\n\n原始错误: ${raw}`
}

/** IPC 路径：先 {@link sanitizeFilePath}，再工作区解析（与 settings:set 同层净化）。 */
function sanitizeAndResolvePath(
  raw: unknown,
): { ok: true; resolved: string } | { ok: false; reason: string } {
  try {
    const filePath = sanitizeFilePath(raw)
    return resolvePathForWorkspaceAccess(filePath)
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * 编辑器文本读取上限(2026-07 审计修复)。此前无上限,巨型文件整份进
 * JS 字符串可拖垮渲染进程。20MB 已远超正常代码/文本文件;更大的文件
 * 应经二进制通道或专用查看器处理。可用 POLE_EDITOR_READ_MAX_BYTES 调整。
 */
const MAX_EDITOR_READ_BYTES = Math.max(
  1024 * 1024,
  Number(process.env.POLE_EDITOR_READ_MAX_BYTES ?? '') || 20 * 1024 * 1024,
)

export function registerFileHandlers(ipcMain: Electron.IpcMain): void {
  ipcMain.handle('fs:read-file', async (_event, filePath: string) => {
    const resolved = sanitizeAndResolvePath(filePath)
    if (!resolved.ok) {
      return { success: false, error: resolved.reason }
    }
    const sec = pathSecurityDenyReason(resolved.resolved, 'read')
    if (sec) {
      return { success: false, error: sec }
    }
    try {
      // 2026-07 审计修复:大小上限 + 二进制拦截 + 编码检测。
      // 此前无条件 UTF-8 读:二进制乱码进 Monaco、GBK/UTF-16 乱码且
      // 保存后永久损坏、巨型文件冻结渲染进程。
      const stat = fs.statSync(resolved.resolved)
      if (stat.size > MAX_EDITOR_READ_BYTES) {
        return {
          success: false,
          error: `文件过大(${(stat.size / (1024 * 1024)).toFixed(1)} MB > ${Math.round(MAX_EDITOR_READ_BYTES / (1024 * 1024))} MB),无法作为文本打开`,
        }
      }
      const raw = fs.readFileSync(resolved.resolved)
      // UTF-16 BOM 文件天然含大量 NUL,先于二进制嗅探处理。
      if (!hasUtf16Bom(raw) && isBinaryContent(raw)) {
        return {
          success: false,
          error: '二进制文件,无法作为文本打开(请使用对应的查看器)',
        }
      }
      const { content, encoding } = decodeEditorBuffer(raw)
      return { success: true, content, encoding }
    } catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  })

  // 读取二进制内容 —— 用于 docx / xlsx 等需要原始字节才能在渲染进程
  // 做原格式预览(docx-preview / exceljs)的场景。返回 Uint8Array,
  // Electron IPC 会将其当作可序列化的 Buffer 透传。UI 层 new Uint8Array
  // 后即可塞给 ArrayBuffer 消费方。
  //
  // 安全:复用同一套 sanitize + path security,和 read-file 完全一致。
  ipcMain.handle('fs:read-file-binary', async (_event, filePath: string) => {
    const resolved = sanitizeAndResolvePath(filePath)
    if (!resolved.ok) {
      return { success: false, error: resolved.reason }
    }
    const sec = pathSecurityDenyReason(resolved.resolved, 'read')
    if (sec) {
      return { success: false, error: sec }
    }
    try {
      const buf = fs.readFileSync(resolved.resolved)
      // 转 Uint8Array 让 IPC 透传时使用 Structured Clone 的 TypedArray 路径,
      // 避免 Buffer 在 renderer 端变成普通对象。
      return { success: true, bytes: new Uint8Array(buf) }
    } catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  })

  validatedHandle('fs:write-file', fsWriteFileArgs, async (_event, [filePath, content]) => {
    const resolved = sanitizeAndResolvePath(filePath)
    if (!resolved.ok) {
      return { success: false, error: resolved.reason }
    }
    const secW = pathSecurityDenyReason(resolved.resolved, 'write')
    if (secW) {
      return { success: false, error: secW }
    }
    const target = resolved.resolved
    try {
      const dir = path.dirname(target)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      const existsAsFile = fs.existsSync(target) && fs.statSync(target).isFile()
      // BOM-aware read so the previous-vs-content comparison and the
      // atomicWriter round-trip below operate on the file's TRUE encoding.
      // Without this, an editor save on a UTF-16LE file (rare but real:
      // some PowerShell scripts, exported registry .reg, legacy Notepad
      // saves) would compare a garbled utf-8 interpretation against the
      // user's clean utf-16le content and then SILENTLY MIGRATE the file
      // to utf-8 on disk — breaking Windows-native parsers.
      let previous = ''
      let diskEncoding: BufferEncoding = 'utf-8'
      // 2026-07 审计修复:legacy 编码(GBK/Big5 等)文件的保存保护。
      // 此前 previous 被按 UTF-8 误读成乱码 —— 长度约为真实文本 2 倍,
      // 可能误触 destructive-clear 守卫;且比较基线完全失真。现在用与
      // 读路径同源的解码取得真实 previous;legacy 文件写回时迁移为
      // UTF-8(渲染进程 buffer 已是正确文本,字符无损,仅编码迁移),
      // 并在返回值中显式携带 warning。
      let legacyEncodingMigrated: string | null = null
      if (existsAsFile) {
        const rawPrev = fs.readFileSync(target)
        const dec = decodeEditorBuffer(rawPrev)
        previous = dec.content
        if (dec.encoding === 'utf16le') {
          diskEncoding = 'utf16le'
        } else if (dec.encoding !== 'utf-8') {
          legacyEncodingMigrated = dec.encoding
          diskEncoding = 'utf-8'
        }
      }
      if (existsAsFile && previous === content) {
        return { success: true }
      }

      // Route through the shared writeIntegrityGuard so the destructive-clear
      // rules used here exactly match the tool-layer guards (toolWriteFile /
      // toolEditFile) and the supervisor-layer guard in runAgenticToolUse.
      const preCheck = assertPreWriteIntegrity({
        resolvedPath: target,
        displayPath: filePath,
        previousContent: previous,
        nextContent: content,
        fileExisted: existsAsFile,
        intent: 'ipc-save',
      })
      if (!preCheck.ok) {
        return { success: false, error: preCheck.error }
      }

      // Use file lock to serialize concurrent writes to the same file.
      // Inside the lock we route through the shared atomicWriter so a
      // mid-write crash / power loss never leaves the user's file in a
      // half-written state — critical for an editor save (`Cmd+S` etc.)
      // where data loss is the worst-case UX. Symlink + permission
      // preservation come along for free via atomicWriteFile.
      //
      // We intentionally do NOT wire `fileHistoryTrackEdit` into this
      // path: an IPC save is the USER's own change (Cmd+S, autosave),
      // not an AI mutation, so polluting AI's "what was here before I
      // touched it" undo history with user-driven saves would muddy the
      // recovery model. Standard editor undo is the right surface for
      // user saves; AI's `~/.userData/file-history/...` is for AI safety.
      let writeError: string | null = null
      await withFileLock(target, async () => {
        const res = atomicWriteFile(target, {
          // legacy 迁移场景跳过 stale 检查:atomicWriter 内部以 UTF-8
          // 重读磁盘会得到乱码,与正确解码的 previous 哈希必然不符。
          // 外层 withFileLock + preWriteIntegrity 仍在守卫。
          expectedContentHash:
            existsAsFile && !legacyEncodingMigrated ? hashFileContent(previous) : null,
          newContent: content,
          encoding: diskEncoding,
        })
        if (!res.ok) {
          writeError = `${res.code}: ${res.message}`
        }
      })
      if (writeError) {
        return { success: false, error: writeError }
      }

      // Post-write verification: re-read and confirm the bytes on disk match
      // what the renderer asked us to save. atomicWriter already did its own
      // re-read; this is the supervisor-layer check (different read, applies
      // the writeIntegrityGuard's encoding sanity).
      const postCheck = verifyPostWriteIntegrity({
        resolvedPath: target,
        displayPath: filePath,
        expectedContent: content,
        intent: 'ipc-save',
        // Round-trip the detected encoding (UTF-16LE parity with atomicWriter).
        encoding: diskEncoding,
      })
      if (!postCheck.ok) {
        return { success: false, error: postCheck.error }
      }

      notifyWorkspaceFileMutation(target.replace(/\\/g, '/'), existsAsFile ? 'change' : 'add')
      return {
        success: true,
        ...(legacyEncodingMigrated
          ? { warning: `文件编码已从 ${legacyEncodingMigrated} 迁移为 UTF-8(文本内容无损)` }
          : {}),
      }
    } catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  })

  validatedHandle('fs:file-tree', fsFileTreeArgs, async (_event, [dirPath, maxDepthRaw]) => {
    const maxDepth = maxDepthRaw ?? 3
    const resolved = sanitizeAndResolvePath(dirPath)
    if (!resolved.ok) {
      return { success: false, error: resolved.reason }
    }
    const secTree = pathSecurityDenyReason(resolved.resolved, 'read')
    if (secTree) {
      return { success: false, error: secTree }
    }
    try {
      if (!fs.existsSync(resolved.resolved)) {
        return { success: false, error: `Directory not found: ${dirPath}` }
      }
      const tree = await buildFileTreeAsync(
        resolved.resolved,
        resolved.resolved,
        maxDepth,
        { dirsVisited: 0 },
      )
      return { success: true, tree }
    } catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  })

  validatedHandle('fs:search', fsSearchArgs, async (_event, [params]) => {
    try {
      const dirPath = params.dirPath
      const query = params.query?.trim()
      if (!dirPath || !query) {
        return { success: true, results: [], truncated: false }
      }

      const dirRes = sanitizeAndResolvePath(dirPath)
      if (!dirRes.ok) {
        return { success: false, error: dirRes.reason }
      }
      const secSearch = pathSecurityDenyReason(dirRes.resolved, 'read')
      if (secSearch) {
        return { success: false, error: secSearch }
      }

      if (!fs.existsSync(dirRes.resolved)) {
        return { success: false, error: `Directory not found: ${dirPath}` }
      }

      const maxResults = Math.max(20, Math.min(5000, Number(params.maxResults) || 600))
      const maxMatchesPerFile = Math.max(1, Math.min(100, Number(params.maxMatchesPerFile) || 20))

      const { results, truncated } = await searchInWorkspaceAsync({
        dirPath: dirRes.resolved,
        query,
        maxResults,
        maxMatchesPerFile,
      })

      return { success: true, results, truncated }
    } catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  })

  ipcMain.handle('fs:stat', async (_event, filePath: string) => {
    const resolved = sanitizeAndResolvePath(filePath)
    if (!resolved.ok) {
      return { success: false, error: resolved.reason }
    }
    const secStat = pathSecurityDenyReason(resolved.resolved, 'read')
    if (secStat) {
      return { success: false, error: secStat }
    }
    try {
      const stat = fs.statSync(resolved.resolved)
      return {
        success: true,
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      }
    } catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  })

  ipcMain.handle('fs:exists', async (_event, filePath: string) => {
    const resolved = sanitizeAndResolvePath(filePath)
    if (!resolved.ok) {
      return { success: false, error: resolved.reason }
    }
    const secEx = pathSecurityDenyReason(resolved.resolved, 'read')
    if (secEx) {
      return { success: false, error: secEx }
    }
    return { success: true, exists: fs.existsSync(resolved.resolved) }
  })

  validatedHandle('fs:delete', fsDeleteArgs, async (_event, [filePath]) => {
    const resolved = sanitizeAndResolvePath(filePath)
    if (!resolved.ok) {
      return { success: false, error: resolved.reason }
    }
    const secDel = pathSecurityDenyReason(resolved.resolved, 'delete')
    if (secDel) {
      return { success: false, error: secDel }
    }
    try {
      const stat = fs.statSync(resolved.resolved)
      await withFileLockRetry(() => {
        if (stat.isDirectory()) {
          fs.rmSync(resolved.resolved, { recursive: true, force: true })
        } else {
          fs.unlinkSync(resolved.resolved)
        }
      })
      // Mirror fs:write-file: every IPC mutation pushes its own
      // `workspace:file-changed` event so renderer subscribers (Sidebar
      // file-tree auto-refresh, GitPanel, FilePreview, …) never have to
      // wait for chokidar's debounced + awaitWriteFinish (≈600 ms) signal
      // and stay consistent across IPC and watcher paths.
      notifyWorkspaceFileMutation(resolved.resolved.replace(/\\/g, '/'), 'unlink')
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: formatFsOperationError(error, {
          operation: 'delete',
          targetDisplayPath: filePath,
        }),
      }
    }
  })

  validatedHandle('fs:create-dir', fsCreateDirArgs, async (_event, [dirPath]) => {
    const resolved = sanitizeAndResolvePath(dirPath)
    if (!resolved.ok) {
      return { success: false, error: resolved.reason }
    }
    const secMk = pathSecurityDenyReason(resolved.resolved, 'write')
    if (secMk) {
      return { success: false, error: secMk }
    }
    // Empty new dirs would otherwise be invisible to the file tree until
    // a manual refresh: chokidar's `addDir` already routes through this
    // codebase, but only if the watcher is up *before* the dir lands on
    // disk — and on Windows the awaitWriteFinish setting can swallow
    // back-to-back create+populate combos.  Emitting the IPC notification
    // ourselves makes the explorer reaction instant regardless.
    const existedBefore = fs.existsSync(resolved.resolved)
    try {
      fs.mkdirSync(resolved.resolved, { recursive: true })
      if (!existedBefore) {
        notifyWorkspaceFileMutation(resolved.resolved.replace(/\\/g, '/'), 'add')
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  })

  ipcMain.handle('fs:open-dialog', async (_event, options: {
    title?: string
    filters?: Array<{ name: string; extensions: string[] }>
    defaultPath?: string
    properties?: string[]
  }) => {
    const { dialog } = await import('electron')
    let defaultPath = options?.defaultPath
    if (defaultPath !== undefined) {
      try {
        defaultPath = sanitizeFilePath(defaultPath)
      } catch {
        defaultPath = undefined
      }
    }
    const result = await dialog.showOpenDialog({
      title: options?.title || 'Open Folder',
      properties: (options?.properties ?? ['openDirectory']) as OpenDialogOptions['properties'],
      filters: options?.filters,
      defaultPath,
    })
    if (result.canceled) return { success: true, canceled: true, paths: [] }
    return { success: true, canceled: false, paths: result.filePaths }
  })

  // Native "Save As" dialog — used by the renderer to give untitled tabs a
  // real path on Ctrl+S. Only picks the target path; the actual write still
  // goes through `fs:write-file` (and therefore the workspace sandbox).
  ipcMain.handle('fs:save-dialog', async (_event, options: {
    title?: string
    filters?: Array<{ name: string; extensions: string[] }>
    defaultPath?: string
  }) => {
    const { dialog } = await import('electron')
    let defaultPath = options?.defaultPath
    if (defaultPath !== undefined) {
      try {
        defaultPath = sanitizeFilePath(defaultPath)
      } catch {
        defaultPath = undefined
      }
    }
    const result = await dialog.showSaveDialog({
      title: options?.title || 'Save File',
      filters: options?.filters,
      defaultPath,
    })
    if (result.canceled || !result.filePath) return { success: true, canceled: true }
    return { success: true, canceled: false, path: result.filePath }
  })

  ipcMain.handle('fs:start-workspace-watcher', async (_event, workspacePath: string) => {
    const resolved = sanitizeAndResolvePath(workspacePath)
    if (!resolved.ok) {
      return { success: false, error: resolved.reason }
    }
    const secWatch = pathSecurityDenyReason(resolved.resolved, 'read')
    if (secWatch) {
      return { success: false, error: secWatch }
    }
    return startWorkspaceExplorerWatcher(resolved.resolved)
  })

  ipcMain.handle('fs:stop-workspace-watcher', async () => {
    return stopWorkspaceExplorerWatcher()
  })

  ipcMain.handle('fs:show-item-in-folder', async (_event, filePath: string) => {
    const resolved = sanitizeAndResolvePath(filePath)
    if (!resolved.ok) return { success: false, error: resolved.reason }
    const { shell } = await import('electron')
    shell.showItemInFolder(resolved.resolved)
    return { success: true }
  })

  ipcMain.handle('fs:open-path', async (_event, filePath: string) => {
    const resolved = sanitizeAndResolvePath(filePath)
    if (!resolved.ok) return { success: false, error: resolved.reason }
    const { shell } = await import('electron')
    const errorMsg = await shell.openPath(resolved.resolved)
    return errorMsg ? { success: false, error: errorMsg } : { success: true }
  })

  // 2026-07 审计修复:字节级文件复制。此前文件树"复制"走 readFile(UTF-8)
  // + writeFile 的文本往返,任何二进制文件(图片/压缩包/Office)复制出的
  // 副本都是损坏的。fs.copyFileSync 原样复制字节,COPYFILE_EXCL 防覆盖。
  validatedHandle('fs:copy-file', fsCopyFileArgs, async (_event, [srcPath, destPath]) => {
    const resolvedSrc = sanitizeAndResolvePath(srcPath)
    if (!resolvedSrc.ok) return { success: false, error: resolvedSrc.reason }
    const resolvedDest = sanitizeAndResolvePath(destPath)
    if (!resolvedDest.ok) return { success: false, error: resolvedDest.reason }
    const secSrc = pathSecurityDenyReason(resolvedSrc.resolved, 'read')
    if (secSrc) return { success: false, error: secSrc }
    const secDest = pathSecurityDenyReason(resolvedDest.resolved, 'write')
    if (secDest) return { success: false, error: secDest }
    try {
      fs.copyFileSync(resolvedSrc.resolved, resolvedDest.resolved, fs.constants.COPYFILE_EXCL)
      notifyWorkspaceFileMutation(resolvedDest.resolved.replace(/\\/g, '/'), 'add')
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: formatFsOperationError(error, {
          operation: 'copy',
          targetDisplayPath: destPath,
        }),
      }
    }
  })

  validatedHandle('fs:rename', fsRenameArgs, async (_event, [oldPath, newPath]) => {
    const resolvedOld = sanitizeAndResolvePath(oldPath)
    if (!resolvedOld.ok) return { success: false, error: resolvedOld.reason }
    const resolvedNew = sanitizeAndResolvePath(newPath)
    if (!resolvedNew.ok) return { success: false, error: resolvedNew.reason }
    const secOld = pathSecurityDenyReason(resolvedOld.resolved, 'write')
    if (secOld) return { success: false, error: secOld }
    const secNew = pathSecurityDenyReason(resolvedNew.resolved, 'write')
    if (secNew) return { success: false, error: secNew }
    try {
      await withFileLockRetry(() =>
        fs.renameSync(resolvedOld.resolved, resolvedNew.resolved),
      )
      // Rename = unlink(old) + add(new) from the file-tree's point of view.
      // Some chokidar configurations ignore rename pairs entirely on
      // Windows when both paths land in the same parent within
      // `awaitWriteFinish`'s window, so we emit the pair ourselves to
      // guarantee renderer subscribers see both endpoints.
      notifyWorkspaceFileMutation(resolvedOld.resolved.replace(/\\/g, '/'), 'unlink')
      notifyWorkspaceFileMutation(resolvedNew.resolved.replace(/\\/g, '/'), 'add')
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: formatFsOperationError(error, {
          operation: 'rename',
          targetDisplayPath: oldPath,
        }),
      }
    }
  })
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
