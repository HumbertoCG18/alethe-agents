import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { translate } from '../../lib/i18n'
import type { GitRepositoryStatus } from '../../lib/tauri'
import { GitControl } from './GitControl'

const askConfirm = vi.hoisted(() => vi.fn<(message: string) => Promise<boolean>>())
const tauri = vi.hoisted(() => ({
  gitStatus: vi.fn(),
  gitDiscard: vi.fn(async () => {}),
}))

vi.mock('../../lib/dialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/dialog')>()),
  askConfirm,
}))
vi.mock('../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/tauri')>()),
  ...tauri,
}))
vi.mock('./GitGraph', () => ({ GitGraph: () => null }))
vi.mock('./IncomingOutgoing', () => ({ IncomingOutgoing: () => null }))

const status: GitRepositoryStatus = {
  repoRoot: '/repo',
  branch: 'main',
  detached: false,
  ahead: 0,
  behind: 0,
  staged: [],
  changes: [{ path: 'src/app.ts', originalPath: null, status: 'M' }],
  untracked: [],
  conflicts: [],
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  askConfirm.mockReset()
  tauri.gitStatus.mockResolvedValue(status)
  tauri.gitDiscard.mockClear()
  // What tauri-plugin-dialog injects: an async confirm whose Promise is always truthy.
  vi.stubGlobal(
    'confirm',
    vi.fn(async () => false),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function discardFile() {
  render(<GitControl projectId="proj-1" cwd="/repo" ptyId={null} terminalName="Shell" />)
  fireEvent.click(await screen.findByRole('button', { name: translate('en', 'git.discard') }))
}

describe('GitControl discard', () => {
  it('does nothing when the user cancels', async () => {
    askConfirm.mockResolvedValue(false)
    await discardFile()
    await flush()
    expect(tauri.gitDiscard).not.toHaveBeenCalled()
    expect(askConfirm).toHaveBeenCalledWith(translate('en', 'git.confirm.discard', { count: 1 }))
  })

  it('discards when the user confirms', async () => {
    askConfirm.mockResolvedValue(true)
    await discardFile()
    await vi.waitFor(() =>
      expect(tauri.gitDiscard).toHaveBeenCalledWith('/repo', ['src/app.ts'], false),
    )
  })
})
