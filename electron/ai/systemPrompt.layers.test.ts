import { describe, it, expect } from 'vitest'
import {
  buildSystemPrompt,
  buildSystemPromptLayers,
  mergeSystemPromptLayers,
  USER_MESSAGE_CONTEXT_DISCLAIMER,
  workspaceFingerprintForPrompt,
} from './systemPrompt'

describe('SystemPromptLayers (AC-6.3, post Stage-1..4 整改)', () => {
  const baseOpts = {
    cwd: '/tmp/ws',
    platform: 'linux' as const,
    outputStyle: 'default' as const,
    language: 'en',
    memoryContext: '',
    sessionContext: '',
    lspPassiveDiagnosticsContext: '',
  }

  // Regression — anti-action-hallucination rule. The "Faithful reporting" /
  // "No action hallucination" sub-section must remain in the stable
  // systemContext layer so prompt-cache reuse is not invalidated, and the
  // key past-tense action verbs the model commonly hallucinates ("我已经修
  // 改了", "I edited", "我创建了") must be explicitly listed so the rule has
  // surface-level grounding. If a future refactor reformulates this section,
  // update the assertions but DO NOT silently remove the constraint —
  // production users hit "model claims completion without tool call"
  // hallucinations regularly and rely on this guardrail.
  it('systemContext carries the anti-action-hallucination clause with both Chinese and English action-verb examples', () => {
    const L = buildSystemPromptLayers(baseOpts)
    expect(L.systemContext).toContain('No action hallucination')
    // Mutating verbs (English) must be present.
    expect(L.systemContext).toMatch(/I edited X|I created X|I ran X/u)
    // Mutating verbs (Chinese) must be present too — Chinese-language
    // models hallucinate "我已经修改了" patterns at higher rates than
    // their English equivalents.
    expect(L.systemContext).toMatch(/我已经修改了|我创建了|我运行了/u)
    // The escape valve — read-only observations are explicitly exempted.
    expect(L.systemContext).toContain('Read-only observations')
  })

  it('merge(buildSystemPromptLayers) equals buildSystemPrompt', () => {
    const full = buildSystemPrompt({
      ...baseOpts,
      memoryContext: 'mem1',
      sessionContext: 'sess1',
    })
    const L = buildSystemPromptLayers({
      ...baseOpts,
      memoryContext: 'mem1',
      sessionContext: 'sess1',
    })
    expect(mergeSystemPromptLayers(L.systemContext, L.userContext)).toBe(full)
  })

  it('systemContext + userContext do NOT leak project-memory or session-context DATA (Stage 4 — both routed to userMessageContext)', () => {
    // Stage 4 moved both `<project-memory>` and `<session-context>` to
    // `userMessageContext` (the `<system-reminder>` user-meta msg at
    // messages[0]). Neither layer that ships in the API `system` field
    // should contain real data — only the user-meta layer does. The
    // tag *names* may appear in `systemContext` inside the "How to
    // recall what already happened" docstring (educational), but the
    // secret-token check below catches any data leak.
    const L = buildSystemPromptLayers({
      ...baseOpts,
      memoryContext: 'SECRET_MEM',
      sessionContext: 'SECRET_SESS',
    })
    expect(L.systemContext).not.toContain('SECRET_MEM')
    expect(L.systemContext).not.toContain('SECRET_SESS')
    expect(L.userContext).not.toContain('<project-memory>')
    expect(L.userContext).not.toContain('<session-context>')
    expect(L.userContext).not.toContain('SECRET_MEM')
    expect(L.userContext).not.toContain('SECRET_SESS')
    // Secrets surface only in user-meta.
    expect(L.userMessageContext).toContain('<project-memory>')
    expect(L.userMessageContext).toContain('SECRET_MEM')
    expect(L.userMessageContext).toContain('<session-context>')
    expect(L.userMessageContext).toContain('SECRET_SESS')
  })

  it('userMessageContext carries project memory + LSP, formatted for cc-haha-style user-meta msg', () => {
    // Reference-grade volatile context that ships as messages[0] via
    // `prependUserContext` instead of inside the `system` field. Pairing
    // with the disclaimer pushes the model toward "reference, not
    // instruction" reading.
    const L = buildSystemPromptLayers({
      ...baseOpts,
      memoryContext: 'SECRET_MEM',
      lspPassiveDiagnosticsContext: 'src/foo.ts:12 — error TS2322',
    })
    expect(L.userMessageContext).toContain('# Project Memory')
    expect(L.userMessageContext).toContain('SECRET_MEM')
    expect(L.userMessageContext).toContain('# LSP diagnostics')
    expect(L.userMessageContext).toContain('error TS2322')
    // Disclaimer ships separately at the streamHandler call site, not
    // inside `userMessageContext` itself — keeps the layer composable.
    expect(L.userMessageContext).not.toContain(USER_MESSAGE_CONTEXT_DISCLAIMER)
  })

  it('userMessageContext always carries # Environment (post Stage 4) — even with no memory / LSP / session', () => {
    // Stage 4 promoted env to a reference-grade block in user-meta. It is
    // small + session-stable, so always emitted — the user-meta wrap +
    // disclaimer keeps the model from reading it as a directive.
    const L = buildSystemPromptLayers(baseOpts)
    expect(L.userMessageContext).toContain('# Environment')
    expect(L.userMessageContext).toContain('Primary working directory: /tmp/ws')
    expect(L.userMessageContext).not.toContain('# Project Memory')
    expect(L.userMessageContext).not.toContain('# LSP diagnostics')
    expect(L.userMessageContext).not.toContain('<session-context>')
  })

  it('USER_MESSAGE_CONTEXT_DISCLAIMER tells the model the # blocks are reference, not instruction', () => {
    // Mirrors upstream (leaked upstream) `prependUserContext` disclaimer —
    // load-bearing for preventing sycophancy ("you're right…") and
    // "fix everything you see" reactions to LSP diagnostics.
    expect(USER_MESSAGE_CONTEXT_DISCLAIMER).toMatch(/may or may not be relevant/i)
    expect(USER_MESSAGE_CONTEXT_DISCLAIMER).toMatch(/retrieved background/i)
    expect(USER_MESSAGE_CONTEXT_DISCLAIMER).toMatch(/last in the conversation/i)
  })

  it('systemContext is static — no env block, no per-day date', () => {
    // Stage 4: env (with today's date) moved to userContext so the static
    // prefix can be prompt-cached across day rollovers.
    const L = buildSystemPromptLayers(baseOpts)
    expect(L.systemContext).not.toContain('# Environment')
    expect(L.systemContext).not.toContain('Primary working directory:')
    expect(L.systemContext).not.toMatch(/Today's date is/)
    expect(L.systemContext).toMatch(/You are an interactive agent/i)
  })

  it('userMessageContext carries the session-stable env block (cwd / platform / shell / OS) — moved here in Stage 4', () => {
    // Stage 2 removed `Today's date` (single source of truth in user-meta)
    // and `Node:` (high-churn). Stage 4 then moved the whole env block
    // out of `userContext` (system field) into `userMessageContext`
    // (user-meta) so the model reads it as reference, not instruction.
    const L = buildSystemPromptLayers(baseOpts)
    expect(L.userContext).not.toContain('# Environment')
    expect(L.userMessageContext).toContain('# Environment')
    expect(L.userMessageContext).toContain('Primary working directory: /tmp/ws')
    expect(L.userMessageContext).toContain('Platform: linux')
    expect(L.userMessageContext).toContain('Shell:')
    expect(L.userMessageContext).toContain('OS Version:')
    // Date and Node are NOT in the env block any more (single source for
    // date is the user-meta `# Today's date` line; Node was dropped).
    expect(L.userMessageContext).not.toMatch(/Today's date is/)
    expect(L.userMessageContext).not.toMatch(/Node:/)
  })

  it('§7.1 attribution header — plain text on systemContext, NOT wrapped in <system-reminder>', () => {
    // Stage 3·1: dropped the `<system-reminder>` wrap so the tag's "this is
    // runtime context" semantics stay reserved for actual runtime injections
    // (memory snapshots, watchdog nudges, etc.). Foundational identity is
    // plain prose, matching upstream (the leaked upstream reference).
    const L = buildSystemPromptLayers(baseOpts)
    const fp = workspaceFingerprintForPrompt('/tmp/ws')
    expect(L.systemContext).toContain('星构Astra (cursor-ui-clone)')
    expect(L.systemContext).toContain(`workspace_fp=${fp}`)
    expect(L.systemContext).toContain('prompt_layers=v1')
    // Whatever surrounds the attribution must NOT be a <system-reminder> wrap.
    const attrLine = L.systemContext.split('\n').find((l) => l.includes('星构Astra'))
    expect(attrLine).toBeDefined()
    expect(attrLine!).not.toMatch(/^<system-reminder>/)
    expect(attrLine!).not.toMatch(/<\/system-reminder>$/)
  })

  it('# System block tells the model what <system-reminder> means', () => {
    // Stage 3·2: explicit framing prevents the model from treating injected
    // memory / session reminders as a fresh user rebuke (sycophancy loop).
    const L = buildSystemPromptLayers(baseOpts)
    expect(L.systemContext).toMatch(/<system-reminder>/u)
    expect(L.systemContext).toMatch(/runtime context/i)
    expect(L.systemContext).toMatch(/NOT new instructions/i)
  })

  // Regression: prompt must explicitly enumerate every "what already
  // happened in this session?" signal source AND state their priority
  // order. Without this, models on non-Anthropic providers (especially
  // the Chinese gateways we route through anthropicCompatHttp) would
  // ignore <session-context> and re-issue tool calls for work already
  // recorded in the running ledger.
  it('# System block lists all "what already happened" signal sources with priority', () => {
    const L = buildSystemPromptLayers(baseOpts)
    // Section header + enumeration.
    expect(L.systemContext).toMatch(/How to recall what already happened/u)
    // 1) Conversation messages themselves are the ground truth.
    expect(L.systemContext).toMatch(/conversation messages themselves/iu)
    expect(L.systemContext).toMatch(/tool_use[\s\S]{0,200}tool_result/u)
    // 2) <session-context> structured ledger.
    expect(L.systemContext).toContain('<session-context>')
    expect(L.systemContext).toMatch(/Pending tasks/u)
    expect(L.systemContext).toMatch(/Files touched/u)
    // 3) Previous tool execution summary.
    expect(L.systemContext).toContain('[Previous tool execution summary')
    // 4) Compact recap.
    expect(L.systemContext).toContain('[Previous conversation was compacted')
    expect(L.systemContext).toMatch(/Do NOT re-do work/u)
    // 5) Project memory.
    expect(L.systemContext).toContain('<project-memory>')
    // 6) Sub-agent inherited parent context.
    expect(L.systemContext).toContain('<inherited-parent-context>')
  })

  it('mergeSystemPromptLayers ignores whitespace-only userContext', () => {
    expect(mergeSystemPromptLayers('A', '  \n')).toBe('A')
    expect(mergeSystemPromptLayers('A', 'B')).toBe('A\n\nB')
  })

  it('emits the "Tool-use conventions" block on every turn', () => {
    const L = buildSystemPromptLayers(baseOpts)
    expect(L.systemContext).toContain('# Tool-use conventions')
    // Core load-bearing reminders — must all be present so first-try tool
    // accuracy stays high (regression targets from past incidents).
    expect(L.systemContext).toContain('relative paths resolve against the workspace root')
    expect(L.systemContext).toContain('edit_file')
    expect(L.systemContext).toContain('read_file → edit_file workflow')
    expect(L.systemContext).toContain('timeoutMs')
    expect(L.systemContext).toContain('milliseconds')
    expect(L.systemContext).toContain('runInBackground')
    expect(L.systemContext).toContain('What happened / Tried / Context / Next')
  })

  it('tells the model not to invent paths from training-data conventions', () => {
    // Regression target from a real session: the model admitted
    // "I guessed — most projects put model at src/domain/models.py, so I
    // composed a path from that convention". This rule forces the model
    // to run glob / list_files BEFORE a read_file on an unseen path.
    const L = buildSystemPromptLayers(baseOpts)
    expect(L.systemContext).toMatch(/Do NOT invent paths/i)
    expect(L.systemContext).toContain('glob')
    expect(L.systemContext).toContain('list_files')
    // Must call out training-data priors by name so the rule registers.
    expect(L.systemContext).toMatch(/training[- ]data/i)
  })

  it('adds the Windows-specific PowerShell/&&-chain reminder on platform=win32', () => {
    const L = buildSystemPromptLayers({ ...baseOpts, platform: 'win32' })
    // Accept either "PS 5.1" or "PowerShell 5.1" so future string tweaks don't
    // break the lock; the load-bearing bit is that PS 5.1's `&&` limitation
    // reaches the model.
    expect(L.systemContext).toMatch(/(PS|PowerShell)\s*5\.1/)
    expect(L.systemContext).toContain('&&')
    expect(L.systemContext).toMatch(/Git Bash/)
  })

  it('omits the Windows-specific reminder on non-Windows platforms', () => {
    const L = buildSystemPromptLayers({ ...baseOpts, platform: 'linux' })
    // The conventions section is still emitted, but the PS-5.1 paragraph is not.
    expect(L.systemContext).toContain('# Tool-use conventions')
    expect(L.systemContext).not.toMatch(/(PS|PowerShell)\s*5\.1/)
  })

  it('Stage 1·去重: TodoWrite no longer carries threatening "MANDATORY/ENFORCED BY SYSTEM" wording', () => {
    // Stage 2: same psychological footprint as the (now removed) phantom-work
    // strike threats — language like "ENFORCED BY SYSTEM" + "protocol violation"
    // pushed the model to "satisfy the watchdog" (cf. the no-op-echo bug).
    // The actual enforcement remains in code (`MAX_TODO_PENDING_STRIKES`),
    // the prompt now just describes TodoWrite as a working tool.
    const L = buildSystemPromptLayers(baseOpts)
    expect(L.systemContext).toMatch(/TodoWrite/)
    expect(L.systemContext).not.toMatch(/MANDATORY — ENFORCED BY SYSTEM/)
    expect(L.systemContext).not.toMatch(/hard protocol requirement/i)
    expect(L.systemContext).not.toMatch(/protocol violation/i)
  })

  it('Stage 1·去重: result-claim discipline lives in ONE section (Faithful reporting), not three', () => {
    const L = buildSystemPromptLayers(baseOpts)
    // The dedicated "# Faithful reporting" section is the canonical place.
    expect(L.systemContext).toContain('# Faithful reporting')
    // The two old duplicates ("CRITICAL — Text output ordering" and
    // "# Tools: call directly vs ToolSearch") are gone.
    expect(L.systemContext).not.toMatch(/CRITICAL — Text output ordering/)
    expect(L.systemContext).not.toMatch(/# Tools: call directly vs ToolSearch/)
  })
})
