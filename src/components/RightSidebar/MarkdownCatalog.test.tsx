import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import example from '../../lib/__fixtures__/campanhas.exemplo.json'
import { parseCampaigns } from '../../lib/campaigns'
import { EMPTY_PROJECTS_FILE } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { MarkdownCatalog } from './MarkdownCatalog'
import { useMarkdownCatalog } from './useMarkdownCatalog'
const state = vi.hoisted(() => ({
  activeId: 'OITO',
  registry: null as unknown,
  files: vi.fn(),
  find: vi.fn(),
}))
vi.mock('../../plugins/todos/campaignView', () => ({
  useCampaignView: () => ({ registry: state.registry, activeId: state.activeId }),
}))
vi.mock('../../lib/projectCheckout', () => ({
  resolveProjectCheckout: async () => ({
    root: 'C:/repo',
    checkouts: { main: 'C:/repo', worktrees: [{ path: 'C:/repo' }, { path: 'C:/repo-feature' }] },
  }),
}))
vi.mock('../../lib/tauri', () => ({
  listProjectMarkdown: state.files,
  findRelativePath: state.find,
}))
function Catalog() {
  return <MarkdownCatalog catalog={useMarkdownCatalog()} />
}
beforeEach(() => {
  vi.clearAllMocks()
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
  expect(active.closest('details')?.querySelector('summary')).toHaveTextContent('Active campaign')
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
