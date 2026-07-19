/**
 * Output-style collector — surfaces mid-conversation changes to the
 * user's chosen response style (`default` / `concise` / `explanatory`).
 *
 * ## What it does (and doesn't)
 *
 * The active `outputStyle` setting is already baked into the system
 * prompt via `renderSystemPromptInstructionSection`, so the model
 * sees it on every request. This collector exists ONLY to surface
 * CHANGES mid-conversation — the user toggled style in settings
 * partway through a chat, and the model should acknowledge the
 * shift on the next post-tool boundary.
 *
 * On the very first observation per conversation, the collector
 * records the style without emitting (the system prompt already
 * conveys it; double-emitting would be redundant). Subsequent
 * observations where the style differs fire a single
 * `<system-reminder>` user message.
 *
 * ## upstream parity
 *
 * Equivalent to upstream's `output_style` attachment
 * (`src/utils/messages.ts` case `'output_style'`) which mentions
 * the style name + a short description. Our message is the same
 * shape.
 *
 * ## Gating
 *
 * - **On by default**. The delta-only emission semantics keep this
 *   silent for the common case (user picks a style and sticks with
 *   it); only mid-conversation switches surface a notice. Disable
 *   via `POLE_OUTPUT_STYLE_DELTA=0` if the notification is unwanted.
 * - Main chat only.
 * - `post_tool` call site.
 */

import type { Collector } from '../hostAttachments'
import { getAgentContext } from '../../../agents/agentContext'
import {
  SIDE_CHANNEL_KIND,
  wrapSideChannelBody,
} from '../../../constants/sideChannelKinds'
import { loadSettings } from '../../../settings/settingsStore'

type OutputStyle = 'default' | 'concise' | 'explanatory'

const lastSeenByConversation = new Map<string, OutputStyle>()

const STYLE_DESCRIPTIONS: Record<OutputStyle, string> = {
  default: 'balanced — direct by default, concise explanations where needed.',
  concise: 'concise — keep outputs short, direct, action-focused.',
  explanatory: 'explanatory — include brief rationale and key implementation details when helpful.',
}

function isOutputStyleDeltaEnabled(): boolean {
  const raw = process.env.POLE_OUTPUT_STYLE_DELTA?.trim().toLowerCase()
  // Default-on: only an explicit `0` / `false` / `no` disables.
  if (raw === '0' || raw === 'false' || raw === 'no') return false
  return true
}

function normaliseStyle(value: unknown): OutputStyle | null {
  if (value === 'default' || value === 'concise' || value === 'explanatory') {
    return value
  }
  return null
}

/** Test seam. */
export function __resetOutputStyleSnapshotsForTests(): void {
  lastSeenByConversation.clear()
}

export const outputStyleCollector: Collector = {
  name: 'output_style',
  callSites: ['post_tool'],

  async run(ctx) {
    if (!isOutputStyleDeltaEnabled()) return null
    const { state } = ctx

    const agentCtx = getAgentContext()
    const isMainChat = !agentCtx?.agentId || agentCtx.agentId === 'main'
    if (!isMainChat) return null
    const convId = agentCtx?.streamConversationId?.trim()
    if (!convId) return null

    let currentStyle: OutputStyle | null
    try {
      const settings = loadSettings() as Record<string, unknown>
      currentStyle = normaliseStyle(settings.outputStyle)
    } catch {
      return null
    }
    if (!currentStyle) return null

    const lastSeen = lastSeenByConversation.get(convId)
    lastSeenByConversation.set(convId, currentStyle)

    // First observation — record without emitting (system prompt
    // already conveys the style; double-emit would be redundant noise).
    if (lastSeen === undefined) return null
    if (lastSeen === currentStyle) return null

    const description = STYLE_DESCRIPTIONS[currentStyle]
    const body =
      `Output style changed to **${currentStyle}** — ${description} ` +
      `Apply this style starting with your next response. Do not mention this notice to the user.`

    state.appendixReport('P2_Q_compaction_reminder', {
      iteration: state.iteration,
      kind: 'output_style',
      previousStyle: lastSeen,
      currentStyle,
    })

    return {
      kind: 'push_message',
      sideChannelKind: SIDE_CHANNEL_KIND.genericConvertedSystem,
      message: {
        role: 'user',
        content: wrapSideChannelBody(
          SIDE_CHANNEL_KIND.genericConvertedSystem,
          body,
        ),
        _convertedFromSystem: true,
        _sideChannelKind: SIDE_CHANNEL_KIND.genericConvertedSystem,
      },
    }
  },
}
