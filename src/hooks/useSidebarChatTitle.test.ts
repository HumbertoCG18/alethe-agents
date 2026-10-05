import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SubTab } from '../lib/types'

vi.mock('../lib/tauri', () => ({
  sessionRead: vi.fn(async () => ({
    sessionId: 's-1',
    revision: 5,
    unchanged: false,
    events: [],
    title: '  Fix\n  the parser ',
  })),
  sessionSubscribe: vi.fn(async () => {}),
  sessionUnsubscribe: vi.fn(async () => {}),
  listenSessionChanged: vi.fn(async () => () => {}),
}))

import { sessionRead } from '../lib/tauri'
import { useSessionStore } from '../stores/sessionStore'
import { useSidebarChatTitle } from './useSidebarChatTitle'

const tab = (partial: Partial<SubTab>) =>
  ({ id: 't-1', type: 'claude', name: 'claude', cwd: 'C:\\repo', ...partial }) as SubTab

beforeEach(() => useSessionStore.setState({ sessions: {} }))
afterEach(() => vi.clearAllMocks())

describe('useSidebarChatTitle', () => {
  it("shows a Claude row's session title on one line", async () => {
    const { result } = renderHook(() => useSidebarChatTitle(tab({ sessionId: 's-1' })))
    await waitFor(() => expect(result.current).toBe('Fix the parser'))
    expect(sessionRead).toHaveBeenCalledWith({
      provider: 'claude',
      cwd: 'C:\\repo',
      sessionId: 's-1',
    })
  })

  it('reads nothing for a row without a Claude session', async () => {
    const titleOf = (row: SubTab | undefined) =>
      renderHook(() => useSidebarChatTitle(row)).result.current
    expect(titleOf(tab({}))).toBeNull()
    expect(titleOf(tab({ type: 'codex', sessionId: 's-1' }))).toBeNull()
    expect(titleOf(undefined)).toBeNull()
    expect(sessionRead).not.toHaveBeenCalled()
  })
})
