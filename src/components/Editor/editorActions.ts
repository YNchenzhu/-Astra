export function dispatchEditorAction(actionId: string) {
  document.dispatchEvent(new CustomEvent('editor:action', { detail: { actionId } }))
}
