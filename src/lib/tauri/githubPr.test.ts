import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}))

import { githubPrListForProject, type MyPullRequestSummary } from './githubPr'

const pr = (number: number): MyPullRequestSummary => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  repo: 'o/r',
  author: 'me',
  isDraft: false,
  updatedAt: '2026-09-29T00:00:00Z',
})

describe('githubPrListForProject', () => {
  beforeEach(() => {
    invoke.mockReset()
  })

  it('returns the project list, marked as scoped, when the folder can be listed', async () => {
    invoke.mockResolvedValueOnce([pr(1)])

    const result = await githubPrListForProject('C:\\repos\\app')

    expect(result).toEqual({ prs: [pr(1)], scoped: true })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('github_pr_list_mine', { repo: 'C:\\repos\\app' })
  })

  it('falls back to the account-wide list when the folder is not a git checkout', async () => {
    invoke
      .mockRejectedValueOnce(
        'github_command_failed:failed to run git: fatal: not a git repository (or any of the parent directories): .git',
      )
      .mockResolvedValueOnce([pr(2), pr(3)])

    const result = await githubPrListForProject('C:\\')

    expect(result).toEqual({ prs: [pr(2), pr(3)], scoped: false })
    expect(invoke).toHaveBeenNthCalledWith(1, 'github_pr_list_mine', { repo: 'C:\\' })
    expect(invoke).toHaveBeenNthCalledWith(2, 'github_pr_list_mine', { repo: null })
  })

  it('goes straight to the account-wide list when there is no project folder', async () => {
    invoke.mockResolvedValueOnce([pr(4)])

    const result = await githubPrListForProject(undefined)

    expect(result).toEqual({ prs: [pr(4)], scoped: false })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('github_pr_list_mine', { repo: null })
  })

  it('surfaces the account-wide error when both lists fail', async () => {
    invoke
      .mockRejectedValueOnce('github_command_failed:not a git repository')
      .mockRejectedValueOnce('github_command_failed:gh auth login required')

    await expect(githubPrListForProject('C:\\')).rejects.toBe(
      'github_command_failed:gh auth login required',
    )
  })
})
