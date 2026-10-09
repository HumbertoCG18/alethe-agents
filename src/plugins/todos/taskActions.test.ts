import { describe, expect, it, vi } from 'vitest'

import type { Campaign } from '../../lib/campaigns'
import { findRelativePath } from '../../lib/tauri'
import type { Registry } from './campaignView'
import { campaignMarkdown } from './taskActions'

vi.mock('../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/tauri')>()),
  findRelativePath: vi.fn(),
}))

const checkout = (path: string) => ({ path, branch: null, lastCommitMs: null })
const registry = {
  main: 'C:\\repo',
  checkouts: { main: 'C:\\repo', worktrees: [checkout('C:\\repo'), checkout('C:\\repo-ui')] },
} as unknown as Registry
const task = (id: string, evidence: string | null) => ({ id, evidence })
const campaign = {
  id: 'UI',
  worktrees: ['repo-ui'],
  handoff: '.workflow/ui.md',
  tasks: [
    task('UI-01', 'docs/a.md'),
    task('UI-02', 'docs/missing.md'),
    task('UI-03', 'docs/folder'),
    task('UI-04', 'tested and merged'),
    task('UI-05', 'docs\\a.md'),
    task('UI-06', '../outside/b.md'),
  ],
} as unknown as Campaign

describe('campaignMarkdown', () => {
  it('lists the handoff and the Markdown evidence found inside the checkouts, once each', async () => {
    const found: Record<string, string> = {
      '.workflow/ui.md': 'C:\\repo\\.workflow\\ui.md',
      'docs/a.md': 'C:\\repo-ui\\docs\\a.md',
      'docs\\a.md': 'C:\\repo-ui\\docs\\a.md',
    }
    vi.mocked(findRelativePath).mockImplementation(async (_cwd, path) => found[path] ?? null)

    expect(await campaignMarkdown(campaign, registry)).toEqual([
      { path: 'C:\\repo\\.workflow\\ui.md', written: '.workflow/ui.md', task: null },
      { path: 'C:\\repo-ui\\docs\\a.md', written: 'docs/a.md', task: 'UI-01' },
    ])
    // The handoff from the main checkout, evidence from the campaign's worktree; prose, folders
    // and paths leaving the checkouts are never looked up.
    expect(vi.mocked(findRelativePath).mock.calls).toEqual([
      ['C:\\repo', '.workflow/ui.md'],
      ['C:\\repo-ui', 'docs/a.md'],
      ['C:\\repo-ui', 'docs/missing.md'],
      ['C:\\repo-ui', 'docs\\a.md'],
    ])
  })
})
