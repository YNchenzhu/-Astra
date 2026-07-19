/** 与 TerminalPanel 内监听的事件名一致，供菜单/命令面板触发清空当前终端 */
export function clearTerminalInstance(): void {
  document.dispatchEvent(new CustomEvent('terminal:clear'))
}
