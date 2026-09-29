import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAgentCanvasStore } from '../stores/agentCanvasStore'
import { startAgentCanvasMirror, useAgentCanvasMirror } from './agentCanvasMirror'
import { agentCanvasMirror, setAgentCanvasMirror } from './tauri'

const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>())

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler)
    return () => listeners.delete(name)
  }),
}))

vi.mock('./tauri', () => ({
  setAgentCanvasMirror: vi.fn(async () => undefined),
  agentCanvasMirror: vi.fn(async () => null),
}))

const startSubagent = (id: string) =>
  useAgentCanvasStore.getState().ingest({
    hook_event_name: 'SubagentStart',
    plannerId: 'pty-1',
    agent_id: id,
    agent_type: 'general-purpose',
  })

beforeEach(() => {
  useAgentCanvasStore.getState().clear()
  listeners.clear()
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

// A detached board shows the subagents the main window already knows, not only later ones (#247).
describe('agent canvas mirror', () => {
  it('publishes the main window canvas, then every change to it', async () => {
    vi.useFakeTimers()
    startSubagent('before-opening')
    startAgentCanvasMirror()
    const first = JSON.parse(String(vi.mocked(setAgentCanvasMirror).mock.calls[0][0]))
    expect(first.nodes.map((node: { id: string }) => node.id)).toEqual(['before-opening'])

    startSubagent('after-opening')
    await vi.advanceTimersByTimeAsync(1_000)
    const last = vi.mocked(setAgentCanvasMirror).mock.calls.at(-1)?.[0]
    expect(JSON.parse(String(last)).nodes.map((node: { id: string }) => node.id)).toEqual([
      'before-opening',
      'after-opening',
    ])
  })

  it('shows the published canvas in a detached board and keeps only the newest', async () => {
    const older = JSON.stringify({ seq: 1, nodes: [], tasks: {}, teamName: null, incarnations: {} })
    const newer = JSON.stringify({
      seq: 2,
      nodes: [{ id: 'from-main', status: 'running' }],
      tasks: {},
      teamName: null,
      incarnations: {},
    })
    let finishFetch: (value: string) => void = () => undefined
    vi.mocked(agentCanvasMirror).mockReturnValue(new Promise((resolve) => (finishFetch = resolve)))

    const { unmount } = renderHook(() => useAgentCanvasMirror())
    await vi.waitFor(() => expect(listeners.has('agent-canvas://mirror')).toBe(true))
    act(() => listeners.get('agent-canvas://mirror')?.({ payload: newer }))
    await act(async () => finishFetch(older))

    expect(useAgentCanvasStore.getState().nodes.map((node) => node.id)).toEqual(['from-main'])
    unmount()
  })
})
