import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PullRequestSummary } from '../../lib/tauri'
import { EMPTY_PROJECTS_FILE } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { SidebarMergePanel } from './SidebarMergePanel'

const askConfirm = vi.hoisted(() => vi.fn<(message: string) => Promise<boolean>>())
const tauri = vi.hoisted(() => ({
  killPtyTree: vi.fn(async () => []),
  worktreeRemove: vi.fn(async () => {}),
  githubPrFind: vi.fn(),
  githubPrMerge: vi.fn(async () => 'merged'),
}))

vi.mock('../../lib/dialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/dialog')>()),
  askConfirm,
}))
vi.mock('../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/tauri')>()),
  ...tauri,
}))
vi.mock('../../lib/terminalLifecycle', () => ({ cleanupPtys: vi.fn() }))
vi.mock('../../hooks/useGsdSyncSessions', () => ({ useGsdSyncSessionsWatcher: () => {} }))

type Card = { id: string }
vi.mock('./MergeTree', () => ({
  MergeTree: ({ items, onSelect }: { items: Card[]; onSelect: (item: Card) => void }) => (
    <button type="button" onClick={() => onSelect(items[0])}>
      select card
    </button>
  ),
}))
vi.mock('../modals/MergeCenterModal', () => ({
  MergeCenterModal: ({
    items,
    onReject,
    onOpenPullRequest,
  }: {
    items: Card[]
    onReject: (item: Card) => void
    onOpenPullRequest: (item: Card) => void
  }) => (
    <>
      <button type="button" onClick={() => onReject(items[0])}>
        reject
      </button>
      <button type="button" onClick={() => onOpenPullRequest(items[0])}>
        open pull request
      </button>
    </>
  ),
}))
vi.mock('../PullRequestReview/PullRequestReviewModal', () => ({
  PullRequestReviewModal: ({
    open,
    pullRequests,
    onMerge,
  }: {
    open: boolean
    pullRequests: PullRequestSummary[]
    onMerge: (pr: PullRequestSummary) => void
  }) =>
    open && pullRequests[0] ? (
      <button type="button" onClick={() => onMerge(pullRequests[0])}>
        merge pull request
      </button>
    ) : null,
}))

const pr: PullRequestSummary = {
  number: 7,
  title: 'Agent work',
  body: '',
  url: 'https://github.com/o/r/pull/7',
  baseBranch: 'main',
  headBranch: 'alethe/agent-a1',
  headSha: 'abc123',
  mergeState: 'CLEAN',
  isDraft: false,
  author: 'me',
  reviewDecision: null,
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  askConfirm.mockReset()
  for (const fn of Object.values(tauri)) fn.mockClear()
  tauri.githubPrFind.mockResolvedValue([pr])
  // What tauri-plugin-dialog injects: an async confirm whose Promise is always truthy.
  vi.stubGlobal(
    'confirm',
    vi.fn(async () => false),
  )

  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: false })
  const store = useProjectsStore.getState()
  const project = store.createProject({ name: 'App' })
  store.createTerminal(project.id, {
    name: 'Shell',
    cwd: '/repo',
    firstTab: { type: 'shell', cwd: '/repo' },
  })
  const agent = store.createTerminal(project.id, {
    name: 'Agent',
    cwd: '/repo/.wt/a1',
    firstTab: { type: 'shell', cwd: '/repo/.wt/a1' },
  })
  useProjectsStore.setState((state) => ({
    activeProjectId: project.id,
    projects: state.projects.map((item) => ({
      ...item,
      terminals: item.terminals.map((term) =>
        term.id === agent.id ? { ...term, worktreeAgentId: 'a1' } : term,
      ),
    })),
  }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function openCard() {
  render(<SidebarMergePanel />)
  fireEvent.click(screen.getByText('select card'))
}

describe('SidebarMergePanel confirmations', () => {
  it('reject: cancel keeps the worktree', async () => {
    askConfirm.mockResolvedValue(false)
    await openCard()
    fireEvent.click(screen.getByText('reject'))
    await flush()
    expect(tauri.worktreeRemove).not.toHaveBeenCalled()
    expect(useProjectsStore.getState().projects[0].terminals).toHaveLength(2)
  })

  it('reject: confirm removes the worktree', async () => {
    askConfirm.mockResolvedValue(true)
    await openCard()
    fireEvent.click(screen.getByText('reject'))
    await vi.waitFor(() => expect(tauri.worktreeRemove).toHaveBeenCalledWith('/repo', 'a1', true))
  })

  it('pull request merge: cancel does not merge', async () => {
    askConfirm.mockResolvedValue(false)
    await openCard()
    fireEvent.click(screen.getByText('open pull request'))
    fireEvent.click(await screen.findByText('merge pull request'))
    await flush()
    expect(tauri.githubPrMerge).not.toHaveBeenCalled()
  })

  it('pull request merge: confirm merges', async () => {
    askConfirm.mockResolvedValue(true)
    await openCard()
    fireEvent.click(screen.getByText('open pull request'))
    fireEvent.click(await screen.findByText('merge pull request'))
    await vi.waitFor(() =>
      expect(tauri.githubPrMerge).toHaveBeenCalledWith('/repo', 7, 'squash', 'abc123'),
    )
  })
})
