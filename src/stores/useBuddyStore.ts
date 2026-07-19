import { create } from 'zustand'
import { SPECIES, RARITY_STARS, RARITY_COLORS, IDLE_SEQUENCE, BUBBLE_DISPLAY_TICKS, TICK_MS, type Species, type Rarity, type StatName } from '../../electron/buddy/types'
import { BUDDY_PET_HEART_LIFETIME_MS, BUDDY_TEASER_AUTO_DISMISS_MS } from '../constants/buddyUi'
import { reportUserActionError } from '../utils/reportUserActionError'

export type BuddyMood = 'idle' | 'thinking' | 'focused' | 'happy' | 'warn' | 'sad'

export const PERSONAS = [
  { name: 'Mochi', persona: 'optimistic pair programmer', emoji: '🧠' },
  { name: 'Pixel', persona: 'careful debugger', emoji: '🛠️' },
  { name: 'Nova', persona: 'architect planner', emoji: '🚀' },
  { name: 'Byte', persona: 'tool-run specialist', emoji: '⚡' },
  { name: 'Lumen', persona: 'calm reviewer', emoji: '✨' },
] as const

export const MOODS: BuddyMood[] = ['idle', 'thinking', 'focused', 'happy', 'warn', 'sad']

export const MOOD_EMOJI: Record<BuddyMood, string> = {
  idle: '😴',
  thinking: '🤔',
  focused: '🎯',
  happy: '😊',
  warn: '⚠️',
  sad: '😢',
}

// Species display emoji
const SPECIES_EMOJI: Record<Species, string> = {
  duck: '🦆', goose: '🪿', blob: '🟢', cat: '🐱', dragon: '🐉',
  octopus: '🐙', owl: '🦉', penguin: '🐧', turtle: '🐢', snail: '🐌',
  ghost: '👻', axolotl: '🦎', capybara: '🦫', cactus: '🌵', robot: '🤖',
  rabbit: '🐰', mushroom: '🍄', chonk: '🐈',
}

// Rainbow colors for /buddy teaser
const RAINBOW_COLORS = [
  '#ff6b6b', '#ff9f43', '#feca57', '#48dbfb', '#ff9ff3',
  '#54a0ff', '#5f27cd', '#01a3a4', '#f368e0', '#ff6348',
]

interface BuddyStreamEvent {
  type: string
  state?: Partial<Pick<BuddyState, 'enabled' | 'muted' | 'name' | 'persona' | 'emoji' | 'mood' | 'species' | 'rarity' | 'shiny' | 'hat' | 'eye' | 'stats'>>
  mood?: BuddyMood
  text?: string
}

interface PetHeart {
  id: number
  x: number
  y: number
  emoji: string
  startTime: number
}

interface BuddyState {
  enabled: boolean
  muted: boolean
  name: string
  persona: string
  emoji: string
  mood: BuddyMood
  bubbleText: string
  bubbleVisible: boolean
  bubbleOpacity: number
  settingsOpen: boolean

  // Companion bones
  species: Species | null
  rarity: Rarity | null
  shiny: boolean
  hat: string | null
  eye: string | null
  stats: Record<StatName, number> | null
  petAt: number | null

  // Animation
  spriteFrame: number
  isBlinking: boolean
  tickCount: number

  // Pet system
  petHearts: PetHeart[]
  petting: boolean

  // Notification
  showTeaser: boolean
  teaserDismissed: boolean

  // Methods
  initialize: () => Promise<void>
  hatch: (seed?: string) => Promise<void>
  setSpecies: (species: Species) => Promise<void>
  toggleEnabled: () => Promise<void>
  toggleMuted: () => Promise<void>
  setMood: (mood: BuddyMood) => Promise<void>
  applyPersona: (index: number) => Promise<void>
  updateName: (name: string) => Promise<void>
  openSettings: () => void
  closeSettings: () => void
  applyStreamEvent: (event: BuddyStreamEvent) => void
  startAnimation: () => void
  stopAnimation: () => void
  petBuddy: () => void
  dismissTeaser: () => void
  showTeaserNotification: () => void
}

let animationInterval: ReturnType<typeof setInterval> | null = null
let bubbleHideTimeout: ReturnType<typeof setTimeout> | null = null
// Tracked at module scope so a second hideBubbleWithFade() invocation can
// cancel the previous fade interval. Without this, calling the function in
// rapid succession (e.g. hatch → setSpecies → applyStreamEvent within a few
// hundred ms) leaves the prior interval running until it self-clears at
// fadeStep >= 6, with multiple intervals concurrently writing setState.
let fadeInterval: ReturnType<typeof setInterval> | null = null
let petHeartCounter = 0

function hideBubbleWithFade(): void {
  if (bubbleHideTimeout) {
    clearTimeout(bubbleHideTimeout)
    bubbleHideTimeout = null
  }
  if (fadeInterval) {
    clearInterval(fadeInterval)
    fadeInterval = null
  }

  // Fade out over FADE_WINDOW ticks
  let fadeStep = 0
  fadeInterval = setInterval(() => {
    fadeStep++
    const opacity = 1 - (fadeStep / 6)
    useBuddyStore.setState({ bubbleOpacity: Math.max(0, opacity) })
    if (fadeStep >= 6) {
      if (fadeInterval) {
        clearInterval(fadeInterval)
        fadeInterval = null
      }
      useBuddyStore.setState({ bubbleVisible: false, bubbleOpacity: 1 })
    }
  }, TICK_MS)

  bubbleHideTimeout = setTimeout(() => {
    bubbleHideTimeout = null
    if (fadeInterval) {
      clearInterval(fadeInterval)
      fadeInterval = null
    }
    useBuddyStore.setState({ bubbleVisible: false, bubbleOpacity: 1 })
  }, BUBBLE_DISPLAY_TICKS * TICK_MS)
}

export const useBuddyStore = create<BuddyState>((set, get) => ({
  enabled: false,
  muted: false,
  name: 'Buddy',
  persona: 'pair programmer',
  emoji: '🧠',
  mood: 'idle',
  bubbleText: '',
  bubbleVisible: false,
  bubbleOpacity: 1,
  settingsOpen: false,

  // Companion bones
  species: null,
  rarity: null,
  shiny: false,
  hat: null,
  eye: null,
  stats: null,
  petAt: null,

  // Animation
  spriteFrame: 0,
  isBlinking: false,
  tickCount: 0,

  // Pet
  petHearts: [],
  petting: false,

  // Notification
  showTeaser: false,
  teaserDismissed: false,

  initialize: async () => {
    try {
      const data = await window.electronAPI.buddy.get()
      set({
        enabled: Boolean(data?.enabled),
        muted: Boolean(data?.muted),
        name: data?.name || 'Buddy',
        persona: data?.persona || 'pair programmer',
        emoji: data?.emoji || '🧠',
        mood: (data?.mood || 'idle') as BuddyMood,
        species: (data?.species as Species) || null,
        rarity: (data?.rarity as Rarity) || null,
        shiny: Boolean(data?.shiny),
        hat: data?.hat || null,
        eye: data?.eye || null,
        stats: data?.stats || null,
        petAt: data?.petAt ?? null,
      })

      // If no companion hatched and buddy not enabled, show teaser
      if (!data?.enabled && !data?.species) {
        get().showTeaserNotification()
      }
    } catch (error) {
      // Boot-time path — keep silent (no alert) but at least log so a broken
      // buddy IPC is discoverable in DevTools.
      reportUserActionError('Buddy 初始化', error, { silent: true })
    }
  },

  hatch: async (seed?: string) => {
    try {
      const data = await window.electronAPI.buddy.hatch(seed)
      set({
        enabled: true,
        muted: Boolean(data?.muted),
        name: data?.name || 'Buddy',
        persona: data?.persona || 'pair programmer',
        emoji: data?.emoji || '🧠',
        mood: (data?.mood || 'happy') as BuddyMood,
        bubbleText: `Hi，我是 ${data?.name || 'Buddy'}，现在开始伴随你开发。`,
        bubbleVisible: true,
        bubbleOpacity: 1,
        species: (data?.species as Species) || null,
        rarity: (data?.rarity as Rarity) || null,
        shiny: Boolean(data?.shiny),
        hat: data?.hat || null,
        eye: data?.eye || null,
        stats: data?.stats || null,
        petAt: data?.petAt ?? null,
        showTeaser: false,
      })
      hideBubbleWithFade()
    } catch (error) {
      // User-initiated: "启动伴随式 AI 角色" button. They deserve feedback.
      reportUserActionError('孵化 Buddy', error)
    }
  },

  setSpecies: async (species: Species) => {
    try {
      const data = await window.electronAPI.buddy.setSpecies(species)
      set({
        enabled: true,
        muted: Boolean(data?.muted),
        name: data?.name || 'Buddy',
        persona: data?.persona || 'pair programmer',
        emoji: data?.emoji || '🧠',
        mood: (data?.mood || 'happy') as BuddyMood,
        species: (data?.species as Species) || null,
        rarity: (data?.rarity as Rarity) || null,
        shiny: Boolean(data?.shiny),
        hat: data?.hat || null,
        eye: data?.eye || null,
        stats: data?.stats || null,
        petAt: data?.petAt ?? null,
        bubbleText: `已切换为 ${data?.species || species} 形态`,
        bubbleVisible: true,
        bubbleOpacity: 1,
      })
      hideBubbleWithFade()
    } catch (error) {
      reportUserActionError('切换 Buddy 形态', error)
    }
  },

  toggleEnabled: async () => {
    const next = !get().enabled
    try {
      const data = await window.electronAPI.buddy.update({ enabled: next })
      set({ enabled: Boolean(data?.enabled) })
    } catch (error) {
      reportUserActionError('Buddy 开关', error)
    }
  },

  toggleMuted: async () => {
    const next = !get().muted
    try {
      const data = await window.electronAPI.buddy.update({ muted: next })
      set({ muted: Boolean(data?.muted) })
    } catch (error) {
      // Small preference — log only.
      reportUserActionError('Buddy 静音', error, { silent: true })
    }
  },

  setMood: async (mood: BuddyMood) => {
    try {
      await window.electronAPI.buddy.update({ mood })
      set({ mood })
    } catch (error) {
      reportUserActionError('Buddy 心情', error, { silent: true })
    }
  },

  applyPersona: async (index: number) => {
    const p = PERSONAS[index]
    if (!p) return
    try {
      await window.electronAPI.buddy.update({ persona: p.persona, emoji: p.emoji })
      set({ persona: p.persona, emoji: p.emoji })
    } catch (error) {
      reportUserActionError('Buddy 人设', error, { silent: true })
    }
  },

  updateName: async (name: string) => {
    if (!name.trim()) return
    try {
      await window.electronAPI.buddy.update({ name: name.trim() })
      set({ name: name.trim() })
    } catch (error) {
      reportUserActionError('Buddy 改名', error, { silent: true })
    }
  },

  openSettings: () => {
    set({ settingsOpen: true })
  },

  closeSettings: () => {
    set({ settingsOpen: false })
  },

  applyStreamEvent: (event: BuddyStreamEvent) => {
    if (!event || event.type !== 'buddy_event') return

    const state = event.state || {}
    set({
      enabled: state.enabled ?? get().enabled,
      muted: state.muted ?? get().muted,
      name: state.name ?? get().name,
      persona: state.persona ?? get().persona,
      emoji: state.emoji ?? get().emoji,
      mood: (event.mood || state.mood || 'idle') as BuddyMood,
      bubbleText: event.text || '',
      bubbleVisible: Boolean(event.text),
      bubbleOpacity: 1,
      species: state.species || get().species,
      rarity: state.rarity || get().rarity,
      shiny: state.shiny ?? get().shiny,
      hat: state.hat || get().hat,
      eye: state.eye || get().eye,
      stats: state.stats || get().stats,
    })

    if (event.text) {
      hideBubbleWithFade()
    }
  },

  startAnimation: () => {
    if (animationInterval) return

    animationInterval = setInterval(() => {
      void window.electronAPI.buddy.tick()
        .then((runtime) => {
          if (!runtime) return
          const prev = get()
          set({
            tickCount: runtime.tick ?? prev.tickCount + 1,
            spriteFrame: runtime.frame ?? 0,
            isBlinking: Boolean(runtime.blink),
            petAt: runtime.petAt ?? prev.petAt,
            bubbleVisible: prev.bubbleVisible ? Boolean(runtime.showBubble) : prev.bubbleVisible,
          })
        })
        .catch(() => {
          const { tickCount } = get()
          const newTick = tickCount + 1
          const frameIdx = IDLE_SEQUENCE[newTick % IDLE_SEQUENCE.length]
          const frame = frameIdx < 0 ? 0 : frameIdx
          const blinking = frameIdx === -1
          set({
            tickCount: newTick,
            spriteFrame: frame,
            isBlinking: blinking,
          })
        })

      // Clear pet hearts older than 2.5s
      const now = Date.now()
      const hearts = get().petHearts.filter((h) => now - h.startTime < BUDDY_PET_HEART_LIFETIME_MS)
      if (hearts.length !== get().petHearts.length) {
        set({ petHearts: hearts })
      }
    }, TICK_MS)
  },

  stopAnimation: () => {
    if (animationInterval) {
      clearInterval(animationInterval)
      animationInterval = null
    }
  },

  petBuddy: () => {
    void window.electronAPI.buddy.pet().catch(() => {})
    const hearts: PetHeart[] = []
    for (let i = 0; i < 5; i++) {
      hearts.push({
        id: petHeartCounter++,
        x: 20 + Math.random() * 20,
        y: -10 - Math.random() * 20,
        emoji: ['❤️', '💕', '💛', '💖', '💗'][i],
        startTime: Date.now() + i * 500,
      })
    }
    set({ petHearts: hearts, petting: true })
    setTimeout(() => set({ petting: false }), BUDDY_PET_HEART_LIFETIME_MS)
  },

  dismissTeaser: () => {
    set({ showTeaser: false, teaserDismissed: true })
  },

  showTeaserNotification: () => {
    if (get().teaserDismissed) return
    set({ showTeaser: true })
    // Auto-dismiss after 15s
    setTimeout(() => {
      set({ showTeaser: false })
    }, BUDDY_TEASER_AUTO_DISMISS_MS)
  },
}))

export { RAINBOW_COLORS, SPECIES_EMOJI, SPECIES, RARITY_STARS, RARITY_COLORS }
export type { Species }
