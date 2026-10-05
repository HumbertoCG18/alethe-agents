import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionChange, SessionKey, SessionRead } from '../lib/tauri'

const events = vi.hoisted(() => ({ emit: (_change: SessionChange) => {} }))

vi.mock('../lib/tauri', () => ({
  sessionRead: vi.fn(),
  sessionSubscribe: vi.fn(async () => {}),
  sessionUnsubscribe: vi.fn(async () => {}),
  listenSessionChanged: vi.fn(async (handler: (change: SessionChange) => void) => {
    events.emit = handler
    return () => {}
  }),
}))

import { sessionRead, sessionSubscribe, sessionUnsubscribe } from '../lib/tauri'
import {
  refreshSession,
  retainSession,
  sessionKeyId,
  useSessionStore,
  useSessionTitle,
} from './sessionStore'

const read = vi.mocked(sessionRead)
const KEY: SessionKey = { provider: 'claude', cwd: 'C:\\repo', sessionId: 's-1' }

/** A read of s-1 at `revision`, saying `text`. */
const reply = (revision: number, text = `at ${revision}`, title: string | null = null) =>
  ({
    sessionId: 's-1',
    revision,
    unchanged: false,
    events: [{ role: 'assistant', text }],
    title,
  }) satisfies SessionRead

const held = () => useSessionStore.getState().sessions[sessionKeyId(KEY)]

beforeEach(() => useSessionStore.setState({ sessions: {} }))
afterEach(() => vi.clearAllMocks())

describe('session store', () => {
  it('reads and subscribes a session once for all who use it, and lets go with the last', async () => {
    read.mockResolvedValue(reply(5))
    const first = retainSession(KEY)
    const second = retainSession({ ...KEY })
    await waitFor(() => expect(held()?.revision).toBe(5))
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith(KEY)
    expect(sessionSubscribe).toHaveBeenCalledTimes(1)

    first()
    first()
    expect(sessionUnsubscribe).not.toHaveBeenCalled()
    second()
    expect(sessionUnsubscribe).toHaveBeenCalledExactlyOnceWith(KEY)
  })

  it('reads a subscribed session on from its revision when it changes, and only then', async () => {
    read.mockResolvedValueOnce(reply(5))
    const release = retainSession(KEY)
    await waitFor(() => expect(held()?.revision).toBe(5))

    read.mockResolvedValueOnce(reply(8, 'newer'))
    act(() => events.emit({ ...KEY, cwd: 'c:\\repo', revision: 8 }))
    await waitFor(() => expect(held()?.events[0].text).toBe('newer'))
    expect(read).toHaveBeenLastCalledWith({ ...KEY, since: 5 })

    // Already held, or another session: nothing to read.
    act(() => events.emit({ ...KEY, revision: 8 }))
    act(() => events.emit({ ...KEY, sessionId: 's-2', revision: 99 }))
    expect(read).toHaveBeenCalledTimes(2)
    release()
  })

  it('reads a session only once its changes are heard, so none is lost in between', async () => {
    // A fresh store: its change listener is not registered yet.
    vi.resetModules()
    const tauri = await import('../lib/tauri')
    const store = await import('./sessionStore')
    const backend = { revision: 5, listener: null as ((change: SessionChange) => void) | null }
    let register = () => {}
    vi.mocked(tauri.listenSessionChanged).mockImplementationOnce(
      (handler) =>
        new Promise((resolve) => {
          register = () => {
            backend.listener = handler
            resolve(() => {})
          }
        }),
    )
    vi.mocked(tauri.sessionRead).mockImplementation(async () => reply(backend.revision))
    const release = store.retainSession(KEY)
    await act(async () => {})

    // The transcript moves while the listener is still being registered: nobody hears it.
    backend.revision = 6
    backend.listener?.({ ...KEY, revision: 6 })
    register()
    await waitFor(() =>
      expect(store.useSessionStore.getState().sessions[store.sessionKeyId(KEY)]?.revision).toBe(6),
    )
    release()
  })

  it('keeps the newer of two overlapping reads, and what an unchanged read finds', async () => {
    let first: (value: SessionRead) => void = () => {}
    read.mockImplementationOnce(() => new Promise((resolve) => (first = resolve)))
    read.mockResolvedValueOnce(reply(9, 'newer'))
    const release = retainSession(KEY)
    refreshSession(KEY)
    await waitFor(() => expect(held()?.revision).toBe(9))
    await act(async () => first(reply(5, 'older')))
    expect(held()?.events[0].text).toBe('newer')

    read.mockResolvedValueOnce({ ...reply(9), unchanged: true, events: [] })
    refreshSession(KEY)
    await act(async () => {})
    expect(held()?.events[0].text).toBe('newer')
    release()
  })

  it('drops a released session but its title, and reads it whole when it is used again', async () => {
    read.mockResolvedValueOnce(reply(5, 'said', 'Fix the parser'))
    const used = retainSession(KEY)
    await waitFor(() => expect(held()?.revision).toBe(5))
    used()
    expect(held()).toEqual({ revision: 0, events: [], title: 'Fix the parser' })

    read.mockResolvedValueOnce(reply(7, 'again', 'Fix the parser'))
    const release = retainSession(KEY)
    await waitFor(() => expect(held()?.revision).toBe(7))
    expect(read).toHaveBeenLastCalledWith(KEY)
    release()
  })

  it('gives a component its session title, and reads nothing without a session', async () => {
    read.mockResolvedValue(reply(5, 'said', 'Fix the parser'))
    const titled = renderHook(() => useSessionTitle(KEY))
    await waitFor(() => expect(titled.result.current).toBe('Fix the parser'))
    titled.unmount()
    expect(sessionUnsubscribe).toHaveBeenCalledTimes(1)

    read.mockClear()
    expect(renderHook(() => useSessionTitle(null)).result.current).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })
})
