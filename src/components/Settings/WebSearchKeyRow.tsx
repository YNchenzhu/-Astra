/**
 * Compact, provider-agnostic Web Search API key configuration row.
 *
 * Used in `ToolsPanel` for Brave Search and Baidu AI Search. Any future
 * provider (Google CSE, Bing, …) can plug in by supplying a `tester`
 * function, a label, a `maskKey` helper and a doc URL — the row layout,
 * save/test/status UI, and curl-copy diagnostic stay identical.
 *
 * Design principles (set after an earlier iteration blew up into 2/3 of the
 * Settings panel):
 *   - Header + input row + optional 1-line status  = ~55px default.
 *   - Verbose help moves into `title` tooltips / doc icon.
 *   - Diagnostics collapse into a single `<details>` on error.
 */

import React, { useEffect, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Save,
} from 'lucide-react'
import { useT } from '../../i18n'

/**
 * Warning taxonomy — shared between Brave and Baidu because the local shape
 * checks cover the same three failure modes (length, prefix, charset).
 */
export type KeyShapeWarning = 'too-short' | 'wrong-prefix' | 'invalid-charset'

/** Discriminated test result mirrors the main-process *TestResult shapes. */
export type KeyTestResult =
  | {
      ok: true
      status: 200
      keyPreview: string
      message: string
      shapeWarnings?: KeyShapeWarning[]
    }
  | {
      ok: false
      status: number
      reason: string
      keyPreview: string
      message: string
      detail?: string
      shapeWarnings?: KeyShapeWarning[]
      /** Optional provider-specific secondary-probe hint (e.g. Brave). */
      secondaryHint?: string
    }

export type KeyRowTester = (candidate?: string) => Promise<KeyTestResult>

export interface WebSearchKeyRowProps {
  /** Short label — e.g. `"Brave"` / `"百度"`. */
  label: string
  /** Documentation link shown as an icon next to the label. */
  docUrl: string
  /** Current persisted key (masked in the saved-hint; raw in the input). */
  savedKey: string
  /** Setter that persists to the Settings store. */
  onSave: (key: string) => void
  /** Key tester — typically `window.electronAPI.tools.braveTestKey` etc. */
  tester: KeyRowTester
  /**
   * Build a curl command that reproduces the failing test call. Lets
   * users independently verify against the real provider from a terminal.
   */
  buildCurl: (key: string) => string
  /** Masked preview (`BSA…vBTs · 31 字符`). Must not leak the raw key. */
  maskKey: (k: string | undefined | null) => string
  /** Placeholder text for the input (format hint, e.g. `BSA…`). */
  placeholder: string
  /**
   * Hint string shown as the `title` (hover tooltip) on the input. Keeps
   * verbose help one hover away without occupying the panel.
   */
  inputTitleHint: string
  /**
   * Per-warning friendly text shown in the `<details>` panel. Defaults to
   * generic messages; providers can override for richer wording.
   */
  shapeWarningMessages?: Partial<Record<KeyShapeWarning, string>>
}

type TestState =
  | { phase: 'idle' }
  | { phase: 'testing' }
  | { phase: 'result'; result: KeyTestResult }

export const WebSearchKeyRow: React.FC<WebSearchKeyRowProps> = ({
  label,
  docUrl,
  savedKey,
  onSave,
  tester,
  buildCurl,
  maskKey,
  placeholder,
  inputTitleHint,
  shapeWarningMessages,
}) => {
  const t = useT().settings.webSearchKey
  const [draft, setDraft] = useState(savedKey)
  const [justSaved, setJustSaved] = useState(false)
  const [state, setState] = useState<TestState>({ phase: 'idle' })
  const [curlCopied, setCurlCopied] = useState(false)

  useEffect(() => {
    setDraft(savedKey)
  }, [savedKey])

  const dirty = draft !== savedKey
  const maskedSaved = maskKey(savedKey)
  const mergedMsg: Record<KeyShapeWarning, string> = {
    'too-short': t.defaultTooShort,
    'wrong-prefix': t.defaultWrongPrefix,
    'invalid-charset': t.defaultInvalidCharset,
    ...shapeWarningMessages,
  }

  const persist = (): void => {
    if (draft === savedKey) return
    onSave(draft)
    setJustSaved(true)
    setState({ phase: 'idle' })
    window.setTimeout(() => setJustSaved(false), 2200)
  }

  const runTest = async (): Promise<void> => {
    if (state.phase === 'testing') return
    setState({ phase: 'testing' })
    try {
      const candidate = draft.trim() || undefined
      const result = await tester(candidate)
      setState({ phase: 'result', result })
    } catch (e) {
      setState({
        phase: 'result',
        result: {
          ok: false,
          status: 0,
          reason: 'network',
          keyPreview: '(n/a)',
          message: e instanceof Error ? e.message : String(e),
        },
      })
    }
  }

  const copyCurl = async (): Promise<void> => {
    try {
      const k = draft.trim() || savedKey.trim()
      await navigator.clipboard.writeText(buildCurl(k))
      setCurlCopied(true)
      window.setTimeout(() => setCurlCopied(false), 2200)
    } catch {
      /* clipboard blocked — ignore */
    }
  }

  const isOk = state.phase === 'result' && state.result.ok
  const isErr = state.phase === 'result' && !state.result.ok

  return (
    <div className="tools-options-block" style={{ marginBottom: 8 }}>
      <div
        className="tools-options-label-row"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 4,
        }}
      >
        <label
          className="tools-options-label"
          style={{ margin: 0, fontSize: 13 }}
        >
          {label}
        </label>
        <a
          href={docUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={t.docTitle(label)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            opacity: 0.65,
          }}
        >
          <ExternalLink size={12} />
        </a>
      </div>

      <div className="tools-options-key-row">
        <input
          className="tools-options-input tools-options-input-grow"
          type="password"
          autoComplete="off"
          placeholder={savedKey ? t.savedPlaceholder(maskedSaved) : placeholder}
          title={inputTitleHint}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              persist()
            }
          }}
          onBlur={persist}
        />
        <button
          type="button"
          className="tools-brave-save-btn"
          disabled={!dirty}
          onClick={persist}
          title={dirty ? t.saveTitle(label) : t.saveTitleSame}
        >
          <Save size={14} />
          {t.save}
        </button>
        <button
          type="button"
          className="tools-brave-save-btn"
          disabled={
            state.phase === 'testing' || (!draft.trim() && !savedKey.trim())
          }
          onClick={() => void runTest()}
          title={t.testTitle(label)}
        >
          {state.phase === 'testing' ? (
            <Loader2 size={14} className="spinning" />
          ) : (
            <CheckCircle2 size={14} />
          )}
          {t.test}
        </button>
      </div>

      {justSaved && (
        <div
          className="tools-options-status-line"
          role="status"
          style={{ marginTop: 6, fontSize: 12, color: '#22c55e' }}
        >
          <CheckCircle2 size={12} style={{ marginRight: 4 }} />
          {t.saved}
        </div>
      )}

      {!justSaved && isOk && state.phase === 'result' && state.result.ok && (
        <div
          className="tools-options-status-line"
          role="status"
          style={{
            marginTop: 6,
            fontSize: 12,
            color: '#22c55e',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <CheckCircle2 size={12} />
          {t.keyValid(state.result.keyPreview)}
          {state.result.shapeWarnings &&
            state.result.shapeWarnings.length > 0 && (
              <span
                style={{ color: '#eab308', marginLeft: 6 }}
                title={state.result.shapeWarnings
                  .map((w) => mergedMsg[w])
                  .join('\n')}
              >
                {t.shapeHint}
              </span>
            )}
        </div>
      )}

      {!justSaved && isErr && state.phase === 'result' && !state.result.ok && (
        <div
          className="tools-options-status-line"
          role="alert"
          style={{
            marginTop: 6,
            fontSize: 12,
            color: '#ef4444',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            flexWrap: 'wrap',
          }}
        >
          <AlertCircle size={12} />
          <span>
            {state.result.status > 0
              ? `HTTP ${state.result.status}`
              : t.requestFailed}{' '}
            · {state.result.reason}
          </span>
          {state.result.secondaryHint && (
            <span style={{ color: '#eab308' }}>· {state.result.secondaryHint}</span>
          )}
          <button
            type="button"
            onClick={() => void copyCurl()}
            title={t.copyCurlTitle}
            style={{
              marginLeft: 'auto',
              background: 'transparent',
              border: '1px solid currentColor',
              color: 'inherit',
              padding: '1px 6px',
              borderRadius: 3,
              fontSize: 11,
              cursor: 'pointer',
              opacity: 0.85,
            }}
          >
            {curlCopied ? 'curl ✓' : 'curl'}
          </button>
          {(state.result.detail ||
            (state.result.shapeWarnings?.length ?? 0) > 0) && (
            <details
              style={{
                width: '100%',
                marginTop: 4,
                fontSize: 11,
                opacity: 0.85,
              }}
            >
              <summary style={{ cursor: 'pointer' }}>{t.details}</summary>
              {state.result.shapeWarnings?.map((w) => (
                <div
                  key={w}
                  style={{ color: '#eab308', marginTop: 2 }}
                >
                  ⚠ {mergedMsg[w]}
                </div>
              ))}
              <div style={{ marginTop: 4 }}>{state.result.message}</div>
              {state.result.detail && (
                <pre
                  style={{
                    whiteSpace: 'pre-wrap',
                    maxHeight: 100,
                    overflow: 'auto',
                    fontSize: 10,
                    marginTop: 4,
                  }}
                >
                  {state.result.detail}
                </pre>
              )}
            </details>
          )}
        </div>
      )}
    </div>
  )
}
