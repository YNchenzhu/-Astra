import type { BashSecurityCode } from './bashCodes'

export interface CommandAnalysis {
  raw: string
  commandName: string
  commandBaseName: string
  args: string[]
  hasPipe: boolean
  hasRedirect: boolean
  hasCommandSubstitution: boolean
  hasVariableRef: boolean
}

/** Absolute-path bypass: `/bin/rm` → basename `rm` for blacklist matching */
export function analyzeCommand(raw: string): CommandAnalysis[] {
  const commands: CommandAnalysis[] = []
  const parts = raw.split(/[|;]|&&|\|\|/)

  for (const part of parts) {
    const trimmed = part.trim()
    if (!trimmed) continue

    const tokens = tokenizeCommand(trimmed)
    if (tokens.length === 0) continue

    const commandName = tokens[0]
    const commandBaseName = commandName.includes('/')
      ? commandName.slice(commandName.lastIndexOf('/') + 1)
      : commandName
    const args = tokens.slice(1)

    commands.push({
      raw: trimmed,
      commandName,
      commandBaseName,
      args,
      hasPipe: raw.includes('|'),
      hasRedirect: /[<>]/.test(trimmed),
      hasCommandSubstitution: /\$\(|`/.test(trimmed),
      hasVariableRef: /\$\{|\$[A-Za-z_]/.test(trimmed),
    })
  }

  return commands
}

function tokenizeCommand(cmd: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let i = 0

  while (i < cmd.length) {
    const ch = cmd[i]

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      i++
      continue
    }

    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      i++
      continue
    }

    if (ch === '\\' && i + 1 < cmd.length) {
      current += cmd[i + 1]
      i += 2
      continue
    }

    if ((ch === ' ' || ch === '\t') && !inSingleQuote && !inDoubleQuote) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      i++
      continue
    }

    current += ch
    i++
  }

  if (current) {
    tokens.push(current)
  }

  return tokens
}

/** Counts `;`, `&&`, `||`, and single `|` (not `||`). */
export function countStructuralChainOperators(command: string): number {
  let n = 0
  n += (command.match(/&&/g) || []).length
  n += (command.match(/\|\|/g) || []).length
  n += (command.match(/;/g) || []).length
  n += (command.match(/\|(?!\|)/g) || []).length
  return n
}

/** Bash-style `` `cmd` `` substitution (not PowerShell escape backticks). */
export const BASH_STYLE_BACKTICK_SUBSTITUTION = /(?:^|[\s;|&(])`[^`\r\n]+`(?:[\s;|&)]|$)/m

/** 绝对禁止的危险命令（basename） */
export const DANGEROUS_COMMANDS = new Set([
  'rm',
  'mkfs',
  'dd',
  'shred',
  'wipe',
  'format',
  'fdisk',
  'parted',
  'cryptsetup',
  'dmsetup',
  ':(){:|:&};',
  'fork',
])

export const WARN_COMMANDS = new Set([
  'chmod',
  'chown',
  'kill',
  'killall',
  'pkill',
  'git',
  'sudo',
  'su',
  'passwd',
  'useradd',
  'userdel',
  'groupadd',
  'groupdel',
  'systemctl',
  'service',
  'reboot',
  'shutdown',
  'halt',
  'poweroff',
])

export const READ_ONLY_COMMANDS = new Set([
  'ls',
  'cat',
  'grep',
  'find',
  'echo',
  'pwd',
  'date',
  'whoami',
  'id',
  'uname',
  'which',
  'whereis',
  'file',
  'head',
  'tail',
  'wc',
  'sort',
  'uniq',
  'cut',
  'awk',
  'sed',
  'tr',
  'strings',
  'hexdump',
  'od',
  'stat',
  'lstat',
  'readlink',
  'realpath',
  'dirname',
  'basename',
  'git',
  'npm',
  'yarn',
  'python',
  'python3',
  'node',
  'ruby',
  'java',
  'javac',
  'gcc',
  'g++',
  'clang',
  'rustc',
  'cargo',
  'go',
  'docker',
  'kubectl',
  'curl',
  'wget',
  'ping',
  'traceroute',
  'netstat',
  'ss',
  'ifconfig',
  'ip',
  'dig',
  'nslookup',
  'host',
  'ps',
  'top',
  'htop',
  'free',
  'df',
  'du',
  'lsof',
  'strace',
  'ltrace',
  'gdb',
  'lldb',
])

export function appendCode(codes: BashSecurityCode[], code: BashSecurityCode): void {
  if (!codes.includes(code)) {
    codes.push(code)
  }
}
