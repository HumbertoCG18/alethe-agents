/** Tracks whether the window is focused and visible, and notifies on inactive to active. */
export function createActivityTracker() {
  let active = true
  const listeners = new Set<() => void>()
  return {
    isActive: () => active,
    set(next: boolean) {
      const activated = next && !active
      active = next
      if (activated) listeners.forEach((cb) => cb())
    },
    onActivate(cb: () => void) {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
  }
}
