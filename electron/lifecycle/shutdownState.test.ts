import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginAppShutdown,
  isAppShutdownInProgress,
  requestAppQuitFromWindowClose,
  resetAppShutdownStateForTests,
} from './shutdownState'

describe('shutdown state', () => {
  beforeEach(() => {
    resetAppShutdownStateForTests()
  })

  it('starts shutdown once', () => {
    expect(beginAppShutdown()).toBe(true)
    expect(beginAppShutdown()).toBe(false)
    expect(isAppShutdownInProgress()).toBe(true)
  })

  it('routes a user window close through app.quit', () => {
    const preventDefault = vi.fn()
    const quit = vi.fn()

    requestAppQuitFromWindowClose({ preventDefault }, quit)

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(quit).toHaveBeenCalledOnce()
  })

  it('allows the window to close after shutdown begins', () => {
    const preventDefault = vi.fn()
    const quit = vi.fn()
    beginAppShutdown()

    requestAppQuitFromWindowClose({ preventDefault }, quit)

    expect(preventDefault).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
  })
})
