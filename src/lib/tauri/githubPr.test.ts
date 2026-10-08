import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}))

import { githubPrListMine, type MyPullRequestSummary } from './githubPr'

const pr = (number: number): MyPullRequestSummary => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  repo: 'o/r',
  author: 'me',
  isDraft: false,
  updatedAt: '2026-09-29T00:00:00Z',
})

describe('githubPrListMine', () => {
  beforeEach(() => {
    invoke.mockReset()
  })

  it('lists the PRs of the given repository folder', async () => {
    invoke.mockResolvedValueOnce([pr(1)])

    await expect(githubPrListMine('C:/repos/app')).resolves.toEqual([pr(1)])
    expect(invoke).toHaveBeenCalledWith('github_pr_list_mine', { repo: 'C:/repos/app' })
  })

  it.each(['', '   '])(
    'never turns an empty path (%j) into an account-wide search',
    async (repo) => {
      await expect(githubPrListMine(repo)).resolves.toEqual([])
      expect(invoke).not.toHaveBeenCalled()
    },
  )

  it('propagates the error instead of falling back to other repositories', async () => {
    invoke.mockRejectedValueOnce('github_command_failed:not a git repository')

    await expect(githubPrListMine('C:/')).rejects.toBe('github_command_failed:not a git repository')
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})
