export function toolMatchesName(tool: { name: string; aliases?: string[] }, name: string): boolean {
  const n = name.trim()
  if (!n) return false
  if (tool.name === n) return true
  if (tool.name.toLowerCase() === n.toLowerCase()) return true
  if (tool.aliases?.some((a) => a.toLowerCase() === n.toLowerCase())) return true
  const stem = tool.name.replace(/_/g, '').toLowerCase()
  const q = n.replace(/_/g, '').toLowerCase()
  if (stem.length > 0 && stem === q) return true
  return false
}
