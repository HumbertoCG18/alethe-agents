import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_PROJECTS_FILE } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { migrate } from '../../stores/projectsStore.migrations'
import { WorkspaceView } from '.'

vi.mock('../../lib/terminalLifecycle', () => ({ cleanupPtys: vi.fn() }))
vi.mock('./ProjectContainer', () => ({ ProjectContainer: () => null }))
vi.mock('./PaneArea', () => ({ PaneArea: () => null }))

const store = () => useProjectsStore.getState()
const createTerminal = (projectId: string) =>
  store().createTerminal(projectId, {
    name: 'Shell',
    cwd: 'C:\\repo',
    firstTab: { type: 'shell', cwd: 'C:\\repo' },
  })
/** Saves the store as projects.json would and loads it back, like `hydrate`. */
const reload = (saved: object) =>
  useProjectsStore.setState({ ...migrate(JSON.parse(JSON.stringify(saved))), hydrated: true })

beforeEach(() => {
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: false })
})
afterEach(cleanup)

describe('WorkspaceView on start', () => {
  it('keeps a restored project without terminals selected instead of opening another', () => {
    const b = store().createProject({ name: 'B' })
    createTerminal(b.id)
    store().openProjectWorkspace(b.id)
    const a = store().createProject({ name: 'A' })
    store().deleteTerminal(a.id, createTerminal(a.id).id)
    store().openProjectWorkspace(a.id)
    const tabA = store().workspace.activeTabId
    // The file saved before #97 lost the active project.
    reload({ ...store(), activeProjectId: null })
    expect(store().activeProjectId).toBe(a.id)

    render(<WorkspaceView />)
    expect(store().activeProjectId).toBe(a.id)
    expect(store().workspace.activeTabId).toBe(tabA)
    expect(store().workspace.containers).toEqual([])
  })

  it('opens a project with terminals when nothing is selected', () => {
    store().createProject({ name: 'A' })
    const b = store().createProject({ name: 'B' })
    createTerminal(b.id)
    reload({ ...store(), activeProjectId: null, workspace: EMPTY_PROJECTS_FILE.workspace })
    expect(store().activeProjectId).toBeNull()

    render(<WorkspaceView />)
    expect(store().activeProjectId).toBe(b.id)
    expect(store().workspace.containers.map((container) => container.projectId)).toEqual([b.id])
  })
})
