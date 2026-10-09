import { render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { ghosttySpawn } from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { GhosttySurface } from '.'

vi.mock('../../lib/tauri', () => ({
  ghosttySetFocus: vi.fn(async () => {}),
  ghosttySetFont: vi.fn(async () => {}),
  ghosttySetHidden: vi.fn(async () => {}),
  ghosttySpawn: vi.fn(async ({ id }: { id: string }) => ({ id, attached: false })),
  ghosttySurfaceExited: vi.fn(async () => false),
  ghosttySyncFrame: vi.fn(async () => {}),
}))

beforeEach(() => {
  vi.clearAllMocks()
  const observer = class {
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', observer)
  vi.stubGlobal('IntersectionObserver', observer)
  useUiStore.setState({ toasts: [], notifications: [] })
  useProjectsStore.setState((state) => ({
    preferences: { ...state.preferences, shellPath: '/bin/bash' },
    // The surface is the tab's: only what the lookup reads.
    projects: [
      { terminals: [{ tabs: [{ id: 'tab-1', ptyId: null, type: 'shell', shell: '/bin/zsh' }] }] },
    ] as never,
  }))
})
afterEach(() => vi.unstubAllGlobals())

it("spawns on the tab's own shell, the default as its fallback", async () => {
  render(<GhosttySurface surfaceId="tab-1" />)

  await waitFor(() =>
    expect(ghosttySpawn).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tab-1', shell: '/bin/zsh', fallbackShell: '/bin/bash' }),
    ),
  )
  expect(useUiStore.getState().notifications).toEqual([])
})

it('says so when the backend fell back because that shell is gone', async () => {
  vi.mocked(ghosttySpawn).mockResolvedValueOnce({
    id: 'tab-1',
    attached: false,
    shellFallback: true,
  })
  render(<GhosttySurface surfaceId="tab-1" />)

  await waitFor(() => expect(useUiStore.getState().notifications).toHaveLength(1))
  expect(useUiStore.getState().notifications[0]).toMatchObject({
    title: 'Saved shell is unavailable. The default shell is used instead.',
    body: '/bin/zsh',
  })
})
