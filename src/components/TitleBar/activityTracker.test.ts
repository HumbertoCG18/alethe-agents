import { describe, expect, it, vi } from 'vitest'

import { createActivityTracker } from './activityTracker'

describe('createActivityTracker', () => {
  it('starts active and does not notify when still active', () => {
    const tracker = createActivityTracker()
    const cb = vi.fn()
    tracker.onActivate(cb)
    tracker.set(true)
    expect(tracker.isActive()).toBe(true)
    expect(cb).not.toHaveBeenCalled()
  })

  it('notifies once on inactive to active transition', () => {
    const tracker = createActivityTracker()
    const cb = vi.fn()
    tracker.onActivate(cb)
    tracker.set(false)
    expect(cb).not.toHaveBeenCalled()
    tracker.set(true)
    tracker.set(true)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('stops notifying after unsubscribe', () => {
    const tracker = createActivityTracker()
    const cb = vi.fn()
    const off = tracker.onActivate(cb)
    off()
    tracker.set(false)
    tracker.set(true)
    expect(cb).not.toHaveBeenCalled()
  })
})
