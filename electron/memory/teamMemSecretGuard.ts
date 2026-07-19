/**
 * Secret guard for team-memory writes.
 *
 * Team memory is shared with collaborators (git, network mount, manual share).
 * An AI agent or the user could inadvertently store an API key inside a
 * project memory file ("the staging key is sk-…"), and on the next
 * TeamMemorySync run it would propagate to every contributor. This module
 * scans the content before that propagation happens.
 *
 * Scope choices (intentionally narrow):
 *   - Match well-known credential prefixes (specific service formats), not
 *     generic high-entropy strings. False positives that block legitimate
 *     memories are worse than the rare miss — the threat model is accidental
 *     leakage of recognisable production keys, not adversarial smuggling.
 *   - Pattern list mirrors upstream-main `teamMemSecretGuard` plus a few
 *     common formats we use locally.
 */

interface SecretPattern {
  /** Short human-readable label surfaced in the rejection message. */
  label: string
  /** Anchored to either word boundaries or unambiguous prefixes. */
  pattern: RegExp
}

/**
 * Conservative pattern list — every entry must encode a recognisable
 * service-specific prefix so noise in unrelated docs (long base64,
 * hex hashes) does NOT match.
 */
const SECRET_PATTERNS: readonly SecretPattern[] = [
  // Anthropic — covers sk-ant-api03-…, sk-ant-admin01-…, plus future variants
  { label: 'Anthropic API key', pattern: /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{20,}\b/g },
  // OpenAI — covers sk-…, sk-proj-…
  // Negative lookahead excludes Anthropic keys (`sk-ant-…`), which would
  // otherwise double-match against this generic-looking pattern and show
  // up under both labels in the rejection message.
  { label: 'OpenAI API key', pattern: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{32,}\b/g },
  // AWS access key ID (also implies a paired secret nearby; flagging the ID is enough)
  { label: 'AWS access key ID', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  // Google API key
  { label: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // GitHub personal access / OAuth tokens — gh[p|o|u|s|r]_…
  { label: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  // Slack tokens — xoxb-, xoxa-, xoxp-, xoxr-, xoxs-, xoxe-
  { label: 'Slack token', pattern: /\bxox[baprse]-[0-9A-Za-z-]{10,}\b/g },
  // Stripe live secret keys (skip test keys: sk_test_ is intentionally NOT matched)
  { label: 'Stripe live key', pattern: /\bsk_live_[A-Za-z0-9]{20,}\b/g },
  // PEM private key blocks — header alone is sufficient evidence
  {
    label: 'PEM private key',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
  },
]

/**
 * Scan content for known credential patterns. Returns a deduped, sorted
 * list of labels for each pattern that matched at least once. Empty
 * array means the content is clean.
 *
 * Stateless — safe to call repeatedly from sync paths.
 */
export function scanForSecrets(content: string): string[] {
  if (!content) return []
  const found = new Set<string>()
  for (const { label, pattern } of SECRET_PATTERNS) {
    // Use a fresh lastIndex by relying on `.test()` semantics: each call to
    // `test()` on a `/g` regex advances state. We don't reuse the test across
    // patterns, so create a one-shot copy to avoid cross-call state leaks.
    const re = new RegExp(pattern.source, pattern.flags)
    if (re.test(content)) found.add(label)
  }
  return [...found].sort()
}

/**
 * Decide whether team-memory content should be rejected.
 *
 * Returns:
 *   - `null` when content is clean (caller proceeds with write/copy).
 *   - A user-facing error string when one or more secret patterns matched.
 *     The string lists the matched categories so the user can locate the
 *     offending lines without us logging the actual secret value.
 */
export function checkTeamMemSecrets(content: string): string | null {
  const labels = scanForSecrets(content)
  if (labels.length === 0) return null
  return (
    `Content contains potential secrets (${labels.join(', ')}) and cannot be ` +
    `written to team memory. Move the secret to a local-only memory file ` +
    `(scope: user or session), or remove it from the content.`
  )
}
