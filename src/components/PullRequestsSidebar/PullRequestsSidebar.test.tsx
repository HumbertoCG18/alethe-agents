import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_PROJECTS_FILE } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { PullRequestsSidebar } from '.'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  invoke: (...args: unknown[]) => invoke(...args),
}))

function activate(input: { checkoutPath?: string; defaultCwd?: string }) {
  const store = useProjectsStore.getState()
  const id = store.createProject({ name: 'Tutor', defaultCwd: input.defaultCwd }).id
  if (input.checkoutPath) store.setProjectCheckout(id, input.checkoutPath)
  useProjectsStore.setState({ activeProjectId: id })
}

beforeEach(() => {
  invoke.mockReset()
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: false })
})
afterEach(cleanup)

describe('PullRequestsSidebar', () => {
  it('queries the checkout folder even when the project has no terminal', async () => {
    invoke.mockResolvedValue([])
    activate({ checkoutPath: 'C:/repo', defaultCwd: 'C:/worktree' })
    render(<PullRequestsSidebar />)

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('github_pr_list_mine', { repo: 'C:/repo' }),
    )
  })

  it('makes no gh call and says so when the project has no repository folder', async () => {
    activate({})
    render(<PullRequestsSidebar />)

    expect(await screen.findByText('No repository folder')).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('shows the error, never other repositories, when the scoped call fails', async () => {
    invoke.mockRejectedValue('github_command_failed:not a git repository')
    activate({ defaultCwd: 'C:/' })
    render(<PullRequestsSidebar />)

    expect(await screen.findByText(/not a git repository/)).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('github_pr_list_mine', { repo: 'C:/' })
  })

  it("drops a previous project's answer that arrives after the switch", async () => {
    let answer: (prs: unknown) => void = () => {}
    invoke.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    activate({ checkoutPath: 'C:/a' })
    render(<PullRequestsSidebar />)
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))

    act(() => activate({}))
    expect(await screen.findByText('No repository folder')).toBeInTheDocument()
    await act(async () =>
      answer([
        {
          number: 1,
          title: 'A pull request of the previous project',
          url: 'https://github.com/o/a/pull/1',
          repo: 'o/a',
          author: 'me',
          isDraft: false,
          updatedAt: '2026-10-08T00:00:00Z',
        },
      ]),
    )

    expect(screen.queryByText('A pull request of the previous project')).toBeNull()
    expect(screen.getByText('No repository folder')).toBeInTheDocument()
  })
})
