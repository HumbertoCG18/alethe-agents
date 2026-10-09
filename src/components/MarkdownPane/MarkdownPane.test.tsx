import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { readRepositoryTextFile, readTextFile } from '../../lib/tauri'
import { makeFilePane } from '../../lib/terminalFactory'
import { EMPTY_PROJECTS_FILE } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { MarkdownPane } from './index'

vi.mock('../../lib/tauri', async (original) => ({
  ...(await original<typeof import('../../lib/tauri')>()),
  readTextFile: vi.fn(async () => 'picked'),
  readRepositoryTextFile: vi.fn(),
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
