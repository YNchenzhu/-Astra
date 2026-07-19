import { describe, expect, it } from 'vitest'
import { buildMainSystemPromptLayersFromOrchestration } from './orchestrationContext'
import {
  workspaceFingerprintForPrompt,
  ANTI_ACTION_HALLUCINATION_MARKER,
  PERSISTENCE_MARKER,
  COMPLETION_EVIDENCE_PROMPT_MARKER,
} from './systemPrompt'

describe('buildMainSystemPromptLayersFromOrchestration (§7 custom system)', () => {
  it('prepends attribution to custom systemContext', () => {
    const cwd = '/proj/custom'
    const L = buildMainSystemPromptLayersFromOrchestration({
      workspacePath: cwd,
      cwd,
      platform: 'linux',
      outputStyle: 'default',
      language: '',
      memoryContext: '',
      sessionContext: '',
      passiveLspDiagnostics: '',
      customSystemPrompt: 'CUSTOM_CORE_ONLY',
      userRulesPrompt: undefined,
    })
    const fp = workspaceFingerprintForPrompt(cwd)
    // Stage 3·1: attribution is plain prose, not wrapped in <system-reminder>
    // (that tag is reserved for runtime nudges; wrapping foundational
    // identity in it diluted the tag's semantics). The systemContext now
    // starts with the plain "Host: …" header line.
    expect(L.systemContext.startsWith('Host: 星构Astra')).toBe(true)
    expect(L.systemContext).toContain(`workspace_fp=${fp}`)
    expect(L.systemContext).toContain('prompt_layers=v1')
    expect(L.systemContext).toContain('CUSTOM_CORE_ONLY')
  })

  // Regression: bundle / workpack switch must keep the
  // anti-action-hallucination guardrail. Custom-system path used to
  // short-circuit the default 星构Astra prompt entirely, so any user
  // who picked a custom-bundle primary agent lost the guardrail and
  // started seeing "我已经修改了 X" hallucinations again.
  it('appends anti-action-hallucination block to a custom bundle prompt (workpack path)', () => {
    const L = buildMainSystemPromptLayersFromOrchestration({
      workspacePath: '/proj/x',
      cwd: '/proj/x',
      platform: 'linux',
      outputStyle: 'default',
      language: '',
      memoryContext: '',
      sessionContext: '',
      passiveLspDiagnostics: '',
      customSystemPrompt: '你是一名售前工程师，请用中文回答。',
      userRulesPrompt: undefined,
    })
    expect(L.systemContext).toContain('你是一名售前工程师')
    expect(L.systemContext).toContain(ANTI_ACTION_HALLUCINATION_MARKER)
    // Bundle prompt comes first (defines persona / domain rules), the
    // guardrail at the tail so it is the LAST instruction read before
    // the user turn — recency effect favours rule adherence.
    const personaIdx = L.systemContext.indexOf('你是一名售前工程师')
    const guardIdx = L.systemContext.indexOf(ANTI_ACTION_HALLUCINATION_MARKER)
    expect(personaIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeGreaterThan(personaIdx)
  })

  it('does NOT double-inject when the custom prompt already inlines the guardrail', () => {
    const customWithGuard = `Bundle preamble.\n\n${ANTI_ACTION_HALLUCINATION_MARKER}\nInline phrasing.`
    const L = buildMainSystemPromptLayersFromOrchestration({
      workspacePath: '/proj/x',
      cwd: '/proj/x',
      platform: 'linux',
      outputStyle: 'default',
      language: '',
      memoryContext: '',
      sessionContext: '',
      passiveLspDiagnostics: '',
      customSystemPrompt: customWithGuard,
      userRulesPrompt: undefined,
    })
    const occurrences = L.systemContext.split(ANTI_ACTION_HALLUCINATION_MARKER).length - 1
    expect(occurrences).toBe(1)
  })

  // Audit fix R1-H2 regression — `HOST_RUNTIME_CONTRACT_MARKER_SYSTEM`
  // used to be the literal string `'# System'`. A bundle prompt with a
  // `# System Architecture` heading (or any other `# System ...`
  // heading) used to false-match and suppress the entire host runtime
  // contract block. With the fix, only the unique recall-section header
  // gates the dedup, so the bundle below MUST still receive the host
  // contract injection.
  it('does NOT suppress host contract when bundle has unrelated "# System ..." heading', () => {
    const bundle = `# System Architecture\nThis project uses microservices…\n\nMore prose.`
    const L = buildMainSystemPromptLayersFromOrchestration({
      workspacePath: '/proj/x',
      cwd: '/proj/x',
      platform: 'linux',
      outputStyle: 'default',
      language: '',
      memoryContext: '',
      sessionContext: '',
      passiveLspDiagnostics: '',
      customSystemPrompt: bundle,
      userRulesPrompt: undefined,
    })
    expect(L.systemContext).toContain('## How to recall what already happened in this session')
    // And the bundle text itself survives.
    expect(L.systemContext).toContain('# System Architecture')
  })

  it('does dedup the host contract when the bundle inlines the recall section', () => {
    const recallHeader = '## How to recall what already happened in this session'
    const bundleWithRecall = `Custom persona.\n\n${recallHeader}\nInline phrasing of recall ladder.`
    const L = buildMainSystemPromptLayersFromOrchestration({
      workspacePath: '/proj/x',
      cwd: '/proj/x',
      platform: 'linux',
      outputStyle: 'default',
      language: '',
      memoryContext: '',
      sessionContext: '',
      passiveLspDiagnostics: '',
      customSystemPrompt: bundleWithRecall,
      userRulesPrompt: undefined,
    })
    const count = L.systemContext.split(recallHeader).length - 1
    expect(count).toBe(1)
  })

  // 2026-07 quality uplift regression — the persistence / thoroughness
  // floor must survive a workpack switch exactly like the two floors
  // above; without it every custom bundle silently regressed to shallow
  // "went through the motions" execution.
  it('appends the persistence/thoroughness floor to a custom bundle prompt (workpack path)', () => {
    const L = buildMainSystemPromptLayersFromOrchestration({
      workspacePath: '/proj/x',
      cwd: '/proj/x',
      platform: 'linux',
      outputStyle: 'default',
      language: '',
      memoryContext: '',
      sessionContext: '',
      passiveLspDiagnostics: '',
      customSystemPrompt: '你是一名售前工程师，请用中文回答。',
      userRulesPrompt: undefined,
    })
    expect(L.systemContext).toContain(PERSISTENCE_MARKER)
  })

  it('does NOT double-inject the persistence floor when the bundle already inlines it', () => {
    const customWithFloor = `Bundle preamble.\n\n${PERSISTENCE_MARKER}\nInline phrasing.`
    const L = buildMainSystemPromptLayersFromOrchestration({
      workspacePath: '/proj/x',
      cwd: '/proj/x',
      platform: 'linux',
      outputStyle: 'default',
      language: '',
      memoryContext: '',
      sessionContext: '',
      passiveLspDiagnostics: '',
      customSystemPrompt: customWithFloor,
      userRulesPrompt: undefined,
    })
    const occurrences = L.systemContext.split(PERSISTENCE_MARKER).length - 1
    expect(occurrences).toBe(1)
  })

  // 2026-07 completion-evidence handshake — protocol floor. Without this
  // injection a custom bundle prompt never teaches the in-band
  // `<complete-evidence>` tag, so the row-12f gate challenges EVERY
  // tool-using completion: user-visible as a multi-second stall between
  // the last visible sentence and message_stop.
  it('appends the completion-evidence protocol block to a custom bundle prompt', () => {
    const L = buildMainSystemPromptLayersFromOrchestration({
      workspacePath: '/proj/x',
      cwd: '/proj/x',
      platform: 'linux',
      outputStyle: 'default',
      language: '',
      memoryContext: '',
      sessionContext: '',
      passiveLspDiagnostics: '',
      customSystemPrompt: '你是一名售前工程师，请用中文回答。',
      userRulesPrompt: undefined,
    })
    expect(L.systemContext).toContain(COMPLETION_EVIDENCE_PROMPT_MARKER)
  })

  it('does NOT double-inject the completion-evidence block when inlined', () => {
    const customWithBlock = `Bundle preamble.\n\n${COMPLETION_EVIDENCE_PROMPT_MARKER}\nInline phrasing.`
    const L = buildMainSystemPromptLayersFromOrchestration({
      workspacePath: '/proj/x',
      cwd: '/proj/x',
      platform: 'linux',
      outputStyle: 'default',
      language: '',
      memoryContext: '',
      sessionContext: '',
      passiveLspDiagnostics: '',
      customSystemPrompt: customWithBlock,
      userRulesPrompt: undefined,
    })
    const occurrences =
      L.systemContext.split(COMPLETION_EVIDENCE_PROMPT_MARKER).length - 1
    expect(occurrences).toBe(1)
  })

  it('default (non-custom) path still carries the anti-action-hallucination block (sanity)', () => {
    const L = buildMainSystemPromptLayersFromOrchestration({
      workspacePath: '/proj/x',
      cwd: '/proj/x',
      platform: 'linux',
      outputStyle: 'default',
      language: '',
      memoryContext: '',
      sessionContext: '',
      passiveLspDiagnostics: '',
      customSystemPrompt: undefined,
      userRulesPrompt: undefined,
    })
    expect(L.systemContext).toContain(ANTI_ACTION_HALLUCINATION_MARKER)
    expect(L.systemContext).toContain(PERSISTENCE_MARKER)
  })

  it('custom bundle path routes memory/LSP/env/session to userMessageContext (Stage 4)', () => {
    // Stage 4 moved env + session_context out of `userContext` to
    // `userMessageContext` so the custom-bundle path stays aligned with
    // the default 星构Astra path. `userContext` for a custom bundle now
    // carries only "instruction-grade" content (skill index, user rules,
    // edit-file contract).
    const L = buildMainSystemPromptLayersFromOrchestration({
      workspacePath: '/proj/x',
      cwd: '/proj/x',
      platform: 'linux',
      outputStyle: 'default',
      language: '',
      memoryContext: 'remembered fact',
      sessionContext: 'pending session note',
      passiveLspDiagnostics: 'src/a.ts:1:1 - warning TS9999: diag',
      customSystemPrompt: 'CUSTOM',
      userRulesPrompt: undefined,
    })

    // userContext (system field) — none of the reference-grade data
    expect(L.userContext).not.toContain('<session-context>')
    expect(L.userContext).not.toContain('pending session note')
    expect(L.userContext).not.toContain('# Project Memory')
    expect(L.userContext).not.toContain('# Environment')

    // userMessageContext — carries memory + LSP + env + session
    expect(L.userMessageContext).toContain('# Project Memory')
    expect(L.userMessageContext).toContain('remembered fact')
    expect(L.userMessageContext).toContain('TS9999')
    expect(L.userMessageContext).toContain('# Environment')
    expect(L.userMessageContext).toContain('Primary working directory: /proj/x')
    expect(L.userMessageContext).toContain('<session-context>')
    expect(L.userMessageContext).toContain('pending session note')
  })
})
