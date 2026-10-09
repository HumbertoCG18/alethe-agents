import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_PROJECTS_FILE } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { ProjectSidebar } from '.'

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}))
vi.mock('../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/tauri')>()),
  worktreeCheckouts: vi.fn(async () => {
    throw new Error('not_a_git_repository')
  }),
}))
vi.mock('../SidebarNowPlaying', () => ({ SidebarNowPlaying: () => null }))
vi.mock('../UserProfile', () => ({ UserProfile: () => null }))
vi.mock('./SidebarMergePanel', () => ({ SidebarMergePanel: () => null }))
vi.mock('./SidebarUpdate', () => ({ SidebarUpdate: () => null }))
/** Shows the cwd the explorer is rooted at. */
vi.mock('./FileExplorer', () => ({
  FileExplorer: ({ cwd }: { cwd: string }) => <div data-testid="explorer">{cwd}</div>,
}))

beforeEach(() => {
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: false })
  useUiStore.setState({ leftSidebarTab: 'files' })
})
afterEach(cleanup)

function activate(input: { name?: string; checkoutPath?: string; terminalCwd?: string }) {
  const store = useProjectsStore.getState()
  const id = store.createProject({ name: input.name ?? 'Tutor' }).id
  if (input.checkoutPath) store.setProjectCheckout(id, input.checkoutPath)
  if (input.terminalCwd) {
    store.createTerminal(id, {
      name: 'Shell',
      cwd: input.terminalCwd,
      firstTab: { type: 'shell', cwd: input.terminalCwd },
    })
  }
  useProjectsStore.setState({ activeProjectId: id })
}

describe.each(['normal', 'clean'] as const)('Files tab (%s style)', (visualStyle) => {
  beforeEach(() => {
    useProjectsStore.getState().setPreferences({ visualStyle })
  })

  it('roots the explorer at the project folder when there is no terminal', () => {
    activate({ checkoutPath: 'C:/repo' })
    render(<ProjectSidebar />)

    expect(screen.getByTestId('explorer')).toHaveTextContent('C:/repo')
  })

  it('keeps the terminal cwd when there is a terminal', () => {
    activate({ checkoutPath: 'C:/repo', terminalCwd: 'C:/repo/sub' })
    render(<ProjectSidebar />)

    expect(screen.getByTestId('explorer')).toHaveTextContent('C:/repo/sub')
  })

  it('shows a Files empty state, not the "no projects" copy, when there is no folder', () => {
    activate({})
    render(<ProjectSidebar />)

    expect(screen.queryByTestId('explorer')).toBeNull()
    expect(screen.getByText('No folder to browse')).toBeInTheDocument()
    expect(screen.queryByText('No projects yet')).toBeNull()
  })

  it("never browses another project's folder, even one in the same group", () => {
    const store = useProjectsStore.getState()
    const group = store.createGroup('Work')
    const other = store.createProject({ name: 'Other', groupId: group.id }).id
    store.createTerminal(other, {
      name: 'Shell',
      cwd: 'C:/other',
      firstTab: { type: 'shell', cwd: 'C:/other' },
    })
    const empty = store.createProject({ name: 'Empty', groupId: group.id }).id
    useProjectsStore.setState({ activeProjectId: empty })
    render(<ProjectSidebar />)

    expect(screen.queryByTestId('explorer')).toBeNull()
    expect(screen.getByText('No folder to browse')).toBeInTheDocument()
  })
})
