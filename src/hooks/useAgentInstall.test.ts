import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { InstallMethod } from '../lib/agentInstall'

const tauri = vi.hoisted(() => ({
  agentCliVersion: vi.fn(),
  killPty: vi.fn(),
  listenPtyData: vi.fn(),
  listenPtyExit: vi.fn(),
  refreshCliLauncher: vi.fn(),
  spawnPty: vi.fn(),
  writePty: vi.fn(),
}))

vi.mock('../lib/tauri', () => tauri)
vi.mock('../lib/agentProviders', () => ({ resolveAgentCliCommand: () => 'freebuff' }))

import { acquireAgentOperation, releaseAgentOperation, useAgentInstall } from './useAgentInstall'

const NODE_WINGET: InstallMethod = {
  id: 'winget',
  command: 'winget install OpenJS.NodeJS.LTS',
  requires: 'winget',
  verifyCommand: 'npm',
}
const NATIVE: InstallMethod = {
  id: 'native',
  command: 'irm https://example.test/install.ps1 | iex',
}

let exitPty: (payload: { code: number | null }) => void

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  tauri.agentCliVersion.mockResolvedValue(null)
  tauri.refreshCliLauncher.mockResolvedValue(null)
  tauri.spawnPty.mockImplementation(async ({ id }: { id: string }) => ({ id }))
  tauri.listenPtyData.mockResolvedValue(() => undefined)
  tauri.listenPtyExit.mockImplementation(async (_id: string, callback: typeof exitPty) => {
    exitPty = callback
    return () => undefined
  })
  tauri.writePty.mockResolvedValue(undefined)
  tauri.killPty.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

async function pollOnce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_500)
  })
}

describe('useAgentInstall', () => {
  it('lets a package manager finish instead of killing it when the CLI shows up mid-run', async () => {
    const { result, unmount } = renderHook(() => useAgentInstall('freebuff', 'node-toolchain'))
    await act(() => result.current.install(NODE_WINGET))

    // The MSI copies npm.cmd long before it has finished installing Node.
    tauri.refreshCliLauncher.mockResolvedValue('C:\\Program Files\\nodejs\\npm.cmd')
    await pollOnce()
    await pollOnce()

    expect(tauri.killPty).not.toHaveBeenCalled()
    expect(result.current.status).toBe('running')

    await act(async () => exitPty({ code: 0 }))
    expect(result.current.status).toBe('success')
    unmount()
  })

  it('still settles a native script that never hands the shell back', async () => {
    const { result, unmount } = renderHook(() => useAgentInstall('freebuff'))
    await act(() => result.current.install(NATIVE))

    tauri.refreshCliLauncher.mockResolvedValue('C:\\Users\\me\\.local\\bin\\freebuff.exe')
    await pollOnce()

    expect(result.current.status).toBe('success')
    unmount()
  })

  it('lets the shell run npm.ps1 under the Restricted policy of a fresh Windows', async () => {
    const { result, unmount } = renderHook(() => useAgentInstall('freebuff'))
    await act(() => result.current.install(NATIVE))

    expect(tauri.spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({ env: { PSExecutionPolicyPreference: 'RemoteSigned' } }),
    )
    unmount()
  })

  it('never starts the installer when the run is cancelled while the shell is starting', async () => {
    let finishSpawn: (value: { id: string }) => void = () => undefined
    tauri.spawnPty.mockImplementation(
      ({ id }: { id: string }) =>
        new Promise((resolve) => {
          finishSpawn = () => resolve({ id })
        }),
    )
    const { result, unmount } = renderHook(() => useAgentInstall('freebuff'))

    let run: Promise<void> = Promise.resolve()
    act(() => {
      run = result.current.install(NATIVE)
    })
    await vi.waitFor(() => expect(tauri.spawnPty).toHaveBeenCalled())
    act(() => result.current.reset())
    await act(async () => {
      finishSpawn({ id: 'late' })
      await run
    })

    expect(tauri.writePty).not.toHaveBeenCalled()
    expect(tauri.killPty).toHaveBeenCalled()
    expect(result.current.status).toBe('idle')
    // The app-wide lock is free again for the next install.
    expect(acquireAgentOperation('probe')).toBe(true)
    releaseAgentOperation('probe')
    unmount()
  })

  it.each(['listenPtyData', 'listenPtyExit'] as const)(
    'drops the %s listener that finishes registering after a cancel',
    async (listener) => {
      const stop = vi.fn()
      let finishListen: () => void = () => undefined
      tauri[listener].mockImplementation(
        () =>
          new Promise((resolve) => {
            finishListen = () => resolve(stop)
          }),
      )
      const { result, unmount } = renderHook(() => useAgentInstall('freebuff'))

      let run: Promise<void> = Promise.resolve()
      act(() => {
        run = result.current.install(NATIVE)
      })
      await vi.waitFor(() => expect(tauri[listener]).toHaveBeenCalled())
      act(() => result.current.reset())
      await act(async () => {
        finishListen()
        await run
      })

      expect(stop).toHaveBeenCalled()
      expect(tauri.writePty).not.toHaveBeenCalled()
      unmount()
    },
  )
})
