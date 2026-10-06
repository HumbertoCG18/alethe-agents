import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ensureProjectAnchored } from '../../lib/projectCheckout'
import { EMPTY_PROJECTS_FILE } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { NewTerminalModal } from './NewTerminalModal'

/** Git answers the anchor only when a test lets it. */
const git = vi.hoisted(() => ({ answer: () => {} }))

vi.mock('../../lib/terminalLifecycle', () => ({ cleanupPtys: vi.fn() }))
vi.mock('../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/tauri')>()),
  worktreeCheckouts: vi.fn(
    () =>
      new Promise((resolve) => {
        git.answer = () =>
          resolve({
            main: 'C:\\repo',
            worktrees: [
              { path: 'C:\\repo', branch: 'dev', lastCommitMs: null },
              { path: 'C:\\repo-night', branch: 'night', lastCommitMs: null },
            ],
          })
      }),
  ),
}))

const createAgentTerminal = vi.fn(async () => ({ id: 'terminal-1' }))
let projectId = ''

beforeEach(() => {
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: false })
  createAgentTerminal.mockClear()
  useProjectsStore.setState({ createAgentTerminal } as never)
  const project = useProjectsStore
    .getState()
    .createProject({ name: 'Tutor', defaultCwd: 'C:\\repo-night' })
  projectId = project.id
  useUiStore.getState().openModal_('newTerminal', { projectId })
  render(<NewTerminalModal />)
})
afterEach(cleanup)

/** The footer's submit, the one carrying the Ctrl+Enter shortcut. */
const submitButton = () =>
  screen
    .getAllByRole('button', { name: /^Open / })
    .find((button) => button.textContent?.includes('↵'))!

const createdIn = () =>
  (createAgentTerminal.mock.calls as unknown as [string, { cwd: string }][]).map(
    ([, args]) => args.cwd,
  )

/** Picks `value` in the row select named `name`. */
function choose(name: string, value: string) {
  fireEvent.click(screen.getByRole('button', { name }))
  fireEvent.click(document.querySelector(`[data-alethe-option="${value}"]`)!)
}

const folderField = () => screen.getByLabelText('Folder (cwd)')

describe('new terminal modal', () => {
  it('keeps the folder, agent and goal chosen before the anchor lands', async () => {
    void ensureProjectAnchored(projectId)
    choose('Open as', 'orchestration')
    choose('Orchestrator', 'codex')
    fireEvent.change(screen.getByLabelText(/Goal/), { target: { value: 'ship the fix' } })
    fireEvent.change(folderField(), { target: { value: 'D:\\chosen' } })

    git.answer()
    await waitFor(() =>
      expect(useProjectsStore.getState().projects[0].checkoutPath).toBe('C:\\repo'),
    )

    expect(folderField()).toHaveValue('D:\\chosen')
    expect(screen.getByRole('button', { name: 'Orchestrator' })).toHaveTextContent('Codex')
    expect(screen.getByLabelText(/Goal/)).toHaveValue('ship the fix')
  })

  it('moves a folder left as offered to the anchored main checkout', async () => {
    expect(folderField()).toHaveValue('C:\\repo-night')
    void ensureProjectAnchored(projectId)
    git.answer()

    await waitFor(() => expect(folderField()).toHaveValue('C:\\repo'))
  })

  it('creates the terminal only after the anchor lands, in the main checkout', async () => {
    fireEvent.click(submitButton())
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(createAgentTerminal).not.toHaveBeenCalled()

    git.answer()

    await waitFor(() => expect(createdIn()).toEqual(['C:\\repo']))
  })

  it('keeps a folder the user typed instead of the one offered', async () => {
    fireEvent.change(screen.getByLabelText('Folder (cwd)'), { target: { value: 'D:\\elsewhere' } })
    fireEvent.click(submitButton())

    await waitFor(() => expect(createdIn()).toEqual(['D:\\elsewhere']))
  })
})

describe('campaign session context', () => {
  it('offers the campaign folder and creates only through its confirmation callback', async () => {
    const onCreate = vi.fn(async () => true)
    act(() =>
      useUiStore.getState().openModal_('newTerminal', {
        projectId,
        cwd: 'C:\\repo-feature',
        only: ['claude', 'codex'],
        onCreate,
      }),
    )
    await waitFor(() => expect(folderField()).toHaveValue('C:\\repo-feature'))
    expect(onCreate).not.toHaveBeenCalled()
    fireEvent.click(submitButton())
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1))
    expect(onCreate.mock.calls[0][0]).toMatchObject({
      cwd: 'C:\\repo-feature',
      firstTab: { type: 'claude' },
    })
    expect(createAgentTerminal).not.toHaveBeenCalled()
  })
})

it('keeps the dialog open during pending confirmation and does not close a newer dialog', async () => {
  let finish: (ok: boolean) => void = () => {}
  const onCreate = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve
      }),
  )
  act(() =>
    useUiStore.getState().openModal_('newTerminal', { projectId, cwd: 'C:\\repo', onCreate }),
  )
  fireEvent.click(submitButton())
  await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1))
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(useUiStore.getState().openModal).toBe('newTerminal')
  act(() => useUiStore.getState().openModal_('newProject'))
  await act(async () => finish(true))
  expect(useUiStore.getState().openModal).toBe('newProject')
})

it('offers orchestration in a campaign session and passes the selected mode', async () => {
  const onCreate = vi.fn(async () => true)
  act(() =>
    useUiStore.getState().openModal_('newTerminal', {
      projectId,
      cwd: 'D:\\campaign',
      only: ['claude', 'codex'],
      onCreate,
    }),
  )
  choose('Open as', 'orchestration')
  fireEvent.click(screen.getByRole('button', { name: /Create orchestration/ }))
  await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1))
  expect(onCreate.mock.calls[0][1]).toBe('orchestration')
  expect(createAgentTerminal).not.toHaveBeenCalled()
})
