import { beforeEach, describe, expect, it, vi } from 'vitest'

import { cleanupPtys } from '../lib/terminalLifecycle'
import { EMPTY_PROJECTS_FILE } from '../lib/types'
import { useProjectsStore } from './projectsStore'

vi.mock('../lib/terminalLifecycle', () => ({ cleanupPtys: vi.fn() }))

const store = () => useProjectsStore.getState()
const project = (id: string) => store().projects.find((item) => item.id === id)!
const paneIds = (projectId: string) =>
  store().workspace.containers.find((container) => container.projectId === projectId)?.paneIds ?? []
const groupsOf = (projectId: string) => project(projectId).paneGroups ?? []
const createTerminal = (projectId: string, name: string) =>
  store().createTerminal(projectId, {
    name,
    cwd: 'C:\\repo',
    firstTab: { type: 'shell', cwd: 'C:\\repo' },
  })

/** What the new-terminal flow builds for an orchestration planner: the planner, then its board. */
function orchestration() {
  const p = store().createProject({ name: 'App' })
  const planner = createTerminal(p.id, 'Planner')
  store().addTerminalToWorkspace(p.id, planner.id)
  const board = store().createOrchestratorPane(p.id, 'C:\\repo')
  store().groupPanes(p.id, [planner.id, board.id], { kind: 'orchestration' })
  return { projectId: p.id, planner, board }
}

beforeEach(() => {
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: false })
  vi.clearAllMocks()
})

// A group is drawn through its first member, so a pane that only the group shows must leave the
// group to disappear (#241).
describe('closing a grouped pane', () => {
  it('closes the orchestration pane and keeps its planner', () => {
    const { projectId, planner, board } = orchestration()

    store().closePane(projectId, board.id)

    expect(groupsOf(projectId).some((group) => group.paneIds.includes(board.id))).toBe(false)
    expect(paneIds(projectId)).toEqual([planner.id])
    expect(cleanupPtys).toHaveBeenCalledTimes(1)
  })

  it('also closes it once the container no longer lists it', () => {
    const { projectId, planner, board } = orchestration()
    // The saved state from the report: only the group kept the board on screen.
    store().closePane(projectId, board.id)
    store().groupPanes(projectId, [planner.id, board.id], { kind: 'orchestration' })
    expect(paneIds(projectId)).toEqual([planner.id])

    store().closePane(projectId, board.id)

    expect(groupsOf(projectId)).toEqual([])
  })

  it('keeps the rest of the group on screen when its first pane closes', () => {
    const { projectId, planner, board } = orchestration()
    const extra = createTerminal(projectId, 'Extra')
    store().groupPanes(projectId, [planner.id, extra.id])

    store().closePane(projectId, planner.id)

    expect(groupsOf(projectId)).toEqual([
      expect.objectContaining({ paneIds: [board.id, extra.id], kind: 'orchestration' }),
    ])
    expect(paneIds(projectId)).toContain(board.id)
    expect(paneIds(projectId)).not.toContain(planner.id)
  })

  it('hands the first pane’s place to the next one when only the group showed it', () => {
    const { projectId, planner, board } = orchestration()
    store().closePane(projectId, board.id)
    store().groupPanes(projectId, [planner.id, board.id], { kind: 'orchestration' })
    expect(paneIds(projectId)).toEqual([planner.id])

    store().closePane(projectId, planner.id)

    expect(paneIds(projectId)).toEqual([board.id])
    expect(groupsOf(projectId)).toEqual([])
  })
})
