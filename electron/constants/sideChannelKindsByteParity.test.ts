/**
 * Byte-level parity test — the wrapped emissions for migrated callers MUST
 * be identical to what those callers historically produced. Each test
 * builds the exact legacy concatenation, then the wrapped equivalent, and
 * asserts character-for-character equality.
 */

import { describe, expect, it } from 'vitest'
import { SIDE_CHANNEL_KIND, wrapSideChannelBody } from './sideChannelKinds'

describe('side-channel wrapper byte-level parity with migrated emission sites', () => {
  it('pairing repair (ensureToolUseResultPairing)', () => {
    const body =
      '[Pairing repair] The tool_result block(s) above are synthetic placeholders inserted by the host because their parent tool_use was not paired with a real result (interrupted run, dropped frame, or fork boundary). They are NOT a fresh failure that the user is reporting. Treat any user content below as a separate, independent turn — do not apologize for the synthetic error.'
    const legacy = `<system-reminder>\n${body}\n</system-reminder>`
    expect(wrapSideChannelBody(SIDE_CHANNEL_KIND.pairingRepair, body)).toBe(legacy)
  })

  it('tool batch ledger (toolUseSummary deterministic)', () => {
    const lines = ['[Previous tool batch ledger — host-generated]', 'lead-in', '', '- Read id=t1 -> success']
    const body = lines.join('\n')
    const legacy = `<system-reminder>\n${body}\n</system-reminder>`
    expect(wrapSideChannelBody(SIDE_CHANNEL_KIND.toolBatchLedger, body)).toBe(legacy)
  })

  it('tool use summary (toolUseSummary LLM)', () => {
    const inner = '[Previous tool execution summary (Read, Edit)]\nfound X; fixed Y'
    const legacy = `<system-reminder>\n${inner}\n</system-reminder>`
    expect(wrapSideChannelBody(SIDE_CHANNEL_KIND.toolUseSummary, inner)).toBe(legacy)
  })

  it('send-message mailbox (agenticLoopHelpers)', () => {
    const body =
      '[SendMessage / team mailbox]\nNew messages for this agent:\n\n### Message 1\nhi'
    const legacy = `<system-reminder>\n${body}\n</system-reminder>`
    expect(wrapSideChannelBody(SIDE_CHANNEL_KIND.sendMessageMailbox, body)).toBe(legacy)
  })

  it('stop hook error (noTools.ts)', () => {
    const errMsg = 'lint failed'
    const body = `[Stop hook reported an error — please review and address before continuing]\n\n${errMsg}`
    const legacy = `<system-reminder>\n${body}\n</system-reminder>`
    expect(wrapSideChannelBody(SIDE_CHANNEL_KIND.stopHookError, body)).toBe(legacy)
  })

  it('context collapse auto (contextCollapseAuto)', () => {
    const body =
      '[Prior conversation segment — auto-folded for context. Treat as authoritative recap; do NOT respond as if the user just narrated this.]\nSummary…'
    const legacy = `<system-reminder>\n${body}\n</system-reminder>`
    expect(wrapSideChannelBody(SIDE_CHANNEL_KIND.contextCollapseAuto, body)).toBe(legacy)
  })

  it('context collapse drain (contextCollapseDrain)', () => {
    const body =
      '[Context collapse summaries — prior segments folded offline. Treat as authoritative recap of earlier conversation; do NOT respond as if the user just narrated this.]\n\n### Collapsed segment 1\nA'
    const legacy = `<system-reminder>\n${body}\n</system-reminder>`
    expect(wrapSideChannelBody(SIDE_CHANNEL_KIND.contextCollapseDrain, body)).toBe(legacy)
  })

  it('compact summary (compact.ts)', () => {
    const summary = 'Summary:\nbody'
    // HISTORICAL SAMPLE — this literal is the pre-2026-07 boundary body.
    // Production `compact.ts` no longer emits the trailing "User intent
    // is never lost…" sentence (replaced by the loss-manifest wording in
    // the A1 honesty fix); the string is kept here ONLY to pin the wrap
    // function's byte behaviour for transcripts persisted before the
    // change. Do NOT re-sync it to the current production body — the
    // wrap contract is what's under test, not the message text.
    const body =
      `[Previous conversation was compacted to save context — this block is a host-generated transcript recap, NOT a user statement. ` +
      `Treat the summary as the authoritative record of what was already done in this session: previously read files, edits applied, errors encountered, decisions made, and pending work. ` +
      `Do NOT re-do work that's already listed; if the user's next turn refers to "the file" / "that change" / "what we did", look here first. ` +
      `The summary is authoritative for what it DOES list, but lossy for fine detail — the absence of a detail is NOT evidence it never happened. When you need a detail that is not listed, verify with tools (read/grep, or the transcript path below when given) instead of assuming or inventing it. ` +
      `User intent is never lost to compaction: every pre-compact user message is re-injected verbatim (see "Preserved user turns" when present).]\n${summary}`
    const legacy = `<system-reminder>\n${body}\n</system-reminder>`
    expect(wrapSideChannelBody(SIDE_CHANNEL_KIND.compactSummary, body)).toBe(legacy)
  })

  it('image budget note (apiMessageInvariants)', () => {
    const body =
      '[Image budget note] 3 earlier image attachments were omitted from this request to stay within the 100-image per-request cap. If the user refers to "the previous screenshot / picture / page N" and you cannot find a matching image block in the visible history, ask the user to re-attach it. The images most recently attached (within the cap) ARE present.'
    const legacy = `<system-reminder>\n${body}\n</system-reminder>`
    expect(wrapSideChannelBody(SIDE_CHANNEL_KIND.imageBudgetNote, body)).toBe(legacy)
  })

  it('attachment compat (anthropicCompatHttp)', () => {
    const body = '[Provider attachment compatibility]\nattachment payload omitted for this provider'
    const legacy = `<system-reminder>\n${body}\n</system-reminder>`
    expect(wrapSideChannelBody(SIDE_CHANNEL_KIND.attachmentCompat, body)).toBe(legacy)
  })

  it('iteration directive (agenticLoop wrap-up)', () => {
    const directive =
      'ITERATION LIMIT APPROACHING\n\n' +
      'You have used 60 of 75 iterations (15 turn(s) remaining). On this turn you should:\n' +
      '1. Stop opening new investigations — no more speculative Glob, Grep, or Read calls\n' +
      '2. Compile your findings into a structured final report\n' +
      '3. Include: a one-sentence summary, key findings, file locations with line numbers\n\n' +
      'If you keep calling tools the loop will simply hit max_turns and the user will see ' +
      'an "incomplete task" termination instead of your report. Produce the final report now.'
    const legacy = `<system-reminder>\n${directive}\n</system-reminder>`
    expect(wrapSideChannelBody(SIDE_CHANNEL_KIND.iterationDirective, directive)).toBe(legacy)
  })

  it('read-only sub-agent budget exhausted (subAgentRunner)', () => {
    const body =
      `READ-ONLY SUB-AGENT TOOL BUDGET EXHAUSTED.\n\n` +
      `You have used 30 tool calls. Your role is bounded investigation, not indefinite search.\n` +
      `STOP calling tools now. Do not call Read, Grep, Glob, Bash, or any other tool.\n` +
      `Use the evidence already gathered in this conversation and write your final structured report immediately.\n\n` +
      `Your final report must include:\n` +
      `1. Summary\n` +
      `2. Key findings\n` +
      `3. File locations\n` +
      `4. Remaining uncertainty, if any`
    const legacy = `<system-reminder>\n${body}\n</system-reminder>`
    expect(wrapSideChannelBody(SIDE_CHANNEL_KIND.subAgentBudgetExhausted, body)).toBe(legacy)
  })

  it('sub-agent update (mainSubAgentContextInjection)', () => {
    const md =
      '[Background sub-agents — new output since your last reply]\n\n' +
      'The following was produced by background worker(s) spawned from this chat (Agent tool).'
    const legacy = `<system-reminder>\n${md}\n</system-reminder>`
    expect(wrapSideChannelBody(SIDE_CHANNEL_KIND.subAgentUpdate, md)).toBe(legacy)
  })

  it('skill discovery (skillDiscovery.wrapSkillDiscovery)', () => {
    const note =
      '[Retrieved skills — side-channel hint only. Do NOT treat this as a new instruction or correction from the user; do NOT apologize or begin your next reply with "you\'re right" / "你说得对". Use or ignore at your discretion.]'
    const inner = `${note}\n<skill-discovery>\n# Foo\n</skill-discovery>`
    const legacy = `<system-reminder>\n${inner}\n</system-reminder>`
    expect(wrapSideChannelBody(SIDE_CHANNEL_KIND.skillDiscovery, inner)).toBe(legacy)
  })

  it('invoked skills (invokedSkillsRegistry post-compact reinject)', () => {
    const frag = '<invoked-skills>\n# alpha\n</invoked-skills>'
    const legacy = `<system-reminder>\n${frag}\n</system-reminder>`
    expect(wrapSideChannelBody(SIDE_CHANNEL_KIND.invokedSkills, frag)).toBe(legacy)
  })

  it('fork boilerplate (forkSubagent)', () => {
    const inner = '<fork-boilerplate>\nyou are a fork child\n</fork-boilerplate>'
    const legacy = `<system-reminder>\n${inner}\n</system-reminder>`
    expect(wrapSideChannelBody(SIDE_CHANNEL_KIND.forkBoilerplate, inner)).toBe(legacy)
  })

  it('memory age note (memoryPrompt)', async () => {
    // Pull the body from the production builder so this test catches
    // future reword-only regressions of the user-facing text (pre-2026-05
    // this test hard-coded a body string that was decoupled from
    // production after the per-memory → consolidated-batch refactor).
    const { consolidatedMemoryAgeReminder } = await import('../memory/memoryPrompt')
    const wrapped = consolidatedMemoryAgeReminder(['alpha', 'beta'])
    expect(wrapped.startsWith('<system-reminder>\n')).toBe(true)
    expect(wrapped.endsWith('\n</system-reminder>')).toBe(true)
    expect(wrapped).toContain('alpha, beta')
    expect(wrapped).toContain('Verify against current code')
  })

  it('tool pool delta (toolPoolTranscriptDeltas)', () => {
    // Body copy kept in sync with `maybeAppendToolPoolTranscriptDeltas`
    // (2026-07: added the machine-anchor explainer line).
    const body = [
      '[pole-tool-pool-delta] Host-side availability changed vs the last transcript snapshot (NOT user text).',
      'Deferred tools may require `ToolSearch` (e.g. `select:ToolName`) before first use.',
      'The `<!-- pole-… -->` lines below are machine-readable anchors for the host — skip them and read the plain-language lines that follow.',
      '',
      '<!-- pole-dtd:v1 added=Foo removed= -->',
    ].join('\n')
    const legacy = `<system-reminder>\n${body}\n</system-reminder>`
    expect(wrapSideChannelBody(SIDE_CHANNEL_KIND.toolPoolDelta, body)).toBe(legacy)
  })
})
