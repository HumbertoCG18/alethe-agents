/**
 * Each place that works in a project's folder uses the checkout the project picked, not the folder
 * it was created in: here the project sits on a worktree (`defaultCwd`) and picked main.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isProjectFolder } from '../lib/projectCheckout'
import { listClaudeSessions, prepareAgentHandoff } from '../lib/tauri'
import { EMPTY_PROJECTS_FILE } from '../lib/types'
import { GitTab } from '../plugins/git-control/GitTabs'
import { useMcpStore } from '../stores/mcpStore'
import { getProjectDefaultCwd, useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'
import { McpPanel } from './McpPanel'
import { AddContentModal } from './modals/AddContentModal'
import { EditProjectModal } from './modals/EditProjectModal'
import { HandoffModal } from './modals/HandoffModal'
import { RecentChatsModal } from './modals/RecentChatsModal'
import { NoWorkspace } from './WorkspaceView'

const WORKTREE = 'C:\\repo-night'
const MAIN = 'C:\\repo'

/** Shows the cwd a child receives. */
const cwdProbe = vi.hoisted(() => ({ cwd }: { cwd: string }) => <div data-testid="cwd">{cwd}</div>)

vi.mock('../lib/terminalLifecycle', () => ({ cleanupPtys: vi.fn() }))
vi.mock('../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/tauri')>()),
  prepareAgentHandoff: vi.fn(() => new Promise(() => {})),
  listClaudeSessions: vi.fn(async () => []),
}))
vi.mock('../plugins/git-control/GitControl', () => ({ GitControl: cwdProbe }))
vi.mock('./modals/EditProjectAgentSettings', () => ({ EditProjectAgentSettings: cwdProbe }))

let projectId = ''

beforeEach(() => {
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: false })
  useUiStore.getState().closeModal()
  const store = useProjectsStore.getState()
  projectId = store.createProject({ name: 'Tutor', defaultCwd: WORKTREE }).id
  store.setProjectCheckout(projectId, MAIN)
  useProjectsStore.setState({ activeProjectId: projectId })
})
afterEach(cleanup)

const project = () => useProjectsStore.getState().projects[0]

describe('places that work in the project folder use its chosen checkout', () => {
  it('HandoffModal prepares the handoff there', async () => {
    useUiStore.getState().openModal_('handoff', { projectId, agent: 'claude' })
    render(<HandoffModal />)

    await waitFor(() =>
      expect(prepareAgentHandoff).toHaveBeenCalledWith(expect.objectContaining({ cwd: MAIN })),
    )
  })

  it('RecentChatsModal lists the sessions there', async () => {
    useUiStore.getState().openModal_('recentChats', { projectId })
    render(<RecentChatsModal />)

    await waitFor(() => expect(listClaudeSessions).toHaveBeenCalledWith(MAIN))
  })

  it('GitTab shows Source Control for it', () => {
    render(<GitTab projectId={projectId} cwd={null} ptyId={null} terminalName={null} />)

    expect(screen.getByTestId('cwd').textContent).toBe(MAIN)
  })

  it('McpPanel reads the project servers from it', async () => {
    const refresh = vi.fn(async () => {})
    useMcpStore.setState({ refresh })
    render(<McpPanel />)

    await waitFor(() =>
      expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ repo: MAIN })),
    )
  })

  it('AddContentModal opens the orchestrator there', () => {
    const createOrchestratorPane = vi.fn()
    useProjectsStore.setState({ createOrchestratorPane })
    useProjectsStore.getState().setPreferences({
      enabledFeatures: {
        ...useProjectsStore.getState().preferences.enabledFeatures,
        orchestrator: true,
      },
    })
    useUiStore.getState().openModal_('addContent', { projectId })
    render(<AddContentModal />)
    fireEvent.click(screen.getByRole('button', { name: /orchestrat/i }))

    expect(createOrchestratorPane).toHaveBeenCalledWith(projectId, MAIN)
  })

  it('EditProjectModal hands it to the agent settings', () => {
    useUiStore.getState().openModal_('editProject', { projectId })
    render(<EditProjectModal />)
    fireEvent.click(screen.getByRole('button', { name: /agents/i }))

    expect(screen.getByTestId('cwd').textContent).toBe(MAIN)
  })

  it('the empty workspace offers it, and knows it as the project own folder', () => {
    const { rerender } = render(
      <NoWorkspace project={project()} group={null} onAddTerminal={vi.fn()} />,
    )
    // The folder card shows once no project is open; it keeps the folder offered before.
    rerender(<NoWorkspace project={null} group={null} onAddTerminal={vi.fn()} />)
    const offered = screen.getByTitle(/repo/).getAttribute('title') ?? ''

    expect(offered).toBe(MAIN)
    expect(isProjectFolder(project(), offered)).toBe(true)
    expect(isProjectFolder(project(), `${MAIN}\\`)).toBe(true)
    expect(isProjectFolder(project(), WORKTREE)).toBe(false)
    expect(isProjectFolder(null, offered)).toBe(false)
    expect(getProjectDefaultCwd(project())).toBe(MAIN)
  })
})
