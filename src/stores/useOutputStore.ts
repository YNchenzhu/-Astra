import { create } from 'zustand'

const MAX_ENTRIES_PER_CHANNEL = 500

export interface OutputEntry {
  timestamp: Date
  message: string
  type?: 'info' | 'warning' | 'error'
}

export interface OutputChannel {
  id: string
  label: string
  entries: OutputEntry[]
}

interface OutputState {
  channels: OutputChannel[]
  activeChannelId: string
  addEntry: (channelId: string, message: string, type?: 'info' | 'warning' | 'error') => void
  setActiveChannel: (channelId: string) => void
  clearChannel: (channelId: string) => void
  clearAll: () => void
}

export const useOutputStore = create<OutputState>((set) => ({
  channels: [
    { id: 'tasks', label: '任务', entries: [] },
    { id: 'lsp', label: '语言服务器', entries: [] },
    { id: 'app', label: '应用日志', entries: [] },
  ],
  activeChannelId: 'tasks',

  addEntry: (channelId, message, type = 'info') => {
    set((state) => ({
      channels: state.channels.map((ch) =>
        ch.id === channelId
          ? {
              ...ch,
              entries: [
                ...ch.entries,
                { timestamp: new Date(), message, type },
              ].slice(-MAX_ENTRIES_PER_CHANNEL),
            }
          : ch
      ),
    }))
  },

  setActiveChannel: (channelId) => {
    set({ activeChannelId: channelId })
  },

  clearChannel: (channelId) => {
    set((state) => ({
      channels: state.channels.map((ch) =>
        ch.id === channelId ? { ...ch, entries: [] } : ch
      ),
    }))
  },

  clearAll: () => {
    set((state) => ({
      channels: state.channels.map((ch) => ({ ...ch, entries: [] })),
    }))
  },
}))
