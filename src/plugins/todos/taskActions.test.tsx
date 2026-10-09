import { beforeEach, expect, it, vi } from 'vitest'

import type { TFunction } from '../../lib/i18n'
import { findRepositoryFile, listDirectory } from '../../lib/tauri'
import { EMPTY_PROJECTS_FILE } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import type { Registry } from './campaignView'
import { openEvidence } from './taskActions'

vi.mock('../../lib/tauri', async (original) => ({
  ...(await original<typeof import('../../lib/tauri')>()),
  findRepositoryFile: vi.fn(async () => 'C:/project/night.md'),
  listDirectory: vi.fn(async () => {
    throw new Error('file')
  }),
}))
beforeEach(() => {
  vi.clearAllMocks()
  useUiStore.setState({
    rightSidebarMarkdown: null,
    rightSidebarMarkdownTabs: [],
    linkViewerUrl: null,
    toasts: [],
  })
})
const registry = {
  projectId: 'project',
  main: 'C:/project',
  campaigns: [],
  checkouts: {
    main: 'C:/project',
    worktrees: [{ path: 'C:/project', branch: 'dev', lastCommitMs: null }],
  },
} as unknown as Registry

it('opens night evidence in the shared summary sidebar and keeps checkout boundaries', async () => {
  await openEvidence(registry, 'NIGHT-01', 'night.md', ((key: string) => key) as TFunction)
  expect(listDirectory).toHaveBeenCalledWith('C:/project/night.md')
  // Scoped to its checkout, so the viewer reads it under the repository's rule.
  expect(useUiStore.getState().rightSidebarMarkdown).toEqual({
    path: 'C:/project/night.md',
    title: 'night.md',
    scope: 'C:/project',
  })
  expect(useUiStore.getState().linkViewerUrl).toBeNull()
  vi.mocked(findRepositoryFile).mockClear()
  await openEvidence(registry, 'NIGHT-01', '../private.md', ((key: string) => key) as TFunction)
  expect(findRepositoryFile).not.toHaveBeenCalled()
})

it('opens nothing for evidence reached through a link and says why', async () => {
  vi.mocked(findRepositoryFile).mockRejectedValueOnce('outside_repository')
  await openEvidence(registry, 'NIGHT-01', 'docs/linked.md', ((key: string) => key) as TFunction)
  expect(findRepositoryFile).toHaveBeenCalledWith('C:/project', 'docs/linked.md')
  expect(listDirectory).not.toHaveBeenCalled()
  expect(useUiStore.getState().rightSidebarMarkdown).toBeNull()
  expect(useUiStore.getState().toasts.at(-1)?.body).toBe('todo.night.evidenceOutsideRepository')
})

it('opens other evidence in a file pane that keeps its checkout for every later read', async () => {
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: false })
  const project = useProjectsStore
    .getState()
    .createProject({ name: 'Project', defaultCwd: 'C:/project' })
  vi.mocked(findRepositoryFile).mockResolvedValueOnce('C:/project/docs/report.txt')
  await openEvidence(
    { ...registry, projectId: project.id } as Registry,
    'NIGHT-01',
    'docs/report.txt',
    ((key: string) => key) as TFunction,
  )
  const pane = useProjectsStore
    .getState()
    .projects.find((item) => item.id === project.id)
    ?.terminals.find((terminal) => terminal.filePath === 'C:/project/docs/report.txt')
  expect(pane).toMatchObject({ kind: 'file', fileScope: 'C:/project' })
})
