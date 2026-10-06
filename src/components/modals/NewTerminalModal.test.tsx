import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
