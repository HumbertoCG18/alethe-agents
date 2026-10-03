import { unwatchFile, watchFile } from '../../lib/tauri'

/**
 * The paths one effect watches. The backend counts references, so each acquisition is released
 * exactly once, and only after its registration has resolved: releasing a pending one early
 * would drop the reference of whichever instance registers the same path next.
 */
export function createWatchSet() {
  const held = new Map<string, { ready: boolean; released: boolean }>()
  const has = (path: string) => held.has(path)
  const watch = (path: string) => {
    if (held.has(path)) return
    const state = { ready: false, released: false }
    held.set(path, state)
    watchFile(path).then(
      () => {
        state.ready = true
        if (state.released) void unwatchFile(path).catch(() => {})
      },
      // Failed (the path is missing): not held, so the next reload tries again.
      () => {
        if (held.get(path) === state) held.delete(path)
      },
    )
  }
  const unwatch = (path: string) => {
    const state = held.get(path)
    if (!state) return
    held.delete(path)
    state.released = true
    if (state.ready) void unwatchFile(path).catch(() => {})
  }
  const clear = () => [...held.keys()].forEach(unwatch)
  return { has, watch, unwatch, clear }
}
