import { invoke } from '@tauri-apps/api/core'

export type PullRequestSummary = {
  number: number
  title: string
  body: string
  url: string
  baseBranch: string
  headBranch: string
  headSha: string
  mergeState: string
  isDraft: boolean
  author: string
  reviewDecision: string | null
}

export async function githubPrFind(
  repo: string,
  headBranch: string,
): Promise<PullRequestSummary[]> {
  return invoke<PullRequestSummary[]>('github_pr_find', { repo, headBranch })
}

export async function githubPrMerge(
  repo: string,
  number: number,
  method: 'merge' | 'squash' | 'rebase' = 'squash',
  expectedHeadSha?: string,
): Promise<string> {
  return invoke<string>('github_pr_merge', { repo, number, method, expectedHeadSha })
}

export type MyPullRequestSummary = {
  number: number
  title: string
  url: string
  repo: string
  author: string
  isDraft: boolean
  updatedAt: string
}

/** Without a repo path, falls back to every open PR the `gh` user is involved in. */
export async function githubPrListMine(repo?: string): Promise<MyPullRequestSummary[]> {
  return invoke<MyPullRequestSummary[]>('github_pr_list_mine', { repo: repo ?? null })
}

/**
 * The project's own PRs when its folder can be listed, else the account-wide list.
 * A project folder is not always a GitHub checkout (e.g. one opened on `C:\`): `gh` then
 * fails on git's "not a git repository", or on a missing remote. The account-wide list still
 * answers "what PRs do I have open", so fall back to it instead of surfacing that error.
 * `scoped` says which list came back, for the header label and the empty state.
 */
export async function githubPrListForProject(
  repo?: string,
): Promise<{ prs: MyPullRequestSummary[]; scoped: boolean }> {
  if (repo) {
    try {
      return { prs: await githubPrListMine(repo), scoped: true }
    } catch {
      // Fall through to the account-wide list; if that fails too, its error is the useful one.
    }
  }
  return { prs: await githubPrListMine(), scoped: false }
}
