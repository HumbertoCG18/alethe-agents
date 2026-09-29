import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const router9 = vi.hoisted(() => ({ reset: vi.fn() }))

vi.mock('../../hooks/useRouter9Install', () => ({
  useRouter9Install: () => ({
    status: 'running',
    action: 'install',
    log: '',
    run: vi.fn(),
    reset: router9.reset,
  }),
}))

vi.mock('../../hooks/useAgentInstall', () => ({
  useAgentInstall: () => ({ status: 'idle', log: '', install: vi.fn(), reset: vi.fn() }),
  useAgentOperationBusy: () => 'router9',
}))

vi.mock('../../lib/tauri', () => ({
  openInBrowser: vi.fn(),
  probeInstallToolchain: vi.fn(async () => ({
    node: 'v22.3.0',
    npm: true,
    winget: false,
    scoop: false,
    choco: false,
    bun: false,
    pnpm: false,
  })),
}))

import { Router9InstallModal } from './Router9InstallModal'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Router9InstallModal', () => {
  it('cancels a running install instead of trapping the user in the modal', () => {
    const onClose = vi.fn()
    render(<Router9InstallModal action="install" open onClose={onClose} />)

    // Opening the modal already resets once; only the reset done by Cancel counts.
    router9.reset.mockClear()
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    expect(cancel).toBeEnabled()
    fireEvent.click(cancel)

    expect(router9.reset).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalled()
  })
})
