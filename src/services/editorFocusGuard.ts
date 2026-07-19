/**
 * Focus-theft guard for the Monaco editor surface.
 *
 * Context: several legitimate code paths want to programmatically pull
 * focus back to the editor — e.g. after a tab switch, after the AI accepts
 * / rejects a pending diff, or when the InlineDiffDecorator has just
 * attached to a new hunk. When those paths fire while the user is in the
 * middle of typing into an unrelated input (Settings → Rules panel, chat
 * composer, command palette, inline-edit prompt, …) the programmatic
 * `editor.focus()` yanks the caret to Monaco and subsequent keystrokes
 * land in the wrong field.
 *
 * The guard is intentionally conservative:
 *   - If the DOM doesn't exist (SSR / tests without jsdom) → allow focus.
 *   - If no element is focused (activeElement is body or null) → allow.
 *   - If the currently-focused element lives INSIDE the target editor's
 *     DOM subtree → allow (effectively a no-op, Monaco already owns focus).
 *   - If the currently-focused element is an interactive text input
 *     (input / textarea / select / contenteditable) anywhere else in the
 *     document → block. That's the user typing into a different surface
 *     and we must not steal from them.
 *   - Any other focused element (button, div with tabIndex, menu item,
 *     anchor, …) is NOT collecting keystrokes, so stealing to the editor
 *     is safe and preserves the prior UX.
 *
 * The helper is a tiny static module so unit tests can import it directly
 * without spinning up React or Monaco. All Monaco interaction goes
 * through the narrow `MonacoLikeEditor` surface below so we can mock it.
 */

/** Minimal Monaco API surface we rely on. Kept structural for testability. */
export interface MonacoLikeEditor {
  focus(): void
  getDomNode(): HTMLElement | null
}

/**
 * Timestamp (epoch ms) of the user's most recent keystroke into the chat
 * composer. The composer calls {@link noteChatInputActivity} on every
 * change so the guard can recognise "the user is actively typing in chat"
 * even in the brief window where `document.activeElement` has transiently
 * fallen back to `<body>` (IME commit, async re-render after a streamed
 * sub-agent finished, …) — which is exactly when the editor used to steal
 * focus and strand the caret for ~20s.
 *
 * This replaces a long-dead branch that queried `.chat-input-textarea`
 * (the composer textarea is actually `.chat-input`) and gated on
 * `value.length > 0` — a heuristic that, even with the right selector,
 * would have blocked the editor from EVER regaining focus while a draft
 * sat in the box. A short recency window matches the original documented
 * intent ("input within the last 500ms") without that footgun.
 */
let lastChatInputAt = 0
const CHAT_INPUT_RECENCY_MS = 700

/** Record that the user just interacted with the chat composer. */
export function noteChatInputActivity(): void {
  lastChatInputAt = Date.now()
}

/** @internal test-only helper to reset the recency timestamp. */
export function __resetChatInputActivityForTests(): void {
  lastChatInputAt = 0
}

function isChatComposerActivelyEdited(): boolean {
  return lastChatInputAt > 0 && Date.now() - lastChatInputAt < CHAT_INPUT_RECENCY_MS
}

/**
 * Return true when calling `editor.focus()` right now would steal focus
 * from a text-input surface the user is actively typing into.
 *
 * @param editorDom DOM root of the Monaco instance we're about to focus.
 *                  When `null`/undefined we treat the call as safe — Monaco
 *                  isn't mounted yet, so no user keystrokes can be routed
 *                  into it either way.
 */
export function isUserTypingElsewhere(
  editorDom: HTMLElement | null | undefined,
): boolean {
  if (typeof document === 'undefined') return false

  // Checked BEFORE the body/null early-out below: right after a chat
  // keystroke the active element can momentarily read as `<body>`, yet the
  // user is plainly still typing into chat. Honouring the recency window
  // first is what actually plugs the "focus yanked away after a streamed
  // block rendered" race.
  if (isChatComposerActivelyEdited()) return true

  const active = document.activeElement as HTMLElement | null
  if (!active || active === document.body) return false

  // Monaco's own hidden textarea lives inside the editor DOM subtree. If
  // activeElement is there, the editor already owns focus — re-focusing
  // is harmless, and we must not classify it as "typing elsewhere".
  if (editorDom && typeof editorDom.contains === 'function' && editorDom.contains(active)) {
    return false
  }

  const tag = (active.tagName || '').toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    // <input type="button|checkbox|radio|submit|reset"> doesn't collect
    // keystrokes in the same way — but treat them as "don't steal" anyway
    // because clicking a button shouldn't result in focus yanked away.
    return true
  }
  if (active.isContentEditable) return true

  return false
}

/**
 * Focus the editor only when it is safe to do so per {@link isUserTypingElsewhere}.
 * A no-op when the editor is missing, detached, or when another input-like
 * element currently owns focus.
 *
 * @returns `true` when focus was actually transferred, `false` when the call
 *          was suppressed. Callers can use this to log or fall back (most
 *          don't need to — the operation is best-effort).
 */
export function focusEditorIfIdle(
  editor: MonacoLikeEditor | null | undefined,
): boolean {
  if (!editor || typeof editor.focus !== 'function') return false
  const dom = typeof editor.getDomNode === 'function' ? editor.getDomNode() : null
  if (isUserTypingElsewhere(dom)) return false
  try {
    editor.focus()
  } catch {
    // Defensive: a disposed editor can throw inside `focus()`. Swallow —
    // the caller's intent was "focus if possible", not "focus or die".
    return false
  }
  return true
}
