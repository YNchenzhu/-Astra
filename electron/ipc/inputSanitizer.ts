/**
 * IPC 输入净化层 — 类型检查 + 敏感字段过滤
 *
 * 对渲染进程的所有 IPC 输入进行严格验证，防止：
 * 1. 类型混淆攻击
 * 2. 敏感字段注入
 * 3. 超长输入导致的 DoS
 * 4. 非法配置值
 */

export interface SanitizedSettings {
  [key: string]: unknown
}

export interface SanitizedMcpConfig {
  transport: 'stdio' | 'sse'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
}

/** 允许的设置字段白名单 */
const ALLOWED_SETTINGS_FIELDS = new Set([
  'theme',
  'fontSize',
  'fontFamily',
  'lineHeight',
  'tabSize',
  'insertSpaces',
  'wordWrap',
  'minimap',
  'prefersReducedMotion',
  'autoSave',
  'formatOnSave',
  'defaultLanguage',
  'locale',
  'apiKey',
  'apiEndpoint',
  'model',
  'temperature',
  'maxTokens',
])

/** 禁止修改的敏感字段 */
const FORBIDDEN_SETTINGS_FIELDS = new Set([
  'workspaceRoot',
  'userId',
  'sessionId',
  'internalState',
  'debugMode',
  'telemetry',
])

const PROTOTYPE_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const MAX_SETTINGS_PATCH_TOP_KEYS = 400
const MAX_SETTINGS_VALUE_DEPTH = 24
const MAX_SETTINGS_STRING_LEN = 2_000_000
const MAX_SETTINGS_ARRAY_LEN = 20_000

/** 字符串字段的最大长度 */
const MAX_STRING_LENGTH = 10000

/** 数组字段的最大元素数 */
const MAX_ARRAY_LENGTH = 1000

/**
 * 净化设置输入
 */
export function sanitizeSettingsInput(raw: unknown): SanitizedSettings {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('设置必须是对象类型')
  }

  const sanitized: SanitizedSettings = {}
  const obj = raw as Record<string, unknown>

  for (const [key, value] of Object.entries(obj)) {
    // 检查字段是否在白名单中
    if (!ALLOWED_SETTINGS_FIELDS.has(key)) {
      console.warn(`[IPC] 忽略未知设置字段: ${key}`)
      continue
    }

    // 检查是否为禁止字段
    if (FORBIDDEN_SETTINGS_FIELDS.has(key)) {
      throw new Error(`禁止修改敏感字段: ${key}`)
    }

    // 根据字段类型进行验证
    switch (key) {
      case 'theme':
        if (typeof value === 'string' && ['light', 'dark', 'system'].includes(value)) {
          sanitized[key] = value
        } else {
          throw new Error(`无效的主题值: ${value}`)
        }
        break

      case 'fontSize':
      case 'tabSize':
      case 'lineHeight':
        if (typeof value === 'number' && value > 0 && value < 1000) {
          sanitized[key] = value
        } else {
          throw new Error(`无效的数值字段 ${key}: ${value}`)
        }
        break

      case 'fontFamily':
      case 'defaultLanguage':
      case 'locale':
        if (typeof value === 'string' && value.length <= 100) {
          sanitized[key] = value
        } else {
          throw new Error(`无效的字符串字段 ${key}`)
        }
        break

      case 'insertSpaces':
      case 'wordWrap':
      case 'minimap':
      case 'prefersReducedMotion':
      case 'autoSave':
      case 'formatOnSave':
        if (typeof value === 'boolean') {
          sanitized[key] = value
        } else {
          throw new Error(`字段 ${key} 必须是布尔值`)
        }
        break

      case 'apiKey':
        if (typeof value === 'string' && value.length <= 500) {
          // 不在日志中输出 API 密钥
          sanitized[key] = value
        } else {
          throw new Error(`无效的 API 密钥`)
        }
        break

      case 'apiEndpoint':
        if (typeof value === 'string' && isValidUrl(value)) {
          sanitized[key] = value
        } else {
          throw new Error(`无效的 API 端点 URL`)
        }
        break

      case 'model':
        if (typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value) && value.length <= 100) {
          sanitized[key] = value
        } else {
          throw new Error(`无效的模型名称`)
        }
        break

      case 'temperature':
        if (typeof value === 'number' && value >= 0 && value <= 2) {
          sanitized[key] = value
        } else {
          throw new Error(`temperature 必须在 0-2 之间`)
        }
        break

      case 'maxTokens':
        if (typeof value === 'number' && value > 0 && value <= 1000000) {
          sanitized[key] = value
        } else {
          throw new Error(`maxTokens 必须在 1-1000000 之间`)
        }
        break

      default:
        console.warn(`[IPC] 未处理的设置字段: ${key}`)
    }
  }

  return sanitized
}

function sanitizeSettingsValueDeep(value: unknown, depth: number): unknown {
  if (depth > MAX_SETTINGS_VALUE_DEPTH) {
    throw new Error('设置嵌套过深')
  }
  // 渲染进程常见：可选字段显式为 undefined（JSON 无此类型，但对象键仍存在）
  if (value === undefined) {
    return undefined
  }
  if (value === null || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('无效的数值')
    }
    return value
  }
  if (typeof value === 'string') {
    if (value.length > MAX_SETTINGS_STRING_LEN) {
      throw new Error('字符串过长')
    }
    if (value.includes('\0')) {
      throw new Error('字符串包含非法字符')
    }
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_SETTINGS_ARRAY_LEN) {
      throw new Error('数组过长')
    }
    return value.flatMap((item) => {
      const next = sanitizeSettingsValueDeep(item, depth + 1)
      return next === undefined ? [] : [next]
    })
  }
  if (typeof value === 'object') {
    if (value instanceof Date) {
      return value.toISOString()
    }
    const o = value as Record<string, unknown>
    const keys = Object.keys(o)
    if (keys.length > MAX_SETTINGS_PATCH_TOP_KEYS) {
      throw new Error('对象键过多')
    }
    const result: Record<string, unknown> = {}
    for (const k of keys) {
      if (PROTOTYPE_POLLUTION_KEYS.has(k)) {
        continue
      }
      if (FORBIDDEN_SETTINGS_FIELDS.has(k)) {
        throw new Error(`禁止嵌套敏感字段: ${k}`)
      }
      const v = sanitizeSettingsValueDeep(o[k], depth + 1)
      if (v !== undefined) {
        result[k] = v
      }
    }
    return result
  }
  throw new Error('不支持的设置值类型')
}

/**
 * 净化 `settings:set` 合并补丁：保留应用定义的键，仅过滤禁止字段并限制深度/大小。
 * （与 {@link sanitizeSettingsInput} 的窄白名单不同，供渲染进程整包持久化使用。）
 */
export function sanitizeSettingsMergePatch(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('设置补丁必须是普通对象')
  }
  const obj = raw as Record<string, unknown>
  const keys = Object.keys(obj)
  if (keys.length > MAX_SETTINGS_PATCH_TOP_KEYS) {
    throw new Error('设置字段数量过多')
  }
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    if (PROTOTYPE_POLLUTION_KEYS.has(key)) {
      continue
    }
    if (FORBIDDEN_SETTINGS_FIELDS.has(key)) {
      throw new Error(`禁止修改敏感字段: ${key}`)
    }
    if (obj[key] === undefined) {
      continue
    }
    const v = sanitizeSettingsValueDeep(obj[key], 0)
    if (v !== undefined) {
      out[key] = v
    }
  }
  return out
}

/**
 * 净化文件路径输入
 */
export function sanitizeFilePath(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new Error('文件路径必须是字符串')
  }

  if (raw.length === 0 || raw.length > MAX_STRING_LENGTH) {
    throw new Error('文件路径长度无效')
  }

  // 检查危险的路径模式
  if (raw.includes('\0')) {
    throw new Error('文件路径包含空字符')
  }

  // 拒绝路径遍历尝试（如 ../ 等）
  if (raw.includes('..')) {
    throw new Error('文件路径不能包含 ".." 路径遍历模式')
  }

  return raw
}

/**
 * 净化终端命令输入
 */
export function sanitizeTerminalCommand(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new Error('终端命令必须是字符串')
  }

  if (raw.length === 0 || raw.length > 5000) {
    throw new Error('终端命令长度无效')
  }

  // 检查危险的命令模式
  if (raw.includes('\0')) {
    throw new Error('命令包含空字符')
  }

  return raw
}

/**
 * 净化 MCP 配置输入
 */
export function sanitizeMcpConfig(raw: unknown): SanitizedMcpConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('MCP 配置必须是对象类型')
  }

  const config = raw as Record<string, unknown>

  // 验证 transport 字段
  if (!config.transport || !['stdio', 'sse'].includes(config.transport as string)) {
    throw new Error('无效的 transport 类型')
  }

  const sanitized: SanitizedMcpConfig = {
    transport: config.transport as 'stdio' | 'sse',
  }

  // 验证 command 字段（stdio 模式必需）
  if (sanitized.transport === 'stdio') {
    if (typeof config.command !== 'string' || config.command.length === 0) {
      throw new Error('stdio 模式下 command 字段必需')
    }
    if (config.command.length > 500) {
      throw new Error('command 字段过长')
    }
    sanitized.command = config.command
  }

  // 验证 args 字段
  if (config.args !== undefined) {
    if (!Array.isArray(config.args)) {
      throw new Error('args 必须是数组')
    }
    if (config.args.length > MAX_ARRAY_LENGTH) {
      throw new Error('args 数组过长')
    }
    const sanitizedArgs: string[] = []
    for (const arg of config.args) {
      if (typeof arg !== 'string') {
        throw new Error('args 中的元素必须是字符串')
      }
      if (arg.length > 1000) {
        throw new Error('args 中的元素过长')
      }
      sanitizedArgs.push(arg)
    }
    sanitized.args = sanitizedArgs
  }

  // 验证 url 字段（sse 模式）
  if (sanitized.transport === 'sse') {
    if (typeof config.url !== 'string' || !isValidUrl(config.url)) {
      throw new Error('sse 模式下 url 字段必需且必须是有效的 URL')
    }
    sanitized.url = config.url
  }

  // 验证 env 字段
  if (config.env !== undefined) {
    if (typeof config.env !== 'object' || config.env === null) {
      throw new Error('env 必须是对象')
    }
    const sanitizedEnv: Record<string, string> = {}
    const envObj = config.env as Record<string, unknown>
    for (const [key, value] of Object.entries(envObj)) {
      if (typeof value !== 'string') {
        throw new Error(`env 中的值必须是字符串: ${key}`)
      }
      if (value.length > 5000) {
        throw new Error(`env 中的值过长: ${key}`)
      }
      // 检查敏感的环境变量名
      if (isSensitiveEnvVar(key)) {
        throw new Error(`禁止设置敏感环境变量: ${key}`)
      }
      sanitizedEnv[key] = value
    }
    sanitized.env = sanitizedEnv
  }

  return sanitized
}

/**
 * 检查是否为有效的 URL
 */
function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    // 只允许 http 和 https
    return ['http:', 'https:'].includes(parsed.protocol)
  } catch {
    return false
  }
}

/**
 * 检查是否为敏感的环境变量
 */
function isSensitiveEnvVar(name: string): boolean {
  const sensitiveVars = [
    'PATH',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'DYLD_INSERT_LIBRARIES',
    'IFS',
    'PS1',
    'PS2',
    'PROMPT_COMMAND',
    'SHELL',
    'BASH_ENV',
    'ENV',
  ]

  return sensitiveVars.includes(name.toUpperCase())
}

/**
 * 净化数组输入（通用）
 */
export function sanitizeArray(raw: unknown, maxLength: number = MAX_ARRAY_LENGTH): unknown[] {
  if (!Array.isArray(raw)) {
    throw new Error('输入必须是数组')
  }

  if (raw.length > maxLength) {
    throw new Error(`数组长��超过限制: ${maxLength}`)
  }

  return raw
}

/**
 * 净化字符串输入（通用）
 */
export function sanitizeString(raw: unknown, maxLength: number = MAX_STRING_LENGTH): string {
  if (typeof raw !== 'string') {
    throw new Error('输入必须是字符串')
  }

  if (raw.length > maxLength) {
    throw new Error(`字符串长度超过限制: ${maxLength}`)
  }

  if (raw.includes('\0')) {
    throw new Error('输入包含空字符')
  }

  return raw
}
