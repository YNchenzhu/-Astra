import React, { useMemo, useState } from 'react'
import { Check, Circle, CheckSquare, Square } from 'lucide-react'
import type { AskQuestionItemDisplay, AskUserQuestionRequestDisplay } from '../../types'
import { useChatStore } from '../../stores/useChatStore'
import { AskUserQuestionPreviewPane } from './AskUserQuestionPreviewPane'
import { askQuestionUsesPreviewSidebar } from './askUserQuestionPreviewLayout'
import { useT } from '../../i18n'
import './AskUserQuestionDialog.css'

/** upstream: answers and annotations are keyed by full question text (unique in batch). */
function answerKeyForQuestion(q: { header: string; question: string }): string {
  return q.question
}

/** Merge legacy header-keyed answers with upstream question-keyed maps. */
function answersKeyedByQuestion(
  base: Record<string, string>,
  questions: AskQuestionItemDisplay[],
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const q of questions) {
    const k = answerKeyForQuestion(q)
    if (base[k] !== undefined) out[k] = base[k]
    else if (base[q.header] !== undefined) out[k] = base[q.header]
  }
  return Object.keys(out).length > 0 ? out : base
}

/* ── Inline block rendered inside the message stream ── */

interface AskUserQuestionBlockProps {
  requestId: string
  questions: AskQuestionItemDisplay[]
  status: 'pending' | 'answered'
  answers?: Record<string, string>
  /** From main `TAICHU_ASK_USER_QUESTION_PREVIEW_FORMAT` — enables side preview when options carry `preview`. */
  previewFormat?: 'markdown' | 'html'
}

export const AskUserQuestionBlock: React.FC<AskUserQuestionBlockProps> = ({
  requestId,
  questions,
  status,
  answers: savedAnswers,
  previewFormat,
}) => {
  const t = useT()
  const respondToAskUserQuestion = useChatStore((s) => s.respondToAskUserQuestion)
  // Stage 4.4 — HITL durable badge.
  //
  // When this Block was triggered by the orchestration kernel's HITL pause
  // (kernel.interrupt('hitl')), the `hitlPaused` slot is populated by
  // `mainStreamRouter` and `toolUseId === requestId` (toolExec.ts uses
  // toolUseId as requestId when re-emitting the legacy ask_user_question
  // event). In that mode the kernel state has been persisted to disk; the
  // user can quit Electron and the answer will still resume the right turn.
  // We surface a tiny badge so users see the difference vs the legacy
  // in-memory promise-backed dialog.
  const hitlPaused = useChatStore((s) => s.hitlPaused)
  const clearHitlPause = useChatStore((s) => s.clearHitlPause)
  const isDurable = !!hitlPaused && hitlPaused.toolUseId === requestId

  const initialAnswers = useMemo(() => {
    if (savedAnswers && Object.keys(savedAnswers).length > 0) {
      const migrated: Record<string, string> = {}
      for (const q of questions) {
        const k = answerKeyForQuestion(q)
        if (savedAnswers[k] !== undefined) migrated[k] = savedAnswers[k]
        else if (savedAnswers[q.header] !== undefined) migrated[k] = savedAnswers[q.header]
      }
      if (Object.keys(migrated).length > 0) return migrated
    }
    const result: Record<string, string> = {}
    for (const q of questions) {
      if (q.options[0]) {
        result[answerKeyForQuestion(q)] = q.options[0].label
      }
    }
    return result
  }, [questions, savedAnswers])

  const [localAnswers, setLocalAnswers] = useState<Record<string, string>>(initialAnswers)
  // Free-form answer per question — lets the user type their own idea instead
  // of (or in addition to) picking a predefined option.
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [answerSync, setAnswerSync] = useState(() => ({ requestId, initial: initialAnswers }))

  // P1-35 / React docs note: "Adjusting state during rendering" is the
  // *recommended* pattern for reset-on-prop-change scenarios — React
  // bails out of the second render when nothing else changed, and the
  // old `useEffect` alternative violates the `react-hooks/set-state-in-effect`
  // rule for exactly the cascading-render reason React's docs warn about.
  // (See https://react.dev/reference/react/useState#storing-information-from-previous-renders.)
  // The original audit P1-35 mis-categorized this; we leave the inline
  // pattern in place and only annotate why.
  if (requestId !== answerSync.requestId || initialAnswers !== answerSync.initial) {
    setAnswerSync({ requestId, initial: initialAnswers })
    setLocalAnswers(initialAnswers)
    setCustomAnswers({})
  }

  const handleSingleSelect = (key: string, label: string) => {
    if (status === 'answered') return
    // Picking an option clears any custom text so the two don't fight.
    setCustomAnswers((prev) => (prev[key] ? { ...prev, [key]: '' } : prev))
    setLocalAnswers((prev) => ({ ...prev, [key]: label }))
  }

  const handleCustomChange = (key: string, value: string) => {
    if (status === 'answered') return
    setCustomAnswers((prev) => ({ ...prev, [key]: value }))
  }

  const handleMultiSelect = (key: string, label: string) => {
    if (status === 'answered') return
    setLocalAnswers((prev) => {
      const current = prev[key]?.split(',').map((s) => s.trim()).filter(Boolean) || []
      const exists = current.includes(label)
      const next = exists ? current.filter((item) => item !== label) : [...current, label]
      return { ...prev, [key]: next.join(', ') }
    })
  }

  const submit = async () => {
    setSubmitting(true)
    // Merge free-form text into the answer: for single-select a non-empty
    // custom value wins; for multi-select it's appended to the picked options.
    const finalAnswers: Record<string, string> = {}
    for (const q of questions) {
      const k = answerKeyForQuestion(q)
      const custom = (customAnswers[k] || '').trim()
      if (q.multiSelect) {
        const picked = (localAnswers[k] || '').split(',').map((s) => s.trim()).filter(Boolean)
        if (custom) picked.push(custom)
        finalAnswers[k] = picked.join(', ')
      } else {
        finalAnswers[k] = custom || localAnswers[k] || ''
      }
    }
    await respondToAskUserQuestion({ requestId, answers: finalAnswers })
    // Stage 4.4 — clear the HITL pause slot after submit so the badge
    // disappears and a future kernel pause re-populates it cleanly.
    if (isDurable) clearHitlPause()
    setSubmitting(false)
  }

  const isAnswered = status === 'answered'
  const displayAnswers = isAnswered
    ? answersKeyedByQuestion(savedAnswers || localAnswers, questions)
    : localAnswers

  const renderQuestion = (q: AskQuestionItemDisplay, qIdx: number) => {
    const qKey = answerKeyForQuestion(q)
    const selected = displayAnswers[qKey] || ''
    const selectedList = selected.split(',').map((s) => s.trim()).filter(Boolean)
    const split =
      previewFormat !== undefined && askQuestionUsesPreviewSidebar(q, previewFormat)

    if (isAnswered) {
      if (split) {
        const chosen = q.options.find((o) => o.label === selected)
        return (
          <div key={qKey} className="ask-q">
            {qIdx > 0 && <div className="ask-q-divider" />}
            <div className="ask-q-prompt">{q.question}</div>
            <div className="ask-q-split ask-q-split--answered">
              <div className="ask-q-options-col">
                {chosen || selected ? (
                  <div className="ask-pill chosen">
                    <Check size={12} className="ask-pill-check" />
                    <span className="ask-pill-label">{chosen ? chosen.label : selected}</span>
                  </div>
                ) : null}
              </div>
              <div className="ask-q-preview-col">
                <AskUserQuestionPreviewPane format={previewFormat} previewText={chosen?.preview ?? ''} />
              </div>
            </div>
          </div>
        )
      }

      const optionLabels = new Set(q.options.map((o) => o.label))
      const customChosen = (q.multiSelect ? selectedList : selected ? [selected] : []).filter(
        (val) => !optionLabels.has(val),
      )
      return (
        <div key={qKey} className="ask-q">
          {qIdx > 0 && <div className="ask-q-divider" />}
          <div className="ask-q-prompt">{q.question}</div>
          <div className={`ask-q-options ${isAnswered ? 'answered' : 'pending'}`}>
            {q.options.map((opt) => {
              const isActive = q.multiSelect
                ? selectedList.includes(opt.label)
                : selected === opt.label
              if (!isActive) return null
              return (
                <div key={opt.label} className={`ask-pill ${isActive ? 'chosen' : 'dimmed'}`}>
                  {isActive && <Check size={12} className="ask-pill-check" />}
                  <span className="ask-pill-label">{opt.label}</span>
                </div>
              )
            })}
            {customChosen.map((val) => (
              <div key={`custom-${val}`} className="ask-pill chosen">
                <Check size={12} className="ask-pill-check" />
                <span className="ask-pill-label">{val}</span>
              </div>
            ))}
          </div>
        </div>
      )
    }

    if (split && previewFormat) {
      const selectedOpt = q.options.find((o) => o.label === selected) ?? q.options[0]
      return (
        <div key={qKey} className="ask-q">
          {qIdx > 0 && <div className="ask-q-divider" />}
          <div className="ask-q-prompt">{q.question}</div>
          <div className="ask-q-split">
            <div className="ask-q-options-col ask-q-options-col--sidebar">
              {q.options.map((opt) => {
                const isActive = !(customAnswers[qKey] || '').trim() && selected === opt.label
                return (
                  <button
                    type="button"
                    key={opt.label}
                    className={`ask-pill ask-pill--sidebar ${isActive ? 'active' : ''}`}
                    onClick={() => handleSingleSelect(qKey, opt.label)}
                    title={opt.description}
                  >
                    <span className="ask-pill-indicator">
                      {isActive ? <span className="ask-radio filled" /> : <Circle size={13} />}
                    </span>
                    <span className="ask-pill-content">
                      <span className="ask-pill-label">{opt.label}</span>
                      {opt.description ? (
                        <span className="ask-pill-desc">{opt.description}</span>
                      ) : null}
                    </span>
                  </button>
                )
              })}
              <input
                type="text"
                className={`ask-q-custom ${(customAnswers[qKey] || '').trim() ? 'filled' : ''}`}
                value={customAnswers[qKey] || ''}
                placeholder={t.askQuestion.customPlaceholder}
                onChange={(e) => handleCustomChange(qKey, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    if (!submitting) void submit()
                  }
                }}
              />
            </div>
            <div className="ask-q-preview-col">
              <div className="ask-preview-col-header">{t.askQuestion.preview}</div>
              <AskUserQuestionPreviewPane
                format={previewFormat}
                previewText={selectedOpt?.preview ?? ''}
              />
            </div>
          </div>
        </div>
      )
    }

    const customValue = customAnswers[qKey] || ''
    const hasCustom = customValue.trim().length > 0
    return (
      <div key={qKey} className="ask-q">
        {qIdx > 0 && <div className="ask-q-divider" />}
        <div className="ask-q-prompt">{q.question}</div>
        <div className={`ask-q-options ${isAnswered ? 'answered' : 'pending'}`}>
          {q.options.map((opt) => {
            const isActive = q.multiSelect
              ? selectedList.includes(opt.label)
              : !hasCustom && selected === opt.label

            return (
              <button
                type="button"
                key={opt.label}
                className={`ask-pill ${isActive ? 'active' : ''}`}
                onClick={() =>
                  q.multiSelect ? handleMultiSelect(qKey, opt.label) : handleSingleSelect(qKey, opt.label)
                }
                title={opt.description}
              >
                <span className="ask-pill-indicator">
                  {q.multiSelect
                    ? (isActive ? <CheckSquare size={13} /> : <Square size={13} />)
                    : (isActive ? <span className="ask-radio filled" /> : <Circle size={13} />)}
                </span>
                <span className="ask-pill-content">
                  <span className="ask-pill-label">{opt.label}</span>
                  {opt.description ? <span className="ask-pill-desc">{opt.description}</span> : null}
                </span>
              </button>
            )
          })}
        </div>
        <input
          type="text"
          className={`ask-q-custom ${hasCustom ? 'filled' : ''}`}
          value={customValue}
          placeholder={q.multiSelect ? t.askQuestion.multiCustomPlaceholder : t.askQuestion.customPlaceholder}
          onChange={(e) => handleCustomChange(qKey, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              if (!submitting) void submit()
            }
          }}
        />
      </div>
    )
  }

  const questionsBody = questions.map((q, i) => renderQuestion(q, i))

  return (
    <div className={`ask-block ${isAnswered ? 'answered' : 'pending'}`}>
      {isDurable && !isAnswered && (
        <div
          className="ask-block-hitl-badge"
          title={t.askQuestion.durableTitle}
        >
          <span className="ask-block-hitl-dot" />
          {t.askQuestion.durableBadge}
        </div>
      )}
      {isAnswered ? (
        questionsBody
      ) : (
        <div className="ask-block-scroll">{questionsBody}</div>
      )}

      {!isAnswered && (
        <div className="ask-block-footer">
          <button className="ask-submit" onClick={submit} disabled={submitting}>
            {submitting ? t.askQuestion.submitting : t.askQuestion.submit}
          </button>
        </div>
      )}
    </div>
  )
}

/* ── Legacy bottom-fixed dialog (kept for backward compat / fallback) ── */

interface AskUserQuestionDialogProps {
  request: AskUserQuestionRequestDisplay
  onSubmit: (params: {
    requestId: string
    answers: Record<string, string>
    annotations?: Record<string, { preview?: string; notes?: string }>
  }) => Promise<void>
}

export const AskUserQuestionDialog: React.FC<AskUserQuestionDialogProps> = ({ request, onSubmit }) => {
  const t = useT()
  const initialAnswers = useMemo(() => {
    const result: Record<string, string> = {}
    for (const q of request.questions) {
      if (q.options[0]) {
        result[answerKeyForQuestion(q)] = q.options[0].label
      }
    }
    return result
  }, [request.questions])

  const [answers, setAnswers] = useState<Record<string, string>>(initialAnswers)
  const [answerSync, setAnswerSync] = useState(() => ({
    requestId: request.requestId,
    initial: initialAnswers,
  }))

  if (request.requestId !== answerSync.requestId || initialAnswers !== answerSync.initial) {
    setAnswerSync({ requestId: request.requestId, initial: initialAnswers })
    setAnswers(initialAnswers)
  }

  const handleSingleSelect = (key: string, label: string) => {
    setAnswers((prev) => ({ ...prev, [key]: label }))
  }

  const handleMultiSelect = (key: string, label: string) => {
    setAnswers((prev) => {
      const current = prev[key]?.split(',').map((s) => s.trim()).filter(Boolean) || []
      const exists = current.includes(label)
      const next = exists ? current.filter((item) => item !== label) : [...current, label]
      return { ...prev, [key]: next.join(', ') }
    })
  }

  const submit = async () => {
    await onSubmit({ requestId: request.requestId, answers })
  }

  const previewFormat = request.previewFormat

  const renderDialogQuestion = (q: AskQuestionItemDisplay) => {
    const qKey = answerKeyForQuestion(q)
    const selected = answers[qKey] || ''
    const selectedList = selected.split(',').map((s) => s.trim()).filter(Boolean)
    const split =
      previewFormat !== undefined && askQuestionUsesPreviewSidebar(q, previewFormat)

    if (split && previewFormat) {
      const selectedOpt = q.options.find((o) => o.label === selected) ?? q.options[0]
      return (
        <div key={qKey} className="ask-question-block ask-question-block--split">
          <div className="ask-question-header">{q.header}</div>
          <p className="ask-question-text">{q.question}</p>
          <div className="ask-q-split ask-q-split--dialog">
            <div className="ask-q-options-col ask-q-options-col--sidebar">
              {q.options.map((opt) => {
                const isActive = selected === opt.label
                return (
                  <button
                    type="button"
                    key={opt.label}
                    className={`ask-option ask-option--sidebar ${isActive ? 'active' : ''}`}
                    onClick={() => handleSingleSelect(qKey, opt.label)}
                  >
                    <span className="ask-option-label">{opt.label}</span>
                    <span className="ask-option-desc">{opt.description}</span>
                  </button>
                )
              })}
            </div>
            <div className="ask-q-preview-col">
              <div className="ask-preview-col-header">{t.askQuestion.preview}</div>
              <AskUserQuestionPreviewPane
                format={previewFormat}
                previewText={selectedOpt?.preview ?? ''}
              />
            </div>
          </div>
        </div>
      )
    }

    return (
      <div key={qKey} className="ask-question-block">
        <div className="ask-question-header">{q.header}</div>
        <p className="ask-question-text">{q.question}</p>
        <div className="ask-options">
          {q.options.map((opt) => {
            const isActive = q.multiSelect ? selectedList.includes(opt.label) : selected === opt.label
            return (
              <button
                type="button"
                key={opt.label}
                className={`ask-option ${isActive ? 'active' : ''}`}
                onClick={() =>
                  q.multiSelect ? handleMultiSelect(qKey, opt.label) : handleSingleSelect(qKey, opt.label)
                }
              >
                <span className="ask-option-label">{opt.label}</span>
                <span className="ask-option-desc">{opt.description}</span>
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="ask-dialog-card">
      <div className="ask-dialog-header">
        <span className="ask-dialog-title">{t.askQuestion.dialogTitle}</span>
      </div>
      <div className="ask-dialog-body">
        {request.questions.map((q) => renderDialogQuestion(q))}
      </div>
      <div className="ask-dialog-actions">
        <button type="button" className="ask-submit-btn" onClick={submit}>
          {t.askQuestion.submit}
        </button>
      </div>
    </div>
  )
}
