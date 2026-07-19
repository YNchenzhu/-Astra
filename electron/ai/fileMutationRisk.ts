/**
 * Risk hints for file mutation previews (permission / inline diff UI).
 */

export function computeFileMutationRiskWarnings(
  originalContent: string,
  modifiedContent: string,
): string[] {
  const warnings: string[] = []
  if (originalContent.length > 0 && modifiedContent.length === 0) {
    warnings.push('此变更将删除文件中的全部内容。')
  }
  return warnings
}
