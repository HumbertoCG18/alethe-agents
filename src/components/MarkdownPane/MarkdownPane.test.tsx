import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import {
  listenFileChanged,
  readRepositoryTextFile,
  readTextFile,
  writeRepositoryTextFile,
  writeTextFile,
} from '../../lib/tauri'
import { makeFilePane } from '../../lib/terminalFactory'
import { EMPTY_PROJECTS_FILE } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { MarkdownPane } from './index'

vi.mock('../../lib/tauri', async (original) => ({
  ...(await original<typeof import('../../lib/tauri')>()),
  readTextFile: vi.fn(async () => 'picked'),
  readRepositoryTextFile: vi.fn(),
  writeTextFile: vi.fn(async () => {}),
  writeRepositoryTextFile: vi.fn(async () => {}),
  watchFile: vi.fn(async () => {}),
  unwatchFile: vi.fn(async () => {}),
  listenFileChanged: vi.fn(async () => () => {}),
}))
beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)

it('reads evidence in a file pane under the checkout it was opened with, and says why it refuses', async () => {
  vi.mocked(readRepositoryTextFile).mockResolvedValueOnce('inside')
  const pane = makeFilePane({ filePath: 'C:/repo/docs/report.txt', scope: 'C:/repo' })
  const view = render(<MarkdownPane projectId="project" terminal={pane} />)
  expect(await screen.findByText('inside')).toBeInTheDocument()
  expect(readRepositoryTextFile).toHaveBeenCalledWith('C:/repo', 'C:/repo/docs/report.txt')
  expect(readTextFile).not.toHaveBeenCalled()
  view.unmount()

  vi.mocked(readRepositoryTextFile).mockRejectedValueOnce('outside_repository')
  render(<MarkdownPane projectId="project" terminal={pane} />)
  expect(await screen.findByText(/points outside the repository/)).toBeInTheDocument()
})

it('reads a file pane opened by hand as before', async () => {
  render(
    <MarkdownPane
      projectId="project"
      terminal={makeFilePane({ filePath: 'C:/picked.txt', scope: null })}
    />,
  )
  expect(await screen.findByText('picked')).toBeInTheDocument()
  expect(readRepositoryTextFile).not.toHaveBeenCalled()
})

/** Replaces the pane's text with `text` in the editor and saves it. */
async function editAndSave(text: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'Edit Markdown' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Edit Markdown' }), {
    target: { value: text },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
}

it('saves evidence edits only inside the checkout, and keeps the draft when refused', async () => {
  useUiStore.setState({ toasts: [], notifications: [] })
  vi.mocked(readRepositoryTextFile).mockResolvedValue('inside')
  vi.mocked(writeRepositoryTextFile).mockRejectedValueOnce('outside_repository')
  const pane = makeFilePane({ filePath: 'C:/repo/docs/report.txt', scope: 'C:/repo' })
  render(<MarkdownPane projectId="project" terminal={pane} />)
  await editAndSave('edited')
  expect(await screen.findByRole('button', { name: 'Save changes' })).toBeEnabled()
  expect(writeRepositoryTextFile).toHaveBeenCalledWith(
    'C:/repo',
    'C:/repo/docs/report.txt',
    'edited',
  )
  expect(writeTextFile).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox', { name: 'Edit Markdown' })).toHaveValue('edited')
  expect(useUiStore.getState().notifications[0]).toMatchObject({
    title: `Couldn't save ${pane.name}. Your edit is still in the editor.`,
    body: 'This file now points outside the repository through a link, so it was not saved.',
  })

  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())
  expect(writeRepositoryTextFile).toHaveBeenCalledTimes(2)
})

it('saves a file pane opened by hand as before', async () => {
  render(
    <MarkdownPane
      projectId="project"
      terminal={makeFilePane({ filePath: 'C:/picked.txt', scope: null })}
    />,
  )
  await editAndSave('edited')
  await waitFor(() => expect(writeTextFile).toHaveBeenCalledWith('C:/picked.txt', 'edited'))
  expect(writeRepositoryTextFile).not.toHaveBeenCalled()
})

it('holds a pane with an empty scope to the checkout, not to a pick', async () => {
  vi.mocked(readRepositoryTextFile).mockResolvedValueOnce('inside')
  const pane = makeFilePane({ filePath: 'C:/outside/report.txt', scope: '' })
  render(<MarkdownPane projectId="project" terminal={pane} />)
  await editAndSave('edited')
  await waitFor(() =>
    expect(writeRepositoryTextFile).toHaveBeenCalledWith('', 'C:/outside/report.txt', 'edited'),
  )
  expect(readRepositoryTextFile).toHaveBeenCalledWith('', 'C:/outside/report.txt')
  expect(readTextFile).not.toHaveBeenCalled()
  expect(writeTextFile).not.toHaveBeenCalled()
})

it('keeps the editor and the draft when the watcher cannot read the file after a refused save', async () => {
  useUiStore.setState({ toasts: [], notifications: [] })
  let changed: (path: string) => void = () => {}
  vi.mocked(listenFileChanged).mockImplementationOnce(async (handler) => {
    changed = handler
    return () => {}
  })
  vi.mocked(readRepositoryTextFile).mockResolvedValueOnce('inside')
  vi.mocked(writeRepositoryTextFile).mockRejectedValueOnce('outside_repository')
  const pane = makeFilePane({ filePath: 'C:/repo/docs/report.txt', scope: 'C:/repo' })
  render(<MarkdownPane projectId="project" terminal={pane} />)
  await editAndSave('edited')
  expect(await screen.findByRole('button', { name: 'Save changes' })).toBeEnabled()

  // The link that refused the save fails the watcher's read too.
  vi.mocked(readRepositoryTextFile).mockRejectedValueOnce('outside_repository')
  await act(async () => changed('C:/repo/docs/report.txt'))
  expect(await screen.findByText(/so it was not read/)).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Edit Markdown' })).toHaveValue('edited')
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled()
})

/** The pane as the store holds it, so an action on it renders the saved field. */
function StoredPane({ projectId, id }: { projectId: string; id: string }) {
  const terminal = useProjectsStore((s) =>
    s.projects.find((p) => p.id === projectId)?.terminals.find((t) => t.id === id),
  )
  return terminal ? <MarkdownPane projectId={projectId} terminal={terminal} /> : null
}

it('loads a pane saved before scopes were recorded only once the user opens it again', async () => {
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: false })
  const project = useProjectsStore
    .getState()
    .createProject({ name: 'Project', defaultCwd: 'C:/repo' })
  // As restored from projects.json: a file pane without the field at all.
  const legacy = makeFilePane({ filePath: 'C:/repo/docs/old.txt', scope: null })
  delete legacy.fileScope
  useProjectsStore.setState((s) => ({
    projects: s.projects.map((p) =>
      p.id === project.id ? { ...p, terminals: [...p.terminals, legacy] } : p,
    ),
  }))
  render(<StoredPane projectId={project.id} id={legacy.id} />)
  expect(
    await screen.findByText(/opened before Alethe checked repository links/),
  ).toBeInTheDocument()
  expect(readTextFile).not.toHaveBeenCalled()
  expect(readRepositoryTextFile).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: 'Open it again' }))
  expect(await screen.findByText('picked')).toBeInTheDocument()
  expect(readTextFile).toHaveBeenCalledWith('C:/repo/docs/old.txt')
  const saved = useProjectsStore
    .getState()
    .projects.find((p) => p.id === project.id)
    ?.terminals.find((t) => t.id === legacy.id)
  expect(saved).toHaveProperty('fileScope', null)
})
