import { waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TFunction } from '../../lib/i18n'
import { EMPTY_PROJECTS_FILE } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { runPlan } from './runPlan'

/** Git answers the anchor only when the test lets it. */
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
const t = ((key: string) => key) as TFunction

beforeEach(() => {
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: false })
  createAgentTerminal.mockClear()
  useProjectsStore.setState({ createAgentTerminal } as never)
})

describe('voice plan', () => {
  it('opens its terminals only after the anchor lands, in the main checkout', async () => {
    const project = useProjectsStore
      .getState()
      .createProject({ name: 'Tutor', defaultCwd: 'C:\\repo-night' })

    const running = runPlan(
      {
        kind: 'spawn',
        projectId: project.id,
        projectName: project.name,
        jobs: [{ agent: 'claude', prompt: 'fix the build' }],
      },
      t,
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(createAgentTerminal).not.toHaveBeenCalled()

    git.answer()
    await running

    await waitFor(() =>
      expect(createAgentTerminal).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({ cwd: 'C:\\repo' }),
      ),
    )
  })
})
