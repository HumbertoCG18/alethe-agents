import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { checkRepositoryFile, OUTSIDE_REPOSITORY, readRepositoryFileBase64 } from '../../lib/tauri'
import { makeFilePane } from '../../lib/terminalFactory'
import { EMPTY_PROJECTS_FILE } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { ImagePane } from '../ImagePane'
import { VideoPane } from '../VideoPane'
import { ScopedMedia } from './index'

vi.mock('@tauri-apps/api/core', async (original) => ({
  ...(await original<typeof import('@tauri-apps/api/core')>()),
  convertFileSrc: (path: string) => `asset://${path}`,
}))
vi.mock('../../lib/tauri', async (original) => ({
  ...(await original<typeof import('../../lib/tauri')>()),
  readRepositoryFileBase64: vi.fn(),
  checkRepositoryFile: vi.fn(),
}))
beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)

it('shows an image from repository evidence through the checked read, and a picked one as before', async () => {
  vi.mocked(readRepositoryFileBase64).mockResolvedValueOnce('AAEC')
  const scoped = makeFilePane({ filePath: 'C:/repo/docs/shot.svg', scope: 'C:/repo' })
  const shown = render(<ImagePane projectId="project" terminal={scoped} />)
  await waitFor(() =>
    expect(shown.container.querySelector('img')).toHaveAttribute(
      'src',
      'data:image/svg+xml;base64,AAEC',
    ),
  )
  expect(readRepositoryFileBase64).toHaveBeenCalledWith('C:/repo', 'C:/repo/docs/shot.svg')
  shown.unmount()

  vi.mocked(readRepositoryFileBase64).mockRejectedValueOnce('outside_repository')
  const refused = render(<ImagePane projectId="project" terminal={scoped} />)
  expect(await screen.findByText(/points outside the repository/)).toBeInTheDocument()
  expect(refused.container.querySelector('img')).toBeNull()
  refused.unmount()

  const picked = makeFilePane({ filePath: 'C:/picked.png', scope: null })
  const { container } = render(<ImagePane projectId="project" terminal={picked} />)
  expect(container.querySelector('img')).toHaveAttribute('src', 'asset://C:/picked.png')
  expect(readRepositoryFileBase64).toHaveBeenCalledTimes(2)
})

it('gives a video from repository evidence a source only once the checkout check passes', async () => {
  vi.mocked(checkRepositoryFile).mockRejectedValueOnce('outside_repository')
  const scoped = makeFilePane({ filePath: 'C:/repo/docs/run.mp4', scope: 'C:/repo' })
  const refused = render(<VideoPane projectId="project" terminal={scoped} />)
  expect(refused.container.querySelector('video')).toBeNull()
  expect(await screen.findByText(/points outside the repository/)).toBeInTheDocument()
  expect(refused.container.querySelector('video')).toBeNull()
  expect(checkRepositoryFile).toHaveBeenCalledWith('C:/repo', 'C:/repo/docs/run.mp4')
  refused.unmount()

  vi.mocked(checkRepositoryFile).mockResolvedValueOnce(undefined)
  const passed = render(<VideoPane projectId="project" terminal={scoped} />)
  expect(passed.container.querySelector('video')).toBeNull()
  await waitFor(() =>
    expect(passed.container.querySelector('video')).toHaveAttribute(
      'src',
      'asset://C:/repo/docs/run.mp4',
    ),
  )
  passed.unmount()

  const picked = makeFilePane({ filePath: 'C:/picked.mp4', scope: null })
  const { container } = render(<VideoPane projectId="project" terminal={picked} />)
  expect(container.querySelector('video')).toHaveAttribute('src', 'asset://C:/picked.mp4')
  expect(checkRepositoryFile).toHaveBeenCalledTimes(2)
})

it('never shows an earlier result once the file changes, a return to that file included', async () => {
  const resolvers: ((src: string) => void)[] = []
  const load = vi.fn<(scope: string, path: string) => Promise<string>>(
    () => new Promise((resolve) => resolvers.push(resolve)),
  )
  const media = (path: string) => (
    <ScopedMedia path={path} scope="C:/repo" load={load}>
      {(src) => <img src={src} alt="" />}
    </ScopedMedia>
  )
  const { container, rerender } = render(media('C:/repo/a.png'))
  await act(async () => resolvers[0]('a-first'))
  expect(container.querySelector('img')).toHaveAttribute('src', 'a-first')

  rerender(media('C:/repo/b.png'))
  expect(container.querySelector('img')).toBeNull()
  // Back to A while B still loads: A is checked again before anything shows.
  rerender(media('C:/repo/a.png'))
  expect(container.querySelector('img')).toBeNull()
  expect(load).toHaveBeenCalledTimes(3)
  await act(async () => resolvers[1]('b-late'))
  expect(container.querySelector('img')).toBeNull()
  await act(async () => resolvers[2]('a-again'))
  expect(container.querySelector('img')).toHaveAttribute('src', 'a-again')
})

it('holds a file with an empty scope to the checkout, not to a pick', async () => {
  const load = vi
    .fn<(scope: string, path: string) => Promise<string>>()
    .mockRejectedValue(OUTSIDE_REPOSITORY)
  const { container } = render(
    <ScopedMedia path="C:/outside/private.png" scope="" load={load}>
      {(src) => <img src={src} alt="" />}
    </ScopedMedia>,
  )
  expect(await screen.findByText(/points outside the repository/)).toBeInTheDocument()
  expect(container.querySelector('img')).toBeNull()
  expect(load).toHaveBeenCalledWith('', 'C:/outside/private.png')
})

/** The media panes of a project as the store holds them, so an action on one renders it again. */
function StoredPanes({ projectId }: { projectId: string }) {
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId))
  return project?.terminals.map((terminal) =>
    terminal.kind === 'image' ? (
      <ImagePane key={terminal.id} projectId={projectId} terminal={terminal} />
    ) : terminal.kind === 'video' ? (
      <VideoPane key={terminal.id} projectId={projectId} terminal={terminal} />
    ) : null,
  )
}

it('loads media panes saved before scopes were recorded only once the user opens them again', async () => {
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: false })
  const project = useProjectsStore
    .getState()
    .createProject({ name: 'Project', defaultCwd: 'C:/repo' })
  // As restored from projects.json: media panes without the field at all.
  const image = makeFilePane({ filePath: 'C:/repo/docs/old.png', scope: null })
  const video = makeFilePane({ filePath: 'C:/repo/docs/old.mp4', scope: null })
  delete image.fileScope
  delete video.fileScope
  useProjectsStore.setState((s) => ({
    projects: s.projects.map((p) =>
      p.id === project.id ? { ...p, terminals: [...p.terminals, image, video] } : p,
    ),
  }))
  const { container } = render(<StoredPanes projectId={project.id} />)
  expect(screen.getAllByText(/opened before Alethe checked repository links/).length).toBe(2)
  expect(container.querySelector('img, video')).toBeNull()

  for (const button of screen.getAllByRole('button', { name: 'Open it again' }))
    fireEvent.click(button)
  expect(await screen.findByRole('presentation')).toHaveAttribute(
    'src',
    'asset://C:/repo/docs/old.png',
  )
  expect(container.querySelector('video')).toHaveAttribute('src', 'asset://C:/repo/docs/old.mp4')
  expect(readRepositoryFileBase64).not.toHaveBeenCalled()
  expect(checkRepositoryFile).not.toHaveBeenCalled()
  const saved = useProjectsStore.getState().projects.find((p) => p.id === project.id)?.terminals
  expect(saved?.filter((t) => t.fileScope === null).map((t) => t.id)).toEqual([image.id, video.id])
})
