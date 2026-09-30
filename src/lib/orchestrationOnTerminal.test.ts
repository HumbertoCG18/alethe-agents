import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectsStore } from '../stores/projectsStore'
import { recordClaudeLaunch } from './claudeMcpConfigs'
import { startOrchestrationOn } from './orchestrationOnTerminal'
import { EMPTY_PROJECTS_FILE } from './types'

vi.mock('./terminalLifecycle', () => ({ cleanupPtys: vi.fn() }))

const store = () => useProjectsStore.getState()

function claudeTerminal(orchestrator: boolean) {
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: false })
  const { preferences } = store()
  store().setPreferences({ enabledFeatures: { ...preferences.enabledFeatures, orchestrator } })
  const project = store().createProject({ name: 'App' })
  const terminal = store().createTerminal(project.id, {
    name: 'Claude',
    cwd: 'C:\\repo',
    firstTab: { type: 'claude', cwd: 'C:\\repo' },
  })
  store().addTerminalToWorkspace(project.id, terminal.id)
  const ptyId = `pty-${terminal.id}`
  recordClaudeLaunch(ptyId, orchestrator)
  return { projectId: project.id, terminalId: terminal.id, ptyId, cwd: 'C:\\repo' }
}

const boards = (projectId: string, terminalId: string) =>
  (store().projects.find((p) => p.id === projectId)?.paneGroups ?? []).filter(
    (group) => group.kind === 'orchestration' && group.paneIds[0] === terminalId,
  )

let confirmRestart: ReturnType<typeof vi.fn>

/** A restart that brings Claude back, the way relaunchAgentPty records a launch that went through. */
const restartWithTools = (ptyId: string) =>
  vi.fn(async () => {
    recordClaudeLaunch(ptyId, true)
    return true
  })

beforeEach(() => {
  confirmRestart = vi.fn(async () => true)
})

afterEach(() => {
  vi.useRealTimers()
})

// Turning an open Claude conversation into a planner (#248).
describe('startOrchestrationOn', () => {
  it('puts a board next to a terminal launched with the orchestrator tools', async () => {
    const target = claudeTerminal(true)
    const restart = restartWithTools(target.ptyId)

    expect(await startOrchestrationOn({ ...target, confirmRestart, restart })).toBe('ready')

    expect(boards(target.projectId, target.terminalId)).toHaveLength(1)
    expect(confirmRestart).not.toHaveBeenCalled()
    expect(restart).not.toHaveBeenCalled()
  })

  it('restarts a conversation started without them, once the user agrees', async () => {
    const target = claudeTerminal(false)
    const restart = restartWithTools(target.ptyId)

    expect(await startOrchestrationOn({ ...target, confirmRestart, restart })).toBe('ready')

    expect(store().preferences.enabledFeatures.orchestrator).toBe(true)
    expect(restart).toHaveBeenCalledTimes(1)
    expect(boards(target.projectId, target.terminalId)).toHaveLength(1)
  })

  it('leaves the terminal and the feature alone when the user declines', async () => {
    const target = claudeTerminal(false)
    const restart = restartWithTools(target.ptyId)
    confirmRestart.mockResolvedValue(false)

    expect(await startOrchestrationOn({ ...target, confirmRestart, restart })).toBe('declined')

    expect(restart).not.toHaveBeenCalled()
    expect(boards(target.projectId, target.terminalId)).toHaveLength(0)
    expect(store().preferences.enabledFeatures.orchestrator).toBe(false)
  })

  it('adds no board when the restart fails', async () => {
    const target = claudeTerminal(false)
    const restart = vi.fn(async () => false)

    expect(await startOrchestrationOn({ ...target, confirmRestart, restart })).toBe('failed')

    expect(boards(target.projectId, target.terminalId)).toHaveLength(0)
  })

  it('adds no board when Claude never comes back with the tools', async () => {
    vi.useFakeTimers()
    const target = claudeTerminal(false)
    const restart = vi.fn(async () => true)

    const started = startOrchestrationOn({ ...target, confirmRestart, restart })
    await vi.advanceTimersByTimeAsync(30_000)

    expect(await started).toBe('failed')
    expect(boards(target.projectId, target.terminalId)).toHaveLength(0)
  })

  it('restarts once and adds one board when asked twice at the same time', async () => {
    const target = claudeTerminal(false)
    const restart = restartWithTools(target.ptyId)

    const results = await Promise.all([
      startOrchestrationOn({ ...target, confirmRestart, restart }),
      startOrchestrationOn({ ...target, confirmRestart, restart }),
    ])

    expect(results.sort()).toEqual(['busy', 'ready'])
    expect(restart).toHaveBeenCalledTimes(1)
    expect(boards(target.projectId, target.terminalId)).toHaveLength(1)
  })

  it('does not add a second board to a terminal that already has one', async () => {
    const target = claudeTerminal(true)
    const restart = restartWithTools(target.ptyId)
    await startOrchestrationOn({ ...target, confirmRestart, restart })

    expect(await startOrchestrationOn({ ...target, confirmRestart, restart })).toBe('ready')

    expect(boards(target.projectId, target.terminalId)).toHaveLength(1)
  })
})
