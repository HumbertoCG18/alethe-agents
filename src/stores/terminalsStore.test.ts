import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PtyStatus } from '../lib/types'
import {
  anyTabWorking,
  IO_TIMESTAMP_THROTTLE_MS,
  type PtyRuntime,
  useTerminalsStore,
} from './terminalsStore'

describe('terminals runtime activity', () => {
  afterEach(() => {
    vi.useRealTimers()
    useTerminalsStore.getState().reset()
  })

  it('coalesces high-frequency PTY activity timestamps', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const store = useTerminalsStore.getState()
    store.registerPty('pty-1')
    const initialRuntime = useTerminalsStore.getState().byPtyId['pty-1']

    store.recordIo('pty-1')
    vi.advanceTimersByTime(IO_TIMESTAMP_THROTTLE_MS - 1)
    store.recordIo('pty-1')

    expect(useTerminalsStore.getState().byPtyId['pty-1']).toBe(initialRuntime)

    vi.advanceTimersByTime(1)
    store.recordIo('pty-1')

    const updatedRuntime = useTerminalsStore.getState().byPtyId['pty-1']
    expect(updatedRuntime).not.toBe(initialRuntime)
    expect(updatedRuntime.lastIoAt - initialRuntime.lastIoAt).toBe(IO_TIMESTAMP_THROTTLE_MS)
  })
})

describe('anyTabWorking', () => {
  const runtime = (status: PtyStatus) => ({ status }) as PtyRuntime
  const byPtyId = { a: runtime('waiting'), b: runtime('working'), c: runtime('stopped') }

  it('is true only while one of the tabs has a working pty', () => {
    expect(anyTabWorking([{ ptyId: 'a' }, { ptyId: 'b' }], byPtyId)).toBe(true)
    expect(anyTabWorking([{ ptyId: 'a' }, { ptyId: 'c' }], byPtyId)).toBe(false)
    // No pty yet, or one the store no longer knows.
    expect(anyTabWorking([{ ptyId: null }, { ptyId: 'gone' }, { ptyId: '' }], byPtyId)).toBe(false)
    expect(anyTabWorking([], byPtyId)).toBe(false)
  })
})
