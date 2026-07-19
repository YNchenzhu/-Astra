export function formatContextTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k`
  return String(Math.round(tokens))
}
