export type AskPreviewFormat = 'markdown' | 'html'

export function askQuestionUsesPreviewSidebar(
  q: { multiSelect?: boolean; options: Array<{ preview?: string }> },
  previewFormat: AskPreviewFormat | undefined,
): boolean {
  return (
    !q.multiSelect &&
    (previewFormat === 'markdown' || previewFormat === 'html') &&
    q.options.some((o) => (o.preview ?? '').trim().length > 0)
  )
}
