import { useEffect } from 'react'
import { create } from 'zustand'

import type { SessionEvent } from '../lib/sessionEvents'
import {
  listenSessionChanged,
  type SessionChange,
  type SessionKey,
  sessionRead,
  sessionSubscribe,
  sessionUnsubscribe,
} from '../lib/tauri'

/** What the session reader last gave for a session. */
export type SessionSnapshot = {
  /** 0 until a read lands, and again once nothing uses the session. */
  revision: number
  events: readonly SessionEvent[]
  title: string | null
}

/**
 * The Claude and Codex sessions in use, by `sessionKeyId`, fed by the session reader: read when
 * first used, then on from their revision each time `session://changed` says they moved. Only
 * what a read returns lands here, so a terminal's output re-renders nothing that reads it.
 */
export const useSessionStore = create<{ sessions: Readonly<Record<string, SessionSnapshot>> }>(
  () => ({ sessions: {} }),
)

export const sessionKeyId = (key: SessionKey): string =>
  [key.provider, key.cwd, key.sessionId].join('\t')

const keyOf = (id: string): SessionKey => {
  const [provider, cwd, sessionId] = id.split('\t')
  return { provider: provider as SessionKey['provider'], cwd, sessionId }
}

/** The sessions in use, with how many users hold each. */
const retained = new Map<string, { key: SessionKey; count: number }>()
let listening: Promise<unknown> | null = null

// The backend names a session by provider and id; its cwd may be spelled differently here.
function onChanged(change: SessionChange) {
  const { sessions } = useSessionStore.getState()
  for (const [id, { key }] of retained) {
    if (key.provider !== change.provider || key.sessionId !== change.sessionId) continue
    if ((sessions[id]?.revision ?? 0) < change.revision) refreshSession(key)
  }
}

/** Reads a session in use on from the revision held; a reply older than that one is dropped. */
export function refreshSession(key: SessionKey): void {
  const id = sessionKeyId(key)
  const since = useSessionStore.getState().sessions[id]?.revision
  sessionRead(since ? { ...key, since } : key).then(
    (read) => {
      if (read.unchanged || !retained.has(id)) return
      useSessionStore.setState((state) => {
        const held = state.sessions[id]
        if (held && read.revision <= held.revision) return state
        const { revision, events, title } = read
        return { sessions: { ...state.sessions, [id]: { revision, events, title } } }
      })
    },
    () => {},
  )
}

/** Uses a session: its first user reads and subscribes it. Returns the release of this use. */
export function retainSession(key: SessionKey): () => void {
  const id = sessionKeyId(key)
  const entry = retained.get(id)
  if (entry) entry.count += 1
  else {
    retained.set(id, { key, count: 1 })
    listening ??= listenSessionChanged(onChanged).catch(() => null)
    // The first read waits until changes are heard and sent, so none falls in between.
    void Promise.all([listening, sessionSubscribe(key).catch(() => {})]).then(() => {
      if (retained.has(id)) refreshSession(key)
    })
  }
  let released = false
  return () => {
    const held = retained.get(id)
    if (released || !held) return
    released = true
    held.count -= 1
    if (held.count > 0) return
    retained.delete(id)
    sessionUnsubscribe(key).catch(() => {})
    // Its title stays for the next use, which reads its events again.
    useSessionStore.setState((state) => {
      const session = state.sessions[id]
      if (!session) return state
      return {
        sessions: { ...state.sessions, [id]: { revision: 0, events: [], title: session.title } },
      }
    })
  }
}

/** Holds these sessions (by `sessionKeyId`) while the component is mounted. */
export function useRetainSessions(ids: readonly string[]): void {
  const joined = ids.join('\n')
  useEffect(() => {
    if (!joined) return
    const releases = joined.split('\n').map((id) => retainSession(keyOf(id)))
    return () => releases.forEach((release) => release())
  }, [joined])
}

/** A session's title, held while the component is mounted; null without a session. */
export function useSessionTitle(key: SessionKey | null): string | null {
  const id = key ? sessionKeyId(key) : ''
  useRetainSessions(id ? [id] : [])
  return useSessionStore((state) => (id ? (state.sessions[id]?.title ?? null) : null))
}
