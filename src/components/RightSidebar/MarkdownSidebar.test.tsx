import { act, cleanup, configure, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'

import { readTextFile, writeClipboardText } from '../../lib/tauri'
import { EMPTY_PROJECTS_FILE } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { RightSidebar } from './index'
vi.mock('../../lib/markdownSummary', async (original) => ({
  ...(await original<typeof import('../../lib/markdownSummary')>()),
  summarizeMarkdown: vi.fn((_path: string, content: string) => ({
    promise: Promise.resolve(content),
    release: vi.fn(),
  })),
  openMarkdownReader: vi.fn(async () => {}),
}))
const stub = vi.hoisted(() => (name: string) => () => <div data-testid={name} />)

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}))
vi.mock('../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/tauri')>()),
  readTextFile: vi.fn(),
  watchFile: vi.fn(async () => {}),
  unwatchFile: vi.fn(async () => {}),
  listenFileChanged: vi.fn(async () => () => {}),
  writeClipboardText: vi.fn(async () => {}),
  listProjectPlans: vi.fn(async () => []),
  readPlanningStatus: vi.fn(async () => null),
  worktreeCheckouts: vi.fn(async () => {
    throw new Error('not_a_git_repository')
  }),
}))
vi.mock('../McpPanel', () => ({ McpPanel: stub('mcp') }))
vi.mock('../PluginsSidebar', () => ({ PluginsSidebar: stub('plugins') }))
vi.mock('../PullRequestsSidebar', () => ({ PullRequestsSidebar: stub('prs') }))
vi.mock('../VoiceHistoryPanel', () => ({ VoiceHistoryPanel: stub('jev') }))
vi.mock('../SidebarNowPlaying', () => ({ SidebarNowPlaying: stub('now-playing') }))
vi.mock('../UserProfile', () => ({ UserProfile: stub('profile') }))
vi.mock('../ProjectSidebar/FileExplorer', () => ({ FileExplorer: stub('files') }))
vi.mock('../ProjectSidebar/SidebarMergePanel', () => ({ SidebarMergePanel: stub('merge') }))
vi.mock('../ProjectSidebar/SidebarUpdate', () => ({ SidebarUpdate: stub('update') }))

beforeAll(async () => {
  configure({ asyncUtilTimeout: 10_000 })
  await import('../MarkdownPane/MarkdownRenderer')
}, 60_000)
beforeEach(() => {
  vi.clearAllMocks()
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: false })
  useProjectsStore.setState({
    preferences: {
      ...useProjectsStore.getState().preferences,
      markdownSummary: { enabled: true, agent: 'antigravity', model: '', style: 'medium' },
    },
  })
  useUiStore.setState({ rightSidebarMarkdownTabs: [], rightSidebarMarkdown: null })
})
afterEach(cleanup)
it('renders file headings, tables and code, reloads and copies the current source', async () => {
  const source =
    '# Verified document\n\n| Item | Value |\n| --- | --- |\n| Campaign | Ready |\n\n```ts\nconst ready = true\n```'
  vi.mocked(readTextFile).mockResolvedValue(source)
  useUiStore.getState().openMarkdownSidebar('C:/document.md', 'Document')
  render(<RightSidebar />)
  expect(await screen.findByRole('heading', { name: 'Verified document' })).toBeInTheDocument()
  expect(screen.getByRole('table')).toHaveTextContent('Campaign')
  expect(screen.getByText('const ready = true')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Copy Markdown source' }))
  expect(writeClipboardText).toHaveBeenCalledWith(source)
  vi.mocked(readTextFile).mockResolvedValue('# Updated document')
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
  expect(await screen.findByRole('heading', { name: 'Updated document' })).toBeInTheDocument()
})
it('keeps the newly selected document when the previous read finishes late', async () => {
  let finish!: (text: string) => void
  vi.mocked(readTextFile).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  useUiStore.getState().openMarkdownSidebar('C:/old.md', 'Old')
  render(<RightSidebar />)
  vi.mocked(readTextFile).mockResolvedValue('# New document')
  act(() => useUiStore.getState().openMarkdownSidebar('C:/new.md', 'New'))
  expect(await screen.findByRole('heading', { name: 'New document' })).toBeInTheDocument()
  await act(async () => finish('# Old document'))
  expect(screen.getByRole('heading', { name: 'New document' })).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'Old document' })).toBeNull()
})
