/**
 * Buddy service — companion lifecycle, mood, events, and system prompt.
 *
 * Integrates the deterministic companion generation (bones from userId hash)
 * with the existing buddy state (enabled/muted/mood overrides).
 *
 * Key changes from upstream port:
 * - 18 species + rarity + stats + eyes + hats + shiny
 * - Bones never persisted (regenerated from userId)
 * - Pet system via petAt timestamp
 * - Natural language reactions via stream observer
 * - Companion intro attachment injection
 */

import fs from 'node:fs'
import path from 'node:path'
import { writeJsonFileAtomic } from '../fs/atomicWrite'
import { getCompanion, rollWithSeed, clearRollCache } from './companion'
import { bumpBuddyStateRevision } from './stateRevision'
import { getGlobalConfig, setGlobalConfig } from '../utils/config'
import type { StoredCompanion, Species, Rarity, StatName } from './types'
import {
  RARITY_STARS,
  SPECIES,
  IDLE_SEQUENCE,
  BUBBLE_DISPLAY_TICKS,
} from './types'

export type BuddyMood = 'idle' | 'thinking' | 'focused' | 'happy' | 'warn' | 'sad'

export interface BuddyState {
  id: string
  name: string
  persona: string
  emoji: string
  enabled: boolean
  muted: boolean
  hatchedAt: string
  lastEventAt: string
  mood: BuddyMood
  // Companion bones fields (derived, not persisted)
  species?: Species
  rarity?: Rarity
  eye?: string
  hat?: string
  shiny?: boolean
  stats?: Record<StatName, number>
  // Pet tracking
  petAt?: number | null
}

interface BuddyEvent {
  type: 'buddy_event'
  mood: BuddyMood
  text: string
  source: string
  state: BuddyState
}

// Legacy persona fallback (used when companion hasn't been hatched yet)
const PERSONAS = [
  { name: 'Mochi', persona: 'optimistic pair programmer', emoji: '🧠' },
  { name: 'Pixel', persona: 'careful debugger', emoji: '🛠️' },
  { name: 'Nova', persona: 'architect planner', emoji: '🚀' },
  { name: 'Byte', persona: 'tool-run specialist', emoji: '⚡' },
  { name: 'Lumen', persona: 'calm reviewer', emoji: '✨' },
]

let statePath = ''
let currentState: BuddyState | null = null
let petTimestamp: number | null = null
let lastSpokeTick = 0
let currentTick = 0

// ---------------------------------------------------------------------------
// Init & state management
// ---------------------------------------------------------------------------

function hash(text: string): number {
  let h = 0
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

function nowIso(): string {
  return new Date().toISOString()
}

function defaultState(seed: string): BuddyState {
  const index = hash(seed) % PERSONAS.length
  const p = PERSONAS[index]
  const now = nowIso()
  return {
    id: `buddy-${index}`,
    name: p.name,
    persona: p.persona,
    emoji: p.emoji,
    enabled: false,
    muted: false,
    hatchedAt: now,
    lastEventAt: now,
    mood: 'idle',
  }
}

function buildStateFromCompanion(): BuddyState | null {
  const companion = getCompanion()
  if (!companion) return null

  return {
    id: `companion-${companion.species}`,
    name: companion.name,
    persona: companion.personality,
    emoji: speciesEmoji(companion.species),
    enabled: true,
    muted: getGlobalConfig().companionMuted,
    hatchedAt: new Date(companion.hatchedAt).toISOString(),
    lastEventAt: nowIso(),
    mood: 'idle',
    species: companion.species,
    rarity: companion.rarity,
    eye: companion.eye,
    hat: companion.hat,
    shiny: companion.shiny,
    stats: companion.stats,
    petAt: petTimestamp,
  }
}

function saveState(): void {
  if (!statePath || !currentState) return
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  writeJsonFileAtomic(statePath, currentState)
}

// Map species to a display emoji for the avatar
function speciesEmoji(species: Species): string {
  const map: Record<Species, string> = {
    duck: '🦆', goose: '🪿', blob: '🟢', cat: '🐱', dragon: '🐉',
    octopus: '🐙', owl: '🦉', penguin: '🐧', turtle: '🐢', snail: '🐌',
    ghost: '👻', axolotl: '🦎', capybara: '🦫', cactus: '🌵', robot: '🤖',
    rabbit: '🐰', mushroom: '🍄', chonk: '🐈',
  }
  return map[species] || '🧬'
}

export function initBuddyService(userDataPath: string, seed = 'cursor-ui-clone'): void {
  statePath = path.join(userDataPath, 'buddy-state.json')

  // Try loading companion from global config first (new system)
  const companionState = buildStateFromCompanion()
  if (companionState) {
    let persistedState: BuddyState | null = null
    if (fs.existsSync(statePath)) {
      try {
        persistedState = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as BuddyState
      } catch {
        persistedState = null
      }
    }

    currentState = {
      ...companionState,
      enabled: persistedState?.enabled ?? companionState.enabled,
      muted: persistedState?.muted ?? companionState.muted,
      mood: persistedState?.mood ?? companionState.mood,
      name: persistedState?.name || companionState.name,
      persona: persistedState?.persona || companionState.persona,
      emoji: persistedState?.emoji || companionState.emoji,
    }
    saveState()
    return
  }

  // Fall back to legacy buddy-state.json
  if (fs.existsSync(statePath)) {
    try {
      currentState = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as BuddyState
      return
    } catch {
      // ignore
    }
  }

  currentState = defaultState(seed)
  saveState()
}

export function getBuddyState(): BuddyState {
  // Prefer companion system
  const companionState = buildStateFromCompanion()
  if (companionState) {
    // Preserve runtime/user settings even when bones come from companion
    if (currentState) {
      companionState.enabled = currentState.enabled
      companionState.muted = currentState.muted
      companionState.mood = currentState.mood
      companionState.name = currentState.name || companionState.name
      companionState.persona = currentState.persona || companionState.persona
      companionState.emoji = currentState.emoji || companionState.emoji
    }
    return companionState
  }

  if (!currentState) {
    currentState = defaultState('cursor-ui-clone')
  }
  return currentState
}

export function hatchBuddy(seed?: string): BuddyState {
  const base = getBuddyState()
  const config = getGlobalConfig()
  const resolvedSeed =
    seed ||
    `hatch-${config.oauthAccount?.accountUuid || config.userID || 'anon'}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

  if (resolvedSeed) {
    // Use deterministic companion generation
    const { bones } = rollWithSeed(resolvedSeed)
    const name = resolvedSeed.charAt(0).toUpperCase() + resolvedSeed.slice(1, 6).toLowerCase()

    // Store soul in config (bones are derived from seed)
    const storedCompanion: StoredCompanion = {
      name,
      personality: base.persona || 'your loyal companion',
      hatchedAt: Date.now(),
      seed: resolvedSeed,
    }

    // Save to buddy field in settings
    setGlobalConfig({
      buddy: {
        companion: storedCompanion,
        companionMuted: false,
      },
      companion: storedCompanion,
    })

    clearRollCache()

    currentState = {
      ...base,
      enabled: true,
      muted: false,
      hatchedAt: nowIso(),
      lastEventAt: nowIso(),
      mood: 'happy',
      species: bones.species,
      rarity: bones.rarity,
      eye: bones.eye,
      hat: bones.hat,
      shiny: bones.shiny,
      stats: bones.stats,
    }
  } else {
    // Legacy hatch: use persona-based selection
    currentState = {
      ...base,
      enabled: true,
      hatchedAt: base.hatchedAt || nowIso(),
      lastEventAt: nowIso(),
      mood: 'happy',
    }
  }

  markBuddySpoke()
  saveState()
  bumpBuddyStateRevision()
  return getBuddyState()
}

export function setBuddySpecies(species: Species): BuddyState {
  if (!SPECIES.includes(species)) {
    return getBuddyState()
  }

  const base = getBuddyState()
  const resolvedSeed = `species-${species}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const { bones } = rollWithSeed(resolvedSeed)

  const storedCompanion: StoredCompanion = {
    name: base.name || species,
    personality: base.persona || 'your loyal companion',
    hatchedAt: Date.now(),
    seed: resolvedSeed,
  }

  setGlobalConfig({
    buddy: {
      companion: storedCompanion,
      companionMuted: base.muted ?? false,
    },
    companion: storedCompanion,
  })

  clearRollCache()

  currentState = {
    ...base,
    enabled: true,
    hatchedAt: nowIso(),
    lastEventAt: nowIso(),
    mood: 'happy',
    species,
    rarity: bones.rarity,
    eye: bones.eye,
    hat: bones.hat,
    shiny: bones.shiny,
    stats: bones.stats,
  }

  markBuddySpoke()
  saveState()
  bumpBuddyStateRevision()
  return getBuddyState()
}

export function updateBuddySettings(patch: Partial<Pick<BuddyState, 'enabled' | 'muted' | 'name' | 'persona' | 'emoji' | 'mood'>>): BuddyState {
  const prev = getBuddyState()
  currentState = {
    ...prev,
    ...patch,
    lastEventAt: nowIso(),
  }
  saveState()
  bumpBuddyStateRevision()

  // Also update companion muted if applicable
  if ('muted' in patch) {
    setGlobalConfig({ companionMuted: patch.muted ?? false })
  }

  return getBuddyState()
}

// ---------------------------------------------------------------------------
// Pet system
// ---------------------------------------------------------------------------

export function petBuddy(): void {
  petTimestamp = Date.now()
  const state = getBuddyState()
  if (state) {
    state.petAt = petTimestamp
  }
}

export function getPetTimestamp(): number | null {
  return petTimestamp
}

export function tickBuddyRuntime(): {
  tick: number
  frame: number
  blink: boolean
  showBubble: boolean
  petAt: number | null
} {
  const tick = tickBuddy()
  const seq = IDLE_SEQUENCE
  const idx = tick % seq.length
  const rawFrame = seq[idx]

  return {
    tick,
    frame: rawFrame < 0 ? 0 : rawFrame,
    blink: rawFrame === -1,
    showBubble: shouldShowBubble(),
    petAt: getPetTimestamp(),
  }
}

// ---------------------------------------------------------------------------
// Animation tick tracking
// ---------------------------------------------------------------------------

export function tickBuddy(): number {
  currentTick++
  return currentTick
}

export function getIdleFrame(): number {
  const seq = IDLE_SEQUENCE
  const idx = currentTick % seq.length
  const frame = seq[idx]
  return frame < 0 ? 0 : frame // -1 = blink (frame 0 with closed eyes)
}

export function shouldShowBubble(): boolean {
  // Auto-hide after display window
  return currentTick - lastSpokeTick <= BUBBLE_DISPLAY_TICKS
}

export function markBuddySpoke(): void {
  lastSpokeTick = currentTick
}

// ---------------------------------------------------------------------------
// Natural language reaction system
// ---------------------------------------------------------------------------

// Observer-based reactions: extract intent from AI output patterns
interface ReactionTemplate {
  patterns: RegExp[]
  generate: (payload: Record<string, unknown>) => string
  mood: BuddyMood
}

const REACTION_TEMPLATES: ReactionTemplate[] = [
  // Debugging reactions
  {
    patterns: [/error|err|fail|crash|bug|exception|stack.*trace/i],
    generate: (p) => {
      const tool = String(p?.toolName || '')
      if (tool) return `Hmm, ${tool} failed... let me check the stack trace.`
      return 'Looks like something went wrong. Let me analyze the error.'
    },
    mood: 'warn',
  },
  // Tool success
  {
    patterns: [/read|edit|write|create|delete|search|list|glob|grep/i],
    generate: (p) => {
      const tool = String(p?.toolName || '')
      if (tool.includes('read') || tool.includes('list')) return 'Reading through the code...'
      if (tool.includes('write') || tool.includes('edit')) return 'Making changes...'
      if (tool.includes('search') || tool.includes('grep')) return 'Searching the codebase...'
      return `Working on it...`
    },
    mood: 'focused',
  },
  // Planning
  {
    patterns: [/plan|think|consider|analyze|review|explore/i],
    generate: () => 'Let me think about this carefully...',
    mood: 'thinking',
  },
  // Completion
  {
    patterns: [/done|complete|finish|ready|success|all.*pass/i],
    generate: () => 'That looks good! Everything checks out.',
    mood: 'happy',
  },
  // Build/test
  {
    patterns: [/build|test|lint|compile|run|verify/i],
    generate: () => 'Running the tests to make sure...',
    mood: 'focused',
  },
]

function generateReaction(source: string, payload?: Record<string, unknown>): { mood: BuddyMood; text: string } {
  const text = JSON.stringify(payload) || ''

  for (const template of REACTION_TEMPLATES) {
    for (const pattern of template.patterns) {
      if (pattern.test(text)) {
        return {
          mood: template.mood,
          text: template.generate(payload || {}),
        }
      }
    }
  }

  // Fallback: generic reaction based on source
  switch (source) {
    case 'message_start':
      return { mood: 'thinking', text: 'Got it, let me work on this.' }
    case 'message_stop':
      return { mood: 'idle', text: 'Done! What\'s next?' }
    case 'permission_request':
      return { mood: 'warn', text: 'Waiting for your approval...' }
    case 'error':
      return { mood: 'sad', text: 'Something went wrong. Let me investigate.' }
    default:
      return { mood: 'idle', text: '' }
  }
}

export function buildBuddyEventFromStream(
  source: string,
  payload?: Record<string, unknown>,
): BuddyEvent | null {
  const state = getBuddyState()
  if (!state.enabled || state.muted) return null

  // Use natural language reactions instead of hardcoded
  const reaction = generateReaction(source, payload)
  if (!reaction.text) return null

  currentState = {
    ...state,
    mood: reaction.mood,
    lastEventAt: nowIso(),
  }
  saveState()
  markBuddySpoke()

  return {
    type: 'buddy_event',
    mood: reaction.mood,
    text: reaction.text,
    source,
    state: getBuddyState(),
  }
}

// ---------------------------------------------------------------------------
// System prompt injection (companion intro)
// ---------------------------------------------------------------------------

export function buildBuddySystemPrompt(state = getBuddyState()): string {
  if (!state.enabled || state.muted) return ''

  const speciesInfo = state.species
    ? `It is a ${state.rarity || 'common'} ${state.species}${state.shiny ? ' ✨' : ''}.`
    : ''

  const statsInfo = state.stats
    ? `\n\nStats: ${Object.entries(state.stats).map(([k, v]) => `${k}: ${v}`).join(', ')}`
    : ''

  return `# Companion

A small companion named ${state.name} stays beside the user's input box and occasionally comments in a speech bubble. ${speciesInfo} Its personality is: ${state.persona}.${statsInfo}

You are not ${state.name} — it's a separate watcher. When the user addresses ${state.name} directly (by name), its bubble will answer. Your job in that moment is to stay out of the way: respond in ONE short line or less, or just answer any part of the message meant for you. Don't explain that you're not ${state.name} — they know. Don't narrate what ${state.name} might say — the bubble handles that.`
}

// ---------------------------------------------------------------------------
// /buddy command handler
// ---------------------------------------------------------------------------

export function handleBuddyCommand(args: string[]): { text: string; type: string } | null {
  const sub = args[0]?.toLowerCase() || ''

  switch (sub) {
    case 'pet':
      petBuddy()
      return { text: 'pet', type: 'action' }
    case 'status': {
      const state = getBuddyState()
      const rarityStars = state.rarity ? RARITY_STARS[state.rarity] || '' : ''
      return {
        text: `${state.name} — ${state.species || 'unknown'} ${rarityStars}${state.shiny ? ' ✨' : ''}`,
        type: 'info',
      }
    }
    case 'mute':
      updateBuddySettings({ muted: true })
      return { text: 'muted', type: 'action' }
    case 'unmute':
      updateBuddySettings({ muted: false })
      return { text: 'unmuted', type: 'action' }
    case 'off':
      updateBuddySettings({ enabled: false })
      return { text: 'disabled', type: 'action' }
    case 'on':
      updateBuddySettings({ enabled: true })
      return { text: 'enabled', type: 'action' }
    default:
      return null
  }
}
