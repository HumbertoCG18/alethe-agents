import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { effectiveCheckout } from '../../lib/projectCheckout'
import { orchestratorJobs, worktreeCheckouts, worktreeRemoveCheckout } from '../../lib/tauri'
import { EMPTY_PROJECTS_FILE } from '../../lib/types'
import { getProjectDefaultCwd, useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { WorktreePickerModal } from './WorktreePickerModal'

const checkouts = vi.hoisted(() => ({
  main: 'C:\\repo',
  worktrees: [
    { path: 'C:\\repo', branch: 'dev', lastCommitMs: null, stale: false, uncommitted: 0 },
    {
      path: 'C:\\repo-feature',
      branch: 'feature',
      lastCommitMs: null,
      stale: false,
      uncommitted: 0,
    },
    { path: 'C:\\repo-night', branch: 'night', lastCommitMs: null, stale: true, uncommitted: 0 },
    // Merged, but holding work nobody committed yet.
    { path: 'C:\\repo-wip', branch: 'wip', lastCommitMs: null, stale: false, uncommitted: 3 },
    { path: 'C:\\repo-detached', branch: null, lastCommitMs: null, stale: false, uncommitted: 2 },
    { path: 'C:\\repo-loose', branch: null, lastCommitMs: null, stale: false, uncommitted: 0 },
  ],
}))
const askConfirm = vi.hoisted(() => vi.fn(async (_message: string) => true))

vi.mock('../../lib/terminalLifecycle', () => ({ cleanupPtys: vi.fn() }))
vi.mock('../../lib/dialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/dialog')>()),
  askConfirm,
}))
vi.mock('../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/tauri')>()),
  worktreeCheckouts: vi.fn(async () => checkouts),
  worktreeRemoveCheckout: vi.fn(async () => {}),
  orchestratorJobs: vi.fn(async () => ({ jobs: [] })),
}))

beforeEach(() => {
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: false })
  askConfirm.mockClear()
  vi.mocked(worktreeRemoveCheckout).mockReset()
  vi.mocked(orchestratorJobs).mockResolvedValue({ jobs: [] } as never)
})
afterEach(cleanup)

function open() {
  const project = useProjectsStore
    .getState()
    .createProject({ name: 'Tutor', defaultCwd: 'C:\\repo-night' })
  useUiStore.getState().openModal_('worktreePicker', { projectId: project.id })
  render(<WorktreePickerModal />)
  return project.id
}

/** A checkout's row, titled with its full path. */
const row = (path: string) => screen.getByTitle(path)
const saved = () => useProjectsStore.getState().projects[0]

describe('worktree picker', () => {
  it('lists every worktree with its branch, marks main and stale, and picks main by default', async () => {
    open()

    expect(await screen.findByTitle('C:\\repo')).toHaveAttribute('aria-pressed', 'true')
    expect(within(row('C:\\repo')).getByText('main')).toBeInTheDocument()
    expect(within(row('C:\\repo-feature')).getByText(/^feature ·/)).toBeInTheDocument()
    expect(row('C:\\repo-feature')).toHaveAttribute('aria-pressed', 'false')
    expect(within(row('C:\\repo-night')).getByText('stale')).toBeInTheDocument()
    expect(within(row('C:\\repo-feature')).queryByText('stale')).not.toBeInTheDocument()
    expect(worktreeCheckouts).toHaveBeenCalledWith(expect.any(String), true)
  })

  it('shows uncommitted work instead of stale, and lets a detached worktree go', async () => {
    open()

    const wip = await screen.findByTitle('C:\\repo-wip')
    expect(within(wip).getByText('3 uncommitted changes')).toBeInTheDocument()
    expect(within(wip).queryByText('stale')).not.toBeInTheDocument()
    expect(within(row('C:\\repo-loose')).getByText(/^detached HEAD ·/)).toBeInTheDocument()
    expect(within(row('C:\\repo-detached')).getByText('2 uncommitted changes')).toBeInTheDocument()
    expect(
      screen.getAllByRole('button', { name: /^Remove/ }).map((button) => button.ariaLabel),
    ).toEqual(['Remove repo-night', 'Remove repo-detached', 'Remove repo-loose'])
  })

  it('refuses a detached worktree with uncommitted changes, without asking', async () => {
    open()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove repo-detached' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/uncommitted/i)
    expect(askConfirm).not.toHaveBeenCalled()
    expect(worktreeRemoveCheckout).not.toHaveBeenCalled()
  })

  it('makes the chosen worktree the cwd for new terminals and the Markdown root', async () => {
    open()
    fireEvent.click(await screen.findByTitle('C:\\repo-feature'))

    expect(saved().checkoutPath).toBe('C:\\repo-feature')
    expect(getProjectDefaultCwd(saved())).toBe('C:\\repo-feature')
    expect(effectiveCheckout(saved(), checkouts)).toBe('C:\\repo-feature')
  })

  it('asks before removing a stale worktree, then removes it', async () => {
    open()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove repo-night' }))

    await waitFor(() => expect(worktreeRemoveCheckout).toHaveBeenCalledWith('C:\\repo-night'))
    expect(askConfirm).toHaveBeenCalledBefore(vi.mocked(worktreeRemoveCheckout))
    expect(saved().defaultCwd).toBe('C:\\repo-night')
    expect(saved().checkoutPath).toBe('C:\\repo')
  })

  it('checks again after the confirmation: a terminal opened meanwhile stops the removal', async () => {
    const projectId = open()
    askConfirm.mockImplementationOnce(async () => {
      useProjectsStore.getState().createTerminal(projectId, {
        name: 'Shell',
        cwd: 'C:\\repo-night',
        firstTab: { type: 'shell', cwd: 'C:\\repo-night' },
      })
      return true
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Remove repo-night' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/terminal/i)
    expect(askConfirm).toHaveBeenCalledOnce()
    expect(worktreeRemoveCheckout).not.toHaveBeenCalled()
  })

  it('reports a terminal the backend found inside, as the picker check does', async () => {
    vi.mocked(worktreeRemoveCheckout).mockRejectedValue('worktree_in_use_terminal')
    open()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove repo-night' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/open terminal/i)
  })

  it('says the base branch is unknown when the main checkout is detached', async () => {
    vi.mocked(worktreeCheckouts).mockResolvedValueOnce({ ...checkouts, base: null })
    open()

    expect(await screen.findByText(/base branch unknown/i)).toBeInTheDocument()
  })

  it('refuses when the orchestration workers cannot be listed', async () => {
    vi.mocked(orchestratorJobs).mockRejectedValue('ipc_down')
    open()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove repo-night' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /could not check the orchestration workers/i,
    )
    expect(askConfirm).not.toHaveBeenCalled()
    expect(worktreeRemoveCheckout).not.toHaveBeenCalled()
  })

  it('reports a refusal for uncommitted changes and keeps the project as it was', async () => {
    vi.mocked(worktreeRemoveCheckout).mockRejectedValue('worktree_dirty')
    open()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove repo-night' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/uncommitted/i)
    expect(saved().defaultCwd).toBe('C:\\repo-night')
  })

  it('refuses a worktree an open terminal uses, without asking', async () => {
    const projectId = open()
    useProjectsStore.getState().createTerminal(projectId, {
      name: 'Shell',
      cwd: 'C:\\repo-night\\src',
      firstTab: { type: 'shell', cwd: 'C:\\repo-night\\src' },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Remove repo-night' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/terminal/i)
    expect(askConfirm).not.toHaveBeenCalled()
    expect(worktreeRemoveCheckout).not.toHaveBeenCalled()
  })

  it('refuses a worktree where a live orchestration worker runs, without asking', async () => {
    vi.mocked(orchestratorJobs).mockResolvedValue({
      jobs: [{ status: 'running', cwd: 'C:\\repo-night' }],
    } as never)
    open()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove repo-night' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/worker/i)
    expect(askConfirm).not.toHaveBeenCalled()
    expect(worktreeRemoveCheckout).not.toHaveBeenCalled()
  })
})
