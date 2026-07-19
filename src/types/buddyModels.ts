export type BuddyMoodType = 'idle' | 'thinking' | 'focused' | 'happy' | 'warn' | 'sad'

export interface BuddyStateResponse {
  id: string
  name: string
  persona: string
  emoji: string
  enabled: boolean
  muted: boolean
  hatchedAt: string
  lastEventAt: string
  mood: BuddyMoodType
  species?: string | null
  rarity?: string | null
  eye?: string | null
  hat?: string | null
  shiny?: boolean
  stats?: Record<string, number> | null
  petAt?: number | null
}

export interface BuddyTickResult {
  tick: number
  frame: number
  blink: boolean
  showBubble: boolean
  petAt: number | null
}
