import { beforeEach, expect, it, vi } from 'vitest'

import type { TFunction } from '../../lib/i18n'
import { findRelativePath, listDirectory } from '../../lib/tauri'
import { useUiStore } from '../../stores/uiStore'
import type { Registry } from './campaignView'
import { openEvidence } from './taskActions'

vi.mock('../../lib/tauri', async (original) => ({
  ...(await original<typeof import('../../lib/tauri')>()),
  findRelativePath: vi.fn(async () => 'C:/project/night.md'),
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
  })
})

it('opens night evidence in the shared summary sidebar and keeps checkout boundaries', async () => {
  const registry = {
    projectId: 'project',
    main: 'C:/project',
    campaigns: [],
    checkouts: {
      main: 'C:/project',
      worktrees: [{ path: 'C:/project', branch: 'dev', lastCommitMs: null }],
    },
  } as unknown as Registry
  await openEvidence(registry, 'NIGHT-01', 'night.md', ((key: string) => key) as TFunction)
  expect(listDirectory).toHaveBeenCalledWith('C:/project/night.md')
  expect(useUiStore.getState().rightSidebarMarkdown).toEqual({
    path: 'C:/project/night.md',
    title: 'night.md',
  })
  expect(useUiStore.getState().linkViewerUrl).toBeNull()
  vi.mocked(findRelativePath).mockClear()
  await openEvidence(registry, 'NIGHT-01', '../private.md', ((key: string) => key) as TFunction)
  expect(findRelativePath).not.toHaveBeenCalled()
})
