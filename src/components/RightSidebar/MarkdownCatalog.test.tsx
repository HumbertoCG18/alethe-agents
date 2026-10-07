import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import example from '../../lib/__fixtures__/campanhas.exemplo.json'
import { parseCampaigns } from '../../lib/campaigns'
import { EMPTY_PROJECTS_FILE } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { MarkdownCatalog } from './MarkdownCatalog'
import { recoverCatalogPath, useMarkdownCatalog } from './useMarkdownCatalog'
const state = vi.hoisted(() => ({
  activeId: 'OITO',
  root: 'C:/repo',
  registry: null as unknown,
  files: vi.fn(),
  find: vi.fn(),
}))
vi.mock('../../plugins/todos/campaignView', () => ({
  useCampaignView: () => ({ registry: state.registry, activeId: state.activeId }),
}))
vi.mock('../../lib/projectCheckout', () => ({
  resolveProjectCheckout: async () => ({
    root: state.root,
    checkouts: { main: 'C:/repo', worktrees: [{ path: 'C:/repo' }, { path: 'C:/repo-feature' }] },
  }),
}))
vi.mock('../../lib/tauri', () => ({
  listProjectMarkdown: state.files,
  findRelativePath: state.find,
}))
function Catalog() {
  const catalog = useMarkdownCatalog()
  return (
    <>
      <button onClick={catalog.reload}>Refresh index</button>
      <MarkdownCatalog catalog={catalog} />
    </>
  )
}
beforeEach(() => {
  vi.clearAllMocks()
  state.root = 'C:/repo'
  localStorage.clear()
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), activeProjectId: 'project' })
  const data = structuredClone(example)
  data.campanhas.find((c) => c.id === 'OITO')!.handoff = 'docs/campaign.md'
  state.registry = { ...parseCampaigns(JSON.stringify(data)), main: 'C:/repo' }
  state.files.mockImplementation(async (root: string) =>
    root === 'C:/repo'
      ? ['C:/repo/docs/reports/report.md', 'C:/repo/docs/campaign.md']
      : ['C:/repo-feature/docs/reports/night.md'],
  )
  state.find.mockImplementation(async (_root: string, path: string) =>
    path === 'docs/campaign.md' ? 'C:/repo/docs/campaign.md' : null,
  )
  useUiStore.setState({
    rightSidebarMarkdown: null,
    rightSidebarMarkdownTabs: [{ path: 'C:/other/private.md', title: 'Private' }],
  })
})
afterEach(cleanup)
it('groups project and worktree documents, prioritizes the active campaign and excludes other history', async () => {
  render(<Catalog />)
  const active = await screen.findByText('campaign.md')
  expect(active.closest('section')?.querySelector('button[aria-expanded]')).toHaveTextContent(
    'Active campaign',
  )
  expect(screen.getByText('report.md')).toBeInTheDocument()
  expect(screen.getByText('night.md')).toBeInTheDocument()
  expect(screen.queryByText('Private')).toBeNull()
  expect(screen.getAllByText('campaign.md')).toHaveLength(1)
  fireEvent.click(active)
  expect(useUiStore.getState().rightSidebarMarkdown?.path).toBe('C:/repo/docs/campaign.md')
})
it('discards a late scan after the project is deselected', async () => {
  const finish: Array<(paths: string[]) => void> = []
  state.files.mockImplementation(
    () =>
      new Promise<string[]>((resolve) => {
        finish.push(resolve)
      }),
  )
  render(<Catalog />)
  await waitFor(() => expect(state.files).toHaveBeenCalled())
  act(() => useProjectsStore.setState({ activeProjectId: null }))
  await act(async () => {
    for (const resolve of finish) resolve(['C:/repo/docs/reports/old.md'])
  })
  expect(screen.queryByText('old.md')).toBeNull()
})

it('bounds mounted rows even for a large catalog and exposes search', async () => {
  state.files.mockImplementation(async (root: string) =>
    root === 'C:/repo'
      ? Array.from({ length: 2000 }, (_, i) => `C:/repo/docs/reports/report-${i}.md`)
      : [],
  )
  render(<Catalog />)
  await screen.findByText('report-0.md')
  expect(screen.getAllByRole('button').length).toBeLessThan(250)
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'report-1999.md' } })
  expect(screen.getByText('report-1999.md')).toBeInTheDocument()
})
it('groups checkout copies while keeping alternative paths accessible', async () => {
  state.files.mockImplementation(async (root: string) => [`${root}/docs/reports/shared.md`])
  render(<Catalog />)
  await screen.findByText('shared.md')
  expect(screen.getAllByText('shared.md')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: /versions/i }))
  fireEvent.click(screen.getByRole('button', { name: /repo-feature/ }))
  expect(useUiStore.getState().rightSidebarMarkdown?.path).toBe(
    'C:/repo-feature/docs/reports/shared.md',
  )
})
it('hides documents belonging only to concluded campaigns until requested', async () => {
  const registry = state.registry as ReturnType<typeof parseCampaigns>
  registry!.campaigns.find((c) => c.id === 'OITO')!.situation.kind = 'done'
  render(<Catalog />)
  await screen.findByText('report.md')
  expect(screen.queryByText('campaign.md')).toBeNull()
  const filter = screen.getByRole('button', { name: /completed/i })
  expect(filter).toHaveAttribute('aria-pressed', 'false')
  fireEvent.click(filter)
  expect(filter).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByText('campaign.md')).toBeInTheDocument()
})
it('hides documents dated beyond the age window unless an open campaign uses them', async () => {
  const today = new Date().toISOString().slice(0, 10)
  const data = structuredClone(example)
  data.campanhas.find((c) => c.id === 'OITO')!.handoff = 'docs/2020-01-01-handoff.md'
  state.registry = { ...parseCampaigns(JSON.stringify(data)), main: 'C:/repo' }
  state.files.mockImplementation(async (root: string) =>
    root === 'C:/repo'
      ? [
          'C:/repo/docs/reports/_harness-2020-01-01/old.md',
          `C:/repo/docs/reports/${today}-new.md`,
          'C:/repo/docs/reports/undated.md',
        ]
      : [],
  )
  state.find.mockImplementation(async (_root: string, path: string) =>
    path === 'docs/2020-01-01-handoff.md' ? 'C:/repo/docs/2020-01-01-handoff.md' : null,
  )
  render(<Catalog />)
  await screen.findByText(`${today}-new.md`)
  expect(await screen.findByText('2020-01-01-handoff.md')).toBeInTheDocument()
  expect(screen.getByText('undated.md')).toBeInTheDocument()
  expect(screen.queryByText('old.md')).toBeNull()
  const filter = screen.getByRole('button', { name: /\(1 hidden\)/ })
  fireEvent.click(filter)
  expect(screen.getByText('old.md')).toBeInTheDocument()
  fireEvent.click(filter)
  act(() =>
    useProjectsStore.setState((s) => ({
      preferences: { ...s.preferences, markdownCatalogMaxAgeDays: 0 },
    })),
  )
  expect(screen.getByText('old.md')).toBeInTheDocument()
})
it('collapses a section through its header', async () => {
  render(<Catalog />)
  await screen.findByText('report.md')
  const header = screen.getByRole('button', { name: /Reports/ })
  expect(header).toHaveAttribute('aria-expanded', 'true')
  fireEvent.click(header)
  expect(header).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByText('report.md')).toBeNull()
})
it('ignores focus bursts instead of rebuilding the whole index each time', async () => {
  vi.useFakeTimers()
  try {
    render(<Catalog />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByText('report.md')).toBeInTheDocument()
    const scans = state.files.mock.calls.length
    const lookups = state.find.mock.calls.length
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(state.find.mock.calls.length).toBe(lookups)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000)
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(state.files.mock.calls.length).toBeGreaterThan(scans)
  } finally {
    vi.useRealTimers()
  }
})
it('restores the previous index immediately while revalidating after a remount', async () => {
  const view = render(<Catalog />)
  await screen.findByText('report.md')
  view.unmount()
  state.files.mockImplementation(() => new Promise(() => {}))
  render(<Catalog />)
  expect(screen.getByText('report.md')).toBeInTheDocument()
})

it('recovers a missing directory prefix without guessing between distinct reports', () => {
  const doc = {
    path: 'C:/repo/docs/reports/harness/c1-3/result.md',
    title: 'result.md',
    relative: 'docs/reports/harness/c1-3/result.md',
    variants: ['C:/repo/docs/reports/harness/c1-3/result.md'],
    campaigns: [],
  }
  expect(recoverCatalogPath('C:/repo/c1-3/result.md', ['C:/repo'], [doc])).toBe(doc.path)
  expect(recoverCatalogPath('C:/repo/result.md', ['C:/repo'], [doc])).toBeNull()
  expect(recoverCatalogPath('C:/elsewhere/c1-3/result.md', ['C:/repo'], [doc])).toBeNull()
  const other = {
    ...doc,
    path: 'C:/repo/docs/another/c1-3/result.md',
    relative: 'docs/another/c1-3/result.md',
  }
  expect(recoverCatalogPath('C:/repo/c1-3/result.md', ['C:/repo'], [doc, other])).toBeNull()
})

it('ends discovery feedback when an IPC request never answers', async () => {
  vi.useFakeTimers()
  try {
    state.files.mockImplementation(() => new Promise(() => {}))
    render(<Catalog />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000)
    })
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent(/timed out/i)
  } finally {
    vi.useRealTimers()
  }
})

it('retries with a fresh native request after a stalled discovery times out', async () => {
  vi.useFakeTimers()
  try {
    state.files.mockImplementation(() => new Promise(() => {}))
    render(<Catalog />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000)
    })
    const calls = state.files.mock.calls.length
    state.files.mockImplementation(async (root: string) => [`${root}/docs/reports/recovered.md`])
    await act(async () => {
      fireEvent.click(screen.getByText('Refresh index'))
    })
    expect(state.files.mock.calls.length).toBeGreaterThan(calls)
    expect(screen.getByText('recovered.md')).toBeInTheDocument()
  } finally {
    vi.useRealTimers()
  }
})

it('preserves ignored explicit evidence in each checkout and prefers the selected one', async () => {
  state.root = 'C:/repo-feature'
  state.files.mockResolvedValue([])
  state.find.mockImplementation(async (root: string, ref: string) =>
    ref === 'docs/campaign.md' ? `${root}/docs/campaign.md` : null,
  )
  render(<Catalog />)
  await screen.findByText('campaign.md')
  fireEvent.click(screen.getByText('campaign.md'))
  expect(useUiStore.getState().rightSidebarMarkdown?.path).toBe('C:/repo-feature/docs/campaign.md')
  fireEvent.click(screen.getByRole('button', { name: /versions.*campaign.md/i }))
  fireEvent.click(screen.getByRole('button', { name: /^repo$/ }))
  expect(useUiStore.getState().rightSidebarMarkdown?.path).toBe('C:/repo/docs/campaign.md')
})
