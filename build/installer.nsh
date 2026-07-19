; ─────────────────────────────────────────────────────────────────────
;  build/installer.nsh — custom NSIS hooks for Astra (星构Astra installer).
;
;  Goal: make the `…-setup.exe` installer succeed at the file-replace
;  phase even when the previous installation has lingering helper
;  processes (winpty-agent, OpenConsole, …) and even when Windows
;  Defender / Search Indexer briefly hold mmap views on the on-disk
;  binaries.
;
;  ── Root causes we are defending against ──
;
;    1. node-pty spawns DETACHED helpers (`winpty-agent.exe`,
;       `OpenConsole.exe`) under the install dir. They outlive
;       `astra.exe` and are NOT killed by `taskkill /T /IM
;       astra.exe`. electron-builder's CHECK_APP_RUNNING macro
;       reports the install as "still running" → "cannot close app"
;       dialog.
;
;    2. Even after every helper process is dead, Windows can hold
;       file-mapping views on the .exe / .dll / .pak binaries for a
;       further few seconds because:
;          • Windows Defender real-time scan touched the file (very
;            common — Defender scans the install dir the moment any
;            installer-looking process starts I/O against it),
;          • Windows Search Indexer is enumerating the folder,
;          • Explorer cached the .exe icon / thumbnail.
;       During this window, the legacy uninstaller's
;       `un.atomicRMDir` macro (uninstaller.nsh:38) tries to `Rename`
;       every file out of $INSTDIR — and `Rename` on a mapped file
;       fails with errorlevel 2. `uninstallOldVersion` retries 5×
;       with 1s sleep between attempts, then bubbles up
;       "Failed to uninstall old application files. …: 2".
;
;  ── Four-layer mitigation ──
;
;    Layer A — `preInit` hook (in NEW installer's `.onInit`,
;    earliest possible point): kill every known Astra helper
;    by image name + PowerShell path-match cleanup of anything
;    whose Path contains "Astra". Sleep 1500ms.
;
;    Layer B — `customInit` hook (in NEW installer's `.onInit`,
;    just before user sees the Welcome page): kill again with the
;    same logic. Two passes cover the case where a Windows service
;    (Defender / Indexer) had briefly held a handle in the gap
;    between preInit and the file-copy phase — by now Defender's
;    initial scan of `setup.exe` has finished and let go.
;
;    Layer C — `customRemoveFiles` hook (in THIS version's
;    uninstaller, used when v0.3.0 → v0.4.0 etc.): replace the
;    finicky `atomicRMDir` rename-and-move with `RMDir /r
;    /REBOOTOK`. `/REBOOTOK` schedules locked files for deletion
;    on next reboot rather than aborting. The user never sees an
;    error; the locked files (if any) are gone after the next
;    reboot, while the install otherwise completes successfully.
;
;    Layer D — `customUnInit` hook (in THIS version's uninstaller):
;    kill processes at the START of uninstall (silent OR
;    interactive). For FUTURE upgrades from THIS version onward,
;    the new installer silently invokes our uninstaller and we kill
;    BEFORE deleting anything.
;
;  Note: Layer C only helps starting from v0.3.0's uninstaller
;  (i.e. v0.3.0 → v0.4.0 will be smooth). For the CURRENT
;  v0.2.0 → v0.3.0 upgrade, v0.2.0's uninstaller has the legacy
;  atomicRMDir behaviour — Layers A + B cover that path by killing
;  early and waiting long enough for file locks to clear.
; ─────────────────────────────────────────────────────────────────────

!macro killAstraProcesses _settleMs
  DetailPrint "Stopping any running Astra processes (incl. PTY helpers)…"

  ; Image-name taskkill: catches every helper that ships in our installer
  ; tree. `/F` force, `/T` tree (children spawned BY the matched PID).
  ; Exit code "process not found" is ignored — we don't read $0.
  nsExec::Exec 'taskkill.exe /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  nsExec::Exec 'taskkill.exe /F /T /IM "winpty-agent.exe"'
  Pop $0
  nsExec::Exec 'taskkill.exe /F /T /IM "OpenConsole.exe"'
  Pop $0
  nsExec::Exec 'taskkill.exe /F /T /IM "elevate.exe"'
  Pop $0

  ; PowerShell path-match cleanup: same query electron-builder's own
  ; KILL_PROCESS macro uses internally, but with a path regex instead of
  ; `.StartsWith($INSTDIR)` since $INSTDIR is not yet bound during
  ; `.onInit`. Catches helpers we haven't enumerated and any case where
  ; image-name kill missed a variant (AV-renamed binary, future node-pty
  ; helper, …). `$$_` is the NSIS-escaped `$_`.
  ;
  ; 'Astra' matches the install layout — the "星构Astra" product dir
  ; contains that ASCII substring. The regex itself is kept ASCII-only
  ; so process matching can't be broken by any source-encoding mishap
  ; between NSIS and PowerShell.
  ;
  ; CRITICAL exclusion: the installer / uninstaller processes themselves
  ; also match 'Astra' (…\星构Astra-x.y.z-setup.exe, $INSTDIR\Uninstall
  ; ….exe, NSIS temp Un_A.exe). Without the Name filter this macro
  ; KILLS ITS OWN INSTALLER during .onInit — seen as electron-builder's
  ; uninstaller-generation run dying with exit code 4294967295 (-1, the
  ; Process.Kill() exit code), and it would equally abort real user
  ; installs. Never remove the notmatch clause.
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "try { Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue | Where-Object { $$_.Path -and $$_.Path -match 'Astra' -and $$_.Name -notmatch 'setup|uninst|un_a' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue } } catch {}"`
  Pop $0

  ; Settle: let Windows release file-mapping views + give Defender's
  ; reactive scan time to finish. Caller picks the duration —
  ; preInit uses 1500ms (fast feedback), customInit uses 2500ms
  ; (closer to actual file-replace phase, no perceptible UX cost
  ; since we're already in the .onInit "preparing installer…"
  ; window the user is staring at).
  Sleep ${_settleMs}
!macroend

; ── Layer A: kill at the very start of `.onInit` ──────────────────────
!macro preInit
  !insertmacro killAstraProcesses 1500
!macroend

; ── Layer B: kill again at the end of `.onInit`, right before the UI
;             shows the Welcome page. Defender's initial scan of the
;             setup.exe binary has finished by now, so handles it had
;             on the install tree are released. ──────────────────────
!macro customInit
  !insertmacro killAstraProcesses 2500
!macroend

; ── Layer C: gentle uninstaller (only used from v0.3.0's uninst.exe
;             onward). `/REBOOTOK` defers locked-file removal to the
;             next reboot instead of aborting the entire uninstall. ──
!macro customRemoveFiles
  ${if} ${isUpdated}
    ; Skip atomic move during upgrade — let the new installer write
    ; over our files directly. NSIS' SetOverwrite default is "on" so
    ; the installApplicationFiles macro that follows will replace
    ; every file. For files Windows can't overwrite (locked), the
    ; installer's File command will set the rename-on-reboot flag.
    RMDir /r /REBOOTOK "$INSTDIR"
  ${else}
    ; True user-initiated uninstall: keep the standard behaviour but
    ; with /REBOOTOK so a locked file doesn't leave the uninstaller
    ; aborted halfway with broken state.
    RMDir /r /REBOOTOK "$INSTDIR"
  ${endif}
!macroend

; ── Layer D: kill processes when uninstall begins (silent or not) ────
!macro customUnInit
  !insertmacro killAstraProcesses 1500
!macroend
