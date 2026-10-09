import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { githubPrListMine } from '../../lib/tauri'
import { EMPTY_PROJECTS_FILE } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { PullRequestsSidebar } from './index'
vi.mock('../../lib/tauri', () => ({
  githubPrListMine: vi.fn(async () => []),
  openInBrowser: vi.fn(),
}))
vi.mock('../../lib/terminalLifecycle', () => ({ cleanupPtys: vi.fn() }))
const list = vi.mocked(githubPrListMine)
const pr = (title: string) => ({
  number: 1,
  title,
  repo: 'owner/repo',
  url: 'https://github.com/owner/repo/pull/1',
  author: 'owner',
  isDraft: false,
  updatedAt: '2026-10-06T00:00:00Z',
})
beforeEach(() => {
  vi.resetAllMocks()
  list.mockResolvedValue([])
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: false })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
const project = (name: string, cwd: string) =>
  useProjectsStore.getState().createProject({ name, defaultCwd: cwd })
it('never queries globally without a selected repository', () => {
  render(<PullRequestsSidebar />)
  expect(list).not.toHaveBeenCalled()
})
it('uses the project checkout without requiring an open terminal', async () => {
  project('One', 'C:/one')
  render(<PullRequestsSidebar />)
  await waitFor(() => expect(list).toHaveBeenCalledWith('C:/one'))
})
it('switches repositories and ignores the previous request arriving late', async () => {
  const one = project('One', 'C:/one')
  const two = project('Two', 'C:/two')
  useProjectsStore.setState({ activeProjectId: one.id })
  let finish!: (prs: ReturnType<typeof pr>[]) => void
  list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  list.mockResolvedValue([pr('Second project')])
  render(<PullRequestsSidebar />)
  await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
  fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), { target: { value: two.id } })
  expect(await screen.findByText('Second project')).toBeInTheDocument()
  await act(async () => finish([pr('Wrong project')]))
  expect(screen.queryByText('Wrong project')).toBeNull()
  expect(screen.getByText('Second project')).toBeInTheDocument()
})
it('removes a closed PR on focus refresh and clears stale cards on failure', async () => {
  project('One', 'C:/one')
  list.mockResolvedValueOnce([pr('Open PR')])
  render(<PullRequestsSidebar />)
  expect(await screen.findByText('Open PR')).toBeInTheDocument()
  fireEvent(window, new Event('focus'))
  await waitFor(() => expect(screen.queryByText('Open PR')).toBeNull())
  list.mockResolvedValueOnce([pr('Stale on error')])
  fireEvent(window, new Event('focus'))
  expect(await screen.findByText('Stale on error')).toBeInTheDocument()
  list.mockRejectedValueOnce(new Error('offline'))
  fireEvent(window, new Event('focus'))
  expect(await screen.findByText('Error: offline')).toBeInTheDocument()
  expect(screen.queryByText('Stale on error')).toBeNull()
})
it('refreshes open PRs while the panel remains visible', async () => {
  vi.useFakeTimers()
  project('One', 'C:/one')
  list.mockResolvedValueOnce([pr('Merged elsewhere')])
  render(<PullRequestsSidebar />)
  await act(async () => {})
  expect(screen.getByText('Merged elsewhere')).toBeInTheDocument()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000)
  })
  expect(list).toHaveBeenCalledTimes(2)
  expect(screen.queryByText('Merged elsewhere')).toBeNull()
})
