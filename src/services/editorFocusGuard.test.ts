/**
 * Tests for the Monaco focus-theft guard.
 *
 * Regression: when the AI applied a file edit while the user was typing
 * into the Settings → Rules panel, the inline-diff controller + editor
 * area both programmatically re-focused Monaco on the next animation
 * frame. The user's keystrokes then landed in the edited file instead
 * of the Rules panel textarea. These tests pin the conservative policy
 * so future refactors don't silently re-introduce the yank.
 *
 * The guard is purely structural (it reads activeElement.tagName /
 * isContentEditable and walks a `.contains()` chain), so we don't need a
 * real DOM. We install a minimal `document` stub with a swappable
 * activeElement, and pass in lightweight fake elements.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  isUserTypingElsewhere,
  focusEditorIfIdle,
  noteChatInputActivity,
  __resetChatInputActivityForTests,
  type MonacoLikeEditor,
} from './editorFocusGuard'

/** Fake HTMLElement-ish object. Only fields the guard actually reads. */
interface FakeEl {
  tagName: string
  isContentEditable: boolean
  /** Subtree membership: returns true iff `other === this` OR listed in `_children`. */
  contains(other: unknown): boolean
  _children?: FakeEl[]
}

function el(
  tagName: string,
  opts: { contentEditable?: boolean; children?: FakeEl[] } = {},
): FakeEl {
  const node: FakeEl = {
    tagName,
    isContentEditable: !!opts.contentEditable,
    _children: opts.children,
    contains(other: unknown) {
      if (other === node) return true
      if (!node._children) return false
      for (const child of node._children) {
        if (child === other) return true
        if (child.contains && child.contains(other)) return true
      }
      return false
    },
  }
  return node
}

function setActive(active: FakeEl | null): void {
  ;(globalThis as unknown as { document: { activeElement: FakeEl | null; body: FakeEl } }).document = {
    activeElement: active,
    body: el('BODY'),
  }
}

function clearDocument(): void {
  delete (globalThis as { document?: unknown }).document
}

beforeEach(() => {
  // Start each test with body-equivalent focus (no input).
  setActive(null)
  // Recency timestamp is module-scoped — clear it so chat activity from a
  // prior test can't leak into the next one's <body> idle assertions.
  __resetChatInputActivityForTests()
})
afterEach(() => {
  clearDocument()
  vi.useRealTimers()
})

describe('isUserTypingElsewhere', () => {
  it('allows focus when nothing is focused', () => {
    setActive(null)
    const editorDom = el('DIV') as unknown as HTMLElement
    expect(isUserTypingElsewhere(editorDom)).toBe(false)
  })

  it('allows focus when activeElement is the body itself', () => {
    const body = el('BODY')
    ;(globalThis as unknown as { document: { activeElement: FakeEl; body: FakeEl } }).document = {
      activeElement: body,
      body,
    }
    const editorDom = el('DIV') as unknown as HTMLElement
    expect(isUserTypingElsewhere(editorDom)).toBe(false)
  })

  it('allows focus when activeElement is inside the target editor subtree', () => {
    const innerTextarea = el('TEXTAREA')
    const editorDom = el('DIV', { children: [innerTextarea] })
    setActive(innerTextarea)
    expect(isUserTypingElsewhere(editorDom as unknown as HTMLElement)).toBe(false)
  })

  it('blocks focus when activeElement is an <input> outside the editor', () => {
    const input = el('INPUT')
    const editorDom = el('DIV')
    setActive(input)
    expect(isUserTypingElsewhere(editorDom as unknown as HTMLElement)).toBe(true)
  })

  it('blocks focus when activeElement is a <textarea> outside the editor', () => {
    const ta = el('TEXTAREA')
    const editorDom = el('DIV')
    setActive(ta)
    expect(isUserTypingElsewhere(editorDom as unknown as HTMLElement)).toBe(true)
  })

  it('blocks focus when activeElement is a <select> outside the editor', () => {
    const sel = el('SELECT')
    const editorDom = el('DIV')
    setActive(sel)
    expect(isUserTypingElsewhere(editorDom as unknown as HTMLElement)).toBe(true)
  })

  it('blocks focus when activeElement is contenteditable outside the editor', () => {
    const ce = el('DIV', { contentEditable: true })
    const editorDom = el('DIV')
    setActive(ce)
    expect(isUserTypingElsewhere(editorDom as unknown as HTMLElement)).toBe(true)
  })

  it('allows focus when a non-input interactive element (button) has focus', () => {
    const btn = el('BUTTON')
    const editorDom = el('DIV')
    setActive(btn)
    expect(isUserTypingElsewhere(editorDom as unknown as HTMLElement)).toBe(false)
  })

  it('allows focus when editorDom is null/undefined but user is NOT in a text input', () => {
    const btn = el('BUTTON')
    setActive(btn)
    expect(isUserTypingElsewhere(null)).toBe(false)
    expect(isUserTypingElsewhere(undefined)).toBe(false)
  })

  it('blocks focus when editorDom is null but user IS in a text input elsewhere', () => {
    // This case models: editor not mounted yet, AI pending-change fires
    // a focus call, user is typing in the Rules panel. The guard should
    // still refuse — the fact that we don't know the editor DOM doesn't
    // make stealing keystrokes any less disruptive.
    const input = el('INPUT')
    setActive(input)
    expect(isUserTypingElsewhere(null)).toBe(true)
    expect(isUserTypingElsewhere(undefined)).toBe(true)
  })

  it('is case-insensitive on tag name normalization', () => {
    const lowercaseInput = el('input') // lowercase — unusual but possible
    setActive(lowercaseInput)
    const editorDom = el('DIV')
    expect(isUserTypingElsewhere(editorDom as unknown as HTMLElement)).toBe(true)
  })

  it('returns false when `document` is undefined (SSR-like environment)', () => {
    clearDocument()
    const editorDom = el('DIV')
    expect(isUserTypingElsewhere(editorDom as unknown as HTMLElement)).toBe(false)
  })

  it('blocks focus right after a chat keystroke even when activeElement fell back to <body>', () => {
    // The real-world race: a streamed sub-agent finished rendering, focus
    // momentarily dropped to <body>, but the user was just typing in chat.
    const body = el('BODY')
    ;(globalThis as unknown as { document: { activeElement: FakeEl; body: FakeEl } }).document = {
      activeElement: body,
      body,
    }
    noteChatInputActivity()
    const editorDom = el('DIV') as unknown as HTMLElement
    expect(isUserTypingElsewhere(editorDom)).toBe(true)
  })

  it('allows focus once the chat keystroke recency window has elapsed', () => {
    vi.useFakeTimers()
    const body = el('BODY')
    ;(globalThis as unknown as { document: { activeElement: FakeEl; body: FakeEl } }).document = {
      activeElement: body,
      body,
    }
    noteChatInputActivity()
    vi.advanceTimersByTime(1000) // > CHAT_INPUT_RECENCY_MS (700)
    const editorDom = el('DIV') as unknown as HTMLElement
    expect(isUserTypingElsewhere(editorDom)).toBe(false)
  })
})

describe('focusEditorIfIdle', () => {
  function makeEditor(
    dom: FakeEl | null,
  ): MonacoLikeEditor & { focus: ReturnType<typeof vi.fn> } {
    const focus = vi.fn()
    return {
      focus,
      getDomNode: () => dom as unknown as HTMLElement,
    }
  }

  it('calls editor.focus when the document is idle', () => {
    const editorDom = el('DIV')
    const editor = makeEditor(editorDom)
    setActive(null)
    expect(focusEditorIfIdle(editor)).toBe(true)
    expect(editor.focus).toHaveBeenCalledTimes(1)
  })

  it('skips editor.focus when the user is typing in another input', () => {
    const editorDom = el('DIV')
    const editor = makeEditor(editorDom)
    const input = el('INPUT')
    setActive(input)
    expect(focusEditorIfIdle(editor)).toBe(false)
    expect(editor.focus).not.toHaveBeenCalled()
  })

  it('still calls editor.focus when the editor already owns focus (no-op in practice)', () => {
    const inner = el('TEXTAREA')
    const editorDom = el('DIV', { children: [inner] })
    const editor = makeEditor(editorDom)
    setActive(inner)
    expect(focusEditorIfIdle(editor)).toBe(true)
    expect(editor.focus).toHaveBeenCalledTimes(1)
  })

  it('skips when the user is typing in a contentEditable (e.g. Rules preset editor)', () => {
    const editorDom = el('DIV')
    const editor = makeEditor(editorDom)
    setActive(el('DIV', { contentEditable: true }))
    expect(focusEditorIfIdle(editor)).toBe(false)
    expect(editor.focus).not.toHaveBeenCalled()
  })

  it('returns false for a null / invalid editor reference', () => {
    expect(focusEditorIfIdle(null)).toBe(false)
    expect(focusEditorIfIdle(undefined)).toBe(false)
    expect(focusEditorIfIdle({} as unknown as MonacoLikeEditor)).toBe(false)
  })

  it('swallows errors from a disposed editor and returns false', () => {
    const editorDom = el('DIV')
    const editor: MonacoLikeEditor = {
      focus: () => {
        throw new Error('editor disposed')
      },
      getDomNode: () => editorDom as unknown as HTMLElement,
    }
    expect(focusEditorIfIdle(editor)).toBe(false)
  })
})
