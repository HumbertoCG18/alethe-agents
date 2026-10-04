import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { translate } from '../../lib/i18n'
import { GitGraph } from './GitGraph'

const askConfirm = vi.hoisted(() => vi.fn<(message: string) => Promise<boolean>>())
const tauri = vi.hoisted(() => ({
  gitLogGraph: vi.fn(async () => []),
  gitResetToCommit: vi.fn(async () => {}),
}))

vi.mock('../../lib/dialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/dialog')>()),
  askConfirm,
}))
vi.mock('../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/tauri')>()),
  ...tauri,
}))
vi.mock('./GitGraphList', () => ({
  GitGraphList: ({ onOpenMenu }: { onOpenMenu: (x: number, y: number, hash: string) => void }) => (
    <button type="button" onClick={() => onOpenMenu(0, 0, 'abc123')}>
      commit menu
    </button>
  ),
}))

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  askConfirm.mockReset()
  tauri.gitResetToCommit.mockClear()
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

async function resetHard() {
  render(<GitGraph repoRoot="/repo" />)
  fireEvent.click(await screen.findByText('commit menu'))
  fireEvent.click(
    screen.getByRole('menuitem', { name: translate('en', 'git.graph.menu.resetHard') }),
  )
}

describe('GitGraph reset --hard', () => {
  it('does nothing when the user cancels', async () => {
    askConfirm.mockResolvedValue(false)
    await resetHard()
    await flush()
    expect(tauri.gitResetToCommit).not.toHaveBeenCalled()
    expect(askConfirm).toHaveBeenCalledWith(translate('en', 'git.graph.menu.resetHardConfirm'))
  })

  it('resets when the user confirms', async () => {
    askConfirm.mockResolvedValue(true)
    await resetHard()
    await vi.waitFor(() =>
      expect(tauri.gitResetToCommit).toHaveBeenCalledWith('/repo', 'abc123', 'hard'),
    )
  })
})
