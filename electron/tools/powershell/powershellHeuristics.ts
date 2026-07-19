/**
 * PowerShell-specific security heuristics — subset of upstream
 * `PowerShellTool/powershellSecurity.ts` (regex; no AST/parser).
 */

import type { BashSecurityCode } from '../bash/bashCodes'
import { BashSecurityCode as C } from '../bash/bashCodes'
import { appendCode } from '../bash/commandAnalysis'

function add(codes: BashSecurityCode[], reasons: string[], code: BashSecurityCode, reason: string): void {
  appendCode(codes, code)
  reasons.push(reason)
}

/**
 * Returns true if any rule triggered a deny (caller sets verdict deny).
 */
export function applyPowerShellHeuristicDenies(
  command: string,
  codes: BashSecurityCode[],
  reasons: string[],
): boolean {
  let denied = false
  const cmd = command

  if (/\b(?:Invoke-Expression|iex)\b/i.test(cmd)) {
    add(codes, reasons, C.PS_INVOKE_EXPRESSION, 'PowerShell: Invoke-Expression / iex executes arbitrary code')
    denied = true
  }

  if (
    /(?:^|[;|\s])\s*(?:pwsh|powershell)(?:\.exe)?\b[^|\n]*?(?:-enc(?:oded[a-z]*)?|-e)\b/i.test(cmd) ||
    /\s-(?:encodedcommand|enc)\b/i.test(cmd)
  ) {
    add(codes, reasons, C.PS_ENCODED_COMMAND, 'PowerShell: encoded command (-enc / -EncodedCommand) obscures intent')
    denied = true
  }

  if (/(?:^|[;|])\s*(?:&\s*)?(?:\.\/)?(?:pwsh|powershell)(?:\.exe)?(?=\s)/im.test(cmd)) {
    add(codes, reasons, C.PS_NESTED_PWSH, 'PowerShell: nested pwsh/powershell invocation cannot be statically validated')
    denied = true
  }

  const hasDl = /\b(?:Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b/i.test(cmd)
  const hasIex = /\b(?:Invoke-Expression|iex)\b/i.test(cmd)
  if (hasDl && hasIex) {
    add(codes, reasons, C.PS_DOWNLOAD_IEX, 'PowerShell: download + Invoke-Expression pattern (cradle)')
    denied = true
  }

  if (/\bStart-BitsTransfer\b/i.test(cmd)) {
    add(codes, reasons, C.PS_DOWNLOAD_UTILITY, 'PowerShell: Start-BitsTransfer (file transfer)')
    denied = true
  }

  if (/\bcertutil(?:\.exe)?\b/i.test(cmd) && /[-/]urlcache\b/i.test(cmd)) {
    add(codes, reasons, C.PS_DOWNLOAD_UTILITY, 'certutil URL download (-urlcache)')
    denied = true
  }

  if (/\bbitsadmin(?:\.exe)?\b/i.test(cmd) && /\/transfer\b/i.test(cmd)) {
    add(codes, reasons, C.PS_DOWNLOAD_UTILITY, 'bitsadmin /transfer (BITS download)')
    denied = true
  }

  if (/\bAdd-Type\b/i.test(cmd)) {
    add(codes, reasons, C.PS_ADD_TYPE, 'PowerShell: Add-Type loads/compiles .NET code')
    denied = true
  }

  if (/\b(?:Import-Module|ipmo|Install-Module|Install-Script|Save-Module)\b/i.test(cmd)) {
    add(codes, reasons, C.PS_IMPORT_MODULE, 'PowerShell: module/script install or import executes top-level code risk')
    denied = true
  }

  if (/\.(?:DownloadString|DownloadFile|DownloadData)\s*\(/i.test(cmd) || /\bNet\.WebClient\b/i.test(cmd)) {
    add(codes, reasons, C.PS_WEBCLIENT, 'PowerShell: WebClient / DownloadString-style download API')
    denied = true
  }

  if (/\bStart-Process\b/i.test(cmd) && /(?:-Verb\s+\S*RunAs|RunAs)/i.test(cmd)) {
    add(codes, reasons, C.PS_START_PROCESS_ELEVATE, 'PowerShell: Start-Process elevation (RunAs)')
    denied = true
  }

  if (/\b(?:Invoke-WmiMethod|iwmi|Invoke-CimMethod)\b/i.test(cmd)) {
    add(codes, reasons, C.PS_WMI_CIM, 'PowerShell: WMI/CIM method invocation can spawn processes')
    denied = true
  }

  if (/(?:^|[;|])\s*&\s*[$(]/m.test(cmd) || /&\s*\$\{/m.test(cmd)) {
    add(codes, reasons, C.PS_DYNAMIC_INVOKE, 'PowerShell: dynamic invocation & with expression (not a static command name)')
    denied = true
  }

  // `\b-X` cannot match `-X` after whitespace because `\b` requires a
  // word↔non-word transition, and both space and `-` are non-word — the
  // boundary fails. Use a negative lookbehind that excludes word chars and
  // hyphens so `something -ExecutionPolicy Bypass` matches but
  // `--ExecutionPolicy` (compound argument shape, not the actual flag) does not.
  if (/(?<![\w-])-ExecutionPolicy\s+Bypass\b/i.test(cmd)) {
    add(codes, reasons, C.PS_EXEC_POLICY_BYPASS, 'PowerShell: ExecutionPolicy Bypass')
    denied = true
  }

  if (/\[Reflection\.Assembly\]\s*::\s*Load\b/i.test(cmd) || /\bLoadFrom\s*\(/i.test(cmd)) {
    add(codes, reasons, C.PS_REFLECTION_LOAD, 'PowerShell: reflection assembly load')
    denied = true
  }

  if (/\bNew-Object\s+-(?:ComObject|Com)\b/i.test(cmd) || /\bWScript\.Shell\b/i.test(cmd)) {
    add(codes, reasons, C.PS_COM_SCRIPTING, 'PowerShell: COM scripting object (e.g. WScript.Shell)')
    denied = true
  }

  // --- Second wave: 7 LOLBin / persistence / escalation patterns ---
  // Real-world attack patterns the regex set above misses. Each is a single
  // line because PowerShell's tokenizer accepts these in unambiguous form;
  // no AST needed.
  //
  // BOUNDARY CONVENTION for cmdlet-name checks:
  //   `(?<![\w-])CmdletName(?![\w-])`
  // We use lookbehind + lookahead instead of bare `\b` for TWO reasons:
  //   (a) `\b` is symmetric word↔non-word, so it fires between `-` and a
  //       word char — meaning `Custom-Invoke-Item` would match `\bInvoke-Item`.
  //       PS cmdlets ARE allowed to contain hyphens, so this is a real FP.
  //   (b) Same on the trailing side: `Invoke-Item-Pro` is a distinct cmdlet.
  // The same pre-existing bug was lurking in `\b-ExecutionPolicy\s+Bypass`
  // above; that's why we already switched it to `(?<![\w-])`.

  // 1) Invoke-Item / ii — equivalent to double-clicking a file in Explorer.
  //    `ii .\malware.exe` opens it with the registered shell handler. Used
  //    in LOLBin chains as a stealthier `Start-Process`.
  if (
    /(?<![\w-])Invoke-Item(?![\w-])/i.test(cmd) ||
    /(?:^|[;|&\n])\s*ii(?![\w-])/m.test(cmd)
  ) {
    add(codes, reasons, C.PS_INVOKE_ITEM, 'PowerShell: Invoke-Item/ii launches a file via the shell (like double-clicking)')
    denied = true
  }

  // 2) Scheduled-task persistence — Register-/Set-/Enable-/Disable-/Unregister-
  //    ScheduledTask and `schtasks.exe`. Get-ScheduledTask is intentionally NOT
  //    blocked (read-only listing). The mutating cmdlets are the persistence vector.
  if (
    /(?<![\w-])(?:Register|Unregister|Set|Enable|Disable)-ScheduledTask(?![\w-])/i.test(cmd) ||
    /(?<![\w-])schtasks(?:\.exe)?(?![\w-])/i.test(cmd)
  ) {
    add(codes, reasons, C.PS_SCHEDULED_TASK, 'PowerShell: scheduled-task mutation (Register/Set/Enable/Disable/Unregister-ScheduledTask or schtasks.exe) — persistence vector')
    denied = true
  }

  // 3) Set-ExecutionPolicy cmdlet — distinct from the existing
  //    `-ExecutionPolicy Bypass` parameter check (which only catches the
  //    `pwsh.exe -ExecutionPolicy Bypass` invocation form). The cmdlet form
  //    `Set-ExecutionPolicy Unrestricted -Scope CurrentUser` permanently
  //    weakens the user's policy across all future sessions.
  if (/(?<![\w-])Set-ExecutionPolicy(?![\w-])/i.test(cmd)) {
    add(codes, reasons, C.PS_SET_EXEC_POLICY, 'PowerShell: Set-ExecutionPolicy cmdlet weakens the persistent execution policy (separate from -ExecutionPolicy Bypass parameter)')
    denied = true
  }

  // 4) `--%` stop-parsing token — everything after this token is passed
  //    verbatim to the called executable without PS tokenization. That means
  //    our regex-based heuristics are blind to anything that follows it
  //    (`npm install --% & calc.exe & echo`). Treat as deny rather than
  //    try to parse the unparseable.
  if (/(?:^|\s)--%(?:\s|$)/.test(cmd)) {
    add(codes, reasons, C.PS_STOP_PARSING, 'PowerShell: --% stop-parsing token makes everything after it opaque to security analysis')
    denied = true
  }

  // 5) `$env:X = ...` env-var assignment — modifies the process env, which
  //    affects later commands in the same shell session. The classic abuse
  //    is `$env:PATH = "C:\evil;$env:PATH"` to hijack later command lookups.
  //    Catches both `$env:X = …` and `${env:X} = …` syntax, and `+=` append.
  //    `-eq` (PS's equality operator) is `-eq`, not `=`, so comparison
  //    expressions don't false-match.
  if (
    /\$env:[A-Za-z_][A-Za-z0-9_]*\s*\+?=(?!=)/i.test(cmd) ||
    /\$\{env:[A-Za-z_][A-Za-z0-9_]*\}\s*\+?=(?!=)/i.test(cmd)
  ) {
    add(codes, reasons, C.PS_ENV_WRITE, 'PowerShell: $env: variable assignment — can hijack subsequent command resolution via PATH or shell-relevant env vars')
    denied = true
  }

  // 6) Dangerous .NET type literal static method calls — bypass cmdlet-level
  //    checks by invoking the .NET API directly. Examples:
  //      [System.IO.File]::WriteAllText("$env:USERPROFILE\evil.bat", ...)
  //      [System.Diagnostics.Process]::Start("calc.exe")
  //      [System.Reflection.Assembly]::Load($bytes)
  //    Deny-list of dangerous bases — narrow enough that legitimate use of
  //    [Math]::Round / [DateTime]::UtcNow / [String]::IsNullOrEmpty is fine.
  //    The `System.` namespace prefix is optional in PS (auto-imported).
  if (
    /\[(?:(?:System|Microsoft)\.)?(?:IO\.(?:File|Directory|Path)|Diagnostics\.Process|Net\.WebClient|Net\.Sockets|Reflection\.Assembly|Activator|AppDomain|Management\.Automation|Win32\.Registry|Win32\.OpenProcess)[\w.]*\]\s*::/i.test(cmd) ||
    /\[WMIClass\]/i.test(cmd)
  ) {
    add(codes, reasons, C.PS_TYPE_LITERAL_INVOKE, 'PowerShell: dangerous .NET type static-method invocation (filesystem / process / reflection / WMI bypass of cmdlet-level checks)')
    denied = true
  }

  // 7) Invoke-Command / icm — runs an arbitrary script block, locally or
  //    on a remote session. Semantically equivalent to `Invoke-Expression`
  //    for execution capability but uses script-block syntax instead of
  //    a string, so the existing IEX regex doesn't catch it.
  if (
    /(?<![\w-])Invoke-Command(?![\w-])/i.test(cmd) ||
    /(?:^|[;|&\n])\s*icm(?![\w-])/m.test(cmd)
  ) {
    add(codes, reasons, C.PS_INVOKE_COMMAND, 'PowerShell: Invoke-Command runs an arbitrary script block (local or remote) — IEX-equivalent for code execution')
    denied = true
  }

  return denied
}
