import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_PROJECTS_FILE } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { HomeView } from '.'

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
// The widgets around the quick prompt have nothing to do with where its terminal starts.
vi.mock('./ActivityGraph', () => ({ ActivityGraph: () => null, computeStreak: () => 0 }))
vi.mock('./NowPlayingWidget', () => ({ NowPlayingWidget: () => null }))
vi.mock('./SetupWalkthrough', () => ({ SetupWalkthrough: () => null }))
vi.mock('./TimeAnalytics', () => ({ TimeAnalytics: () => null }))
vi.mock('./UsageStrip', () => ({ UsageStrip: () => null }))
vi.mock('../ui/ascii-effect', () => ({ AsciiEffect: () => null }))

const createAgentTerminal = vi.fn(async () => ({ id: 'terminal-1' }))

beforeEach(() => {
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: false })
  createAgentTerminal.mockClear()
  useProjectsStore.setState({ createAgentTerminal } as never)
  useProjectsStore.getState().createProject({ name: 'Tutor', defaultCwd: 'C:\\repo-night' })
})
afterEach(cleanup)

describe('home quick prompt', () => {
  it('starts its terminal only after the anchor lands, in the main checkout', async () => {
    render(<HomeView />)
    const prompt = screen.getByLabelText('Prompt')
    fireEvent.change(prompt, { target: { value: 'fix the build' } })
    fireEvent.submit(prompt.closest('form')!)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(createAgentTerminal).not.toHaveBeenCalled()

    git.answer()

    await waitFor(() =>
      expect(createAgentTerminal).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ cwd: 'C:\\repo' }),
      ),
    )
  })
})
