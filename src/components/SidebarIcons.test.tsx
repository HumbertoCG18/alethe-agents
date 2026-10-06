import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_PROJECTS_FILE, type Preferences } from '../lib/types'
import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'
import { ProjectSidebar } from './ProjectSidebar'
import { RightSidebar } from './RightSidebar'

const stub = vi.hoisted(() => (name: string) => () => <div data-testid={name} />)

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}))
vi.mock('../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/tauri')>()),
  listProjectPlans: vi.fn(async () => []),
  readPlanningStatus: vi.fn(async () => null),
  worktreeCheckouts: vi.fn(async () => {
    throw new Error('not_a_git_repository')
  }),
}))
vi.mock('./McpPanel', () => ({ McpPanel: stub('mcp') }))
vi.mock('./PluginsSidebar', () => ({ PluginsSidebar: stub('plugins') }))
vi.mock('./PullRequestsSidebar', () => ({ PullRequestsSidebar: stub('prs') }))
vi.mock('./VoiceHistoryPanel', () => ({ VoiceHistoryPanel: stub('jev') }))
vi.mock('./SidebarNowPlaying', () => ({ SidebarNowPlaying: stub('now-playing') }))
vi.mock('./UserProfile', () => ({ UserProfile: stub('profile') }))
vi.mock('./ProjectSidebar/FileExplorer', () => ({ FileExplorer: stub('files') }))
vi.mock('./ProjectSidebar/SidebarMergePanel', () => ({ SidebarMergePanel: stub('merge') }))
vi.mock('./ProjectSidebar/SidebarUpdate', () => ({ SidebarUpdate: stub('update') }))

function arrange(
  sidebarIcons: Preferences['sidebarIcons'],
  visualStyle: Preferences['visualStyle'] = 'normal',
) {
  useProjectsStore.getState().setPreferences({ sidebarIcons, visualStyle })
}

/** Names of the given controls, in document order. */
const names = (elements: HTMLElement[]) =>
  elements.map((element) => element.getAttribute('aria-label') ?? element.textContent)

beforeEach(() => {
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: false })
  useUiStore.getState().showMarkdownSidebar()
})
afterEach(cleanup)

describe('sidebar icons in the bars', () => {
  it('renders the right bar in the saved order without hidden icons', () => {
    arrange({ left: [], right: ['plugins', 'markdown'], hidden: ['jev'] })
    render(<RightSidebar />)

    expect(names(screen.getAllByRole('tab'))).toEqual(['Plugins', 'Markdown', 'MCP', 'PRs'])
  })

  it('still shows a hidden view opened without its icon', () => {
    arrange({ left: [], right: [], hidden: ['jev'] })
    useUiStore.getState().setRightSidebarMode('jev')
    render(<RightSidebar />)

    expect(screen.getByTestId('jev')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Jev' })).not.toBeInTheDocument()
  })

  it.each(['normal', 'clean'] as const)('renders the %s left bar the same way', (visualStyle) => {
    arrange({ left: ['files', 'projects'], hidden: [], right: [] }, visualStyle)
    const { unmount } = render(<ProjectSidebar />)
    const files = screen.getByRole(visualStyle === 'normal' ? 'tab' : 'button', { name: 'Files' })
    const projects = screen.getByRole(visualStyle === 'normal' ? 'tab' : 'button', {
      name: 'Projects',
    })
    expect(files.compareDocumentPosition(projects) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    unmount()

    arrange({ left: [], right: [], hidden: ['files'] }, visualStyle)
    render(<ProjectSidebar />)
    expect(
      screen.queryByRole(visualStyle === 'normal' ? 'tab' : 'button', { name: 'Files' }),
    ).toBeNull()
    expect(
      screen.getByRole(visualStyle === 'normal' ? 'tab' : 'button', { name: 'Home' }),
    ).toBeInTheDocument()
  })
})
