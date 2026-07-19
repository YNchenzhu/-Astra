/**
 * 路径安全校验器 — 防止目录遍历和敏感文件访问
 *
 * 确保所有文件操作（read/write/delete）都在安全范围内：
 * 1. 路径标准化（消除 ../ 和符号链接）
 * 2. workspace 范围检查
 * 3. 禁止路径检查
 * 4. 敏感文件类型检查
 */

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

export type SecurityVerdict = 'allow' | 'warn' | 'deny'

export interface PathSecurityAnalysis {
  verdict: SecurityVerdict
  reason: string
  isWithinWorkspace: boolean
  isForbidden: boolean
  isSensitive: boolean
  normalizedPath: string
}

/** 绝对禁止访问的路径模式 */
const FORBIDDEN_PATHS = [
  '/etc/shadow',
  '/etc/passwd',
  '/etc/sudoers',
  '/root/.ssh',
  '/root/.aws',
  '/root/.config',
  '~/.ssh',
  '~/.aws',
  '~/.config',
  '~/.bash_history',
  '~/.zsh_history',
  '~/.kube',
  '/proc',
  '/sys',
  '/dev',
  '/boot',
  '/sys/kernel',
  'C:\\Windows\\System32',
  'C:\\Windows\\SysWOW64',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
]

/** 敏感文件扩展名和名称 */
const SENSITIVE_FILE_PATTERNS = [
  /\.env$/i,
  /\.env\.\w+$/i,
  /\.ssh$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /credentials$/i,
  /secret$/i,
  /password$/i,
  /token$/i,
  /\.aws$/i,
  /\.kube$/i,
  /\.docker$/i,
  /\.git\/config$/i,
  /\.git\/HEAD$/i,
]

/**
 * 真实路径解析：跟踪符号链接 + 转绝对路径。
 *
 * 与 `src/services/pathUtils.ts::normalizePath` 不同：
 *   - renderer 端那个是「纯字符串归一化」（小写、统一斜杠、去尾斜杠），不读盘
 *   - 这里这个是「磁盘解析」（fs.realpathSync / path.resolve），会触盘 IO
 *
 * 早期两个函数同名容易让维护者把两侧逻辑搞混。重命名后语义自描述：
 *   - `realResolveAbsolutePath` = 实路径解析为绝对路径（symlink-aware）
 *
 * 文件存在 → 走 realpath（消除 symlink，得到 OS 上唯一指向）
 * 文件不存在 → 用 baseDir 或 process.cwd() 做 path.resolve fallback。
 *
 * **缓存**：每次 IPC handler 入口都会调一次 `validateToolPath`，AI 一次迭代
 * 可能要解析 20+ 个路径。`existsSync` + `realpathSync` 各 ~50–500µs，叠加
 * 会出现可感知的微卡顿。我们对最近解析过的路径做小型 LRU；同一进程会话内
 * 的工作目录 / workspace 目录是稳定的，命中率极高。TTL 限制到几秒以避免
 * 把磁盘上 rename 后的旧解析结果拖进新一轮请求。
 */
const REALPATH_CACHE_MAX = 256
const REALPATH_CACHE_TTL_MS = 5_000
type RealpathCacheEntry = { value: string; expiresAt: number }
const realpathCache = new Map<string, RealpathCacheEntry>()

/** @internal Test-only — clears the realpath cache between cases. */
export function __resetPathSecurityCacheForTests(): void {
  realpathCache.clear()
}

function realpathCacheGet(key: string): string | undefined {
  const hit = realpathCache.get(key)
  if (!hit) return undefined
  if (hit.expiresAt < Date.now()) {
    realpathCache.delete(key)
    return undefined
  }
  // Touch: re-insert to refresh recency for LRU eviction order (Map keeps
  // insertion order for iteration, so delete+set moves to most-recent).
  realpathCache.delete(key)
  realpathCache.set(key, hit)
  return hit.value
}

function realpathCacheSet(key: string, value: string): void {
  if (realpathCache.size >= REALPATH_CACHE_MAX) {
    const oldestKey = realpathCache.keys().next().value
    if (oldestKey !== undefined) realpathCache.delete(oldestKey)
  }
  realpathCache.set(key, { value, expiresAt: Date.now() + REALPATH_CACHE_TTL_MS })
}

export function realResolveAbsolutePath(filePath: string, baseDir?: string): string {
  // Cache key includes baseDir because the same relative input resolves
  // differently under different roots (workspace switch, cwd-dependent calls).
  const cacheKey = baseDir ? `${baseDir}\u0001${filePath}` : `\u0000${filePath}`
  const cached = realpathCacheGet(cacheKey)
  if (cached !== undefined) return cached

  let resolved: string
  try {
    if (fs.existsSync(filePath)) {
      resolved = fs.realpathSync(filePath)
    } else {
      resolved = baseDir ? path.resolve(baseDir, filePath) : path.resolve(filePath)
    }
  } catch {
    resolved = baseDir ? path.resolve(baseDir, filePath) : path.resolve(filePath)
  }
  realpathCacheSet(cacheKey, resolved)
  return resolved
}

/**
 * @deprecated 使用 {@link realResolveAbsolutePath}。本别名仅为保留旧测试和外部
 * 调用兼容；renderer 还有一个纯字符串版的 `normalizePath`，重名容易混淆。
 */
export const normalizePath = realResolveAbsolutePath

/**
 * 检查路径是否在 workspace 范围内
 */
export function isPathWithinWorkspace(filePath: string, workspaceRoot: string): boolean {
  const normalized = realResolveAbsolutePath(filePath, workspaceRoot)
  const normalizedWorkspace = realResolveAbsolutePath(workspaceRoot)

  // 确保路径以分隔符结尾，避免 /workspace/foo 被认为在 /workspace2 内
  const workspaceWithSep = normalizedWorkspace.endsWith(path.sep)
    ? normalizedWorkspace
    : normalizedWorkspace + path.sep

  return normalized === normalizedWorkspace || normalized.startsWith(workspaceWithSep)
}

/**
 * 检查路径是否在禁止列表中
 *
 * 比较使用「全部小写 + 全部正斜杠」的规范化形式，原因：
 *  - FORBIDDEN_PATHS 同时包含 POSIX (`/etc/passwd`、`~/.ssh`) 和 Windows
 *    (`C:\Windows\System32`) 风格的字面量。
 *  - realResolveAbsolutePath 走的是 path.resolve / realpathSync，输出当前平台
 *    原生分隔符。如果两边不统一就会出现 `c:/users/x/.ssh` ≠ `c:\users\x\.ssh`
 *    的假阴性。
 */
export function isPathForbidden(filePath: string): { forbidden: boolean; reason: string } {
  const toForwardLower = (s: string) => s.replace(/\\/g, '/').toLowerCase()
  const normalized = toForwardLower(realResolveAbsolutePath(filePath))

  // ~ 展开：Windows 上 process.env.HOME 通常未设置（家目录走 USERPROFILE），
  // 旧代码 fallback 到 '/root' 导致 `~/.ssh` 之类规则在 Windows 永远不命中
  // 真实家目录。改走 os.homedir()，它在三大平台上都能给出正确路径
  // （Windows = USERPROFILE，POSIX = HOME 或 passwd entry）。HOME 仍优先
  // 以兼容显式覆盖（Git Bash / MSYS / 容器环境）。
  const homeDir = process.env.HOME || os.homedir() || '/root'

  for (const forbiddenPattern of FORBIDDEN_PATHS) {
    const expandedPattern = toForwardLower(forbiddenPattern.replace('~', homeDir))

    if (normalized.includes(expandedPattern) || normalized.startsWith(expandedPattern)) {
      return {
        forbidden: true,
        reason: `路径 "${filePath}" 在禁止访问列表中（${forbiddenPattern}）`,
      }
    }
  }

  return { forbidden: false, reason: '' }
}

/**
 * 检查文件是否为敏感类型
 */
export function isSensitiveFile(filePath: string): boolean {
  const fileName = path.basename(filePath)

  for (const pattern of SENSITIVE_FILE_PATTERNS) {
    if (pattern.test(fileName) || pattern.test(filePath)) {
      return true
    }
  }

  return false
}

/**
 * 验证工具路径的安全性
 */
export function validateToolPath(
  filePath: string,
  operation: 'read' | 'write' | 'delete',
  workspaceRoot?: string,
): PathSecurityAnalysis {
  const normalized = realResolveAbsolutePath(filePath)
  let verdict: SecurityVerdict = 'allow'
  let reason = ''
  let isWithinWorkspace = true
  let isForbidden = false
  let isSensitive = false

  // 检查禁止路径
  const forbiddenCheck = isPathForbidden(normalized)
  if (forbiddenCheck.forbidden) {
    verdict = 'deny'
    reason = forbiddenCheck.reason
    isForbidden = true
    return {
      verdict,
      reason,
      isWithinWorkspace,
      isForbidden,
      isSensitive,
      normalizedPath: normalized,
    }
  }

  // 检查敏感文件
  if (isSensitiveFile(normalized)) {
    isSensitive = true
    if (operation === 'write' || operation === 'delete') {
      verdict = 'warn'
      reason = `警告：操作敏感文件 "${path.basename(normalized)}" - 需要确认`
    }
  }

  // 对于 write 和 delete 操作，检查 workspace 范围
  if ((operation === 'write' || operation === 'delete') && workspaceRoot) {
    if (!isPathWithinWorkspace(normalized, workspaceRoot)) {
      verdict = 'deny'
      reason = `${operation === 'write' ? '写入' : '删除'}操作必须在 workspace 范围内`
      isWithinWorkspace = false
      return {
        verdict,
        reason,
        isWithinWorkspace,
        isForbidden,
        isSensitive,
        normalizedPath: normalized,
      }
    }
  }

  // read 操作可以在 workspace 外，但要警告
  if (operation === 'read' && workspaceRoot) {
    if (!isPathWithinWorkspace(normalized, workspaceRoot)) {
      isWithinWorkspace = false
      if (isSensitive) {
        verdict = 'warn'
        reason = `警告：读取 workspace 外的敏感文件`
      }
    }
  }

  if (!reason) {
    reason = `路径验证通过：${operation} 操作允许`
  }

  return {
    verdict,
    reason,
    isWithinWorkspace,
    isForbidden,
    isSensitive,
    normalizedPath: normalized,
  }
}

/**
 * 安全化路径：标准化 + 验证
 */
export function sanitizePath(filePath: string, workspaceRoot?: string): string | null {
  const normalized = realResolveAbsolutePath(filePath)

  // 检查禁止路径
  const forbiddenCheck = isPathForbidden(normalized)
  if (forbiddenCheck.forbidden) {
    return null
  }

  // 检查 workspace 范围（如果提供）
  if (workspaceRoot && !isPathWithinWorkspace(normalized, workspaceRoot)) {
    return null
  }

  return normalized
}
