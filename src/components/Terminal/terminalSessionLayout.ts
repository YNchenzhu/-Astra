import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'

/** 与 TerminalPanel 内 xterm 会话结构一致；抽离以便在模块级更新 DOM，避免 react-hooks 对 ref 内联改写的误报 */
export type TerminalSessionRecord = {
  xterm: Terminal
  fitAddon: FitAddon
  container: HTMLDivElement
  unsubData: (() => void) | null
  unsubExit: (() => void) | null
  /** xterm `onData` subscription — dispose before `xterm.dispose()` for explicit teardown. */
  disposeLocalOnData: (() => void) | null
}

export function setTerminalSessionsVisibility(
  sessions: Map<number, TerminalSessionRecord>,
  activeTerminalId: number | null,
  terminalTabActive: boolean,
): void {
  for (const [id, session] of sessions) {
    const visible = terminalTabActive && id === activeTerminalId
    session.container.style.display = visible ? 'block' : 'none'
  }
}
