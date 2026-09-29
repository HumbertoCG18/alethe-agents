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

// The detached board reads projects.json once and again every time the main window saves it, so
// new planners, restarts and deleted panes reach it (#247).
describe('OrchestrationWindow', () => {
  it('reads the projects again whenever the main window saves them', async () => {
    render(<OrchestrationWindow terminalId="orchestrator-abc" />)
    await vi.waitFor(() => expect(listeners.has('projects://saved')).toBe(true))
    expect(hydrate).toHaveBeenCalledTimes(1)

    await act(async () => listeners.get('projects://saved')?.())

    expect(hydrate).toHaveBeenCalledTimes(2)
  })
})
