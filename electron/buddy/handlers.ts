import type { IpcMain } from 'electron'
import * as buddy from './service'
import type { BuddyState } from './service'
import type { Species } from './types'
import { SPECIES } from './types'

function isSpecies(s: string): s is Species {
  return (SPECIES as readonly string[]).includes(s)
}

export function registerBuddyHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('buddy:get', () => buddy.getBuddyState())

  ipcMain.handle('buddy:hatch', (_event, seed?: string) => buddy.hatchBuddy(seed))

  ipcMain.handle('buddy:set-species', (_event, species: string) => {
    if (!isSpecies(species)) {
      return buddy.getBuddyState()
    }
    return buddy.setBuddySpecies(species)
  })

  ipcMain.handle(
    'buddy:update',
    (
      _event,
      patch: Partial<
        Pick<BuddyState, 'enabled' | 'muted' | 'name' | 'persona' | 'emoji' | 'mood'>
      >,
    ) => buddy.updateBuddySettings(patch),
  )

  ipcMain.handle('buddy:tick', () => buddy.tickBuddyRuntime())

  ipcMain.handle('buddy:pet', () => {
    // Audit P1-6 (2026-05): return the post-pet `BuddyState` instead of the
    // ad-hoc `{ ok: true }` shape. `src/types/electronAPI.ts` declares this
    // handler as `() => Promise<BuddyStateResponse>` (same shape every other
    // `buddy:*` handler returns), and `useBuddyStore.petBuddy` currently
    // ignores the return value — but the type/runtime mismatch was a
    // foot-gun waiting to trip future consumers that DO read it.
    buddy.petBuddy()
    return buddy.getBuddyState()
  })
}
