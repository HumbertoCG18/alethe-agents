import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OrchestrationWindow } from './OrchestrationWindow'
import { useProjectsStore } from './stores/projectsStore'

const listeners = vi.hoisted(() => new Map<string, () => void>())

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: () => void) => {
    listeners.set(name, handler)
    return () => listeners.delete(name)
  }),
}))
vi.mock('./components/OrchestratorPane', () => ({ OrchestratorPane: () => null }))
vi.mock('./lib/agentCanvasMirror', () => ({ useAgentCanvasMirror: () => undefined }))

const hydrate = vi.fn(async () => undefined)

beforeEach(() => {
  listeners.clear()
  hydrate.mockClear()
  useProjectsStore.setState({ hydrate, hydrated: true })
})

afterEach(cleanup)

// The detached board reads projects.json once and again after the main window saves it, so new
// planners, restarts and deleted panes reach it (#247).
describe('OrchestrationWindow', () => {
  it('reads the projects again after the main window saves them, once per burst', async () => {
    render(<OrchestrationWindow terminalId="orchestrator-abc" />)
    await vi.waitFor(() => expect(listeners.has('projects://saved')).toBe(true))
    expect(hydrate).toHaveBeenCalledTimes(1)

    vi.useFakeTimers()
    try {
      // A busy main window saves every half second; each save would otherwise reread the file.
      await act(async () => {
        listeners.get('projects://saved')?.()
        await vi.advanceTimersByTimeAsync(500)
        listeners.get('projects://saved')?.()
      })
      expect(hydrate).toHaveBeenCalledTimes(1)

      await act(() => vi.advanceTimersByTimeAsync(500))
      expect(hydrate).toHaveBeenCalledTimes(2)

      await act(async () => {
        listeners.get('projects://saved')?.()
        await vi.advanceTimersByTimeAsync(1_000)
      })
      expect(hydrate).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })
})
