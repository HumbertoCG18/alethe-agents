import { beforeEach, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
import { invoke } from '@tauri-apps/api/core'

import { discoverProviderModels } from './agents'

beforeEach(() => {
  vi.mocked(invoke).mockReset()
})

it('shares an in-flight catalog and reuses it on page reentry', async () => {
  let finish!: (value: unknown) => void
  vi.mocked(invoke).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const first = discoverProviderModels('codex')
  const second = discoverProviderModels('codex')
  expect(invoke).toHaveBeenCalledTimes(1)
  finish([{ id: 'current-model', label: 'Current model' }])
  expect(await second).toEqual(await first)
  await discoverProviderModels('codex')
  expect(invoke).toHaveBeenCalledTimes(1)
})

it('allows another attempt after a discovery failure', async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce([])
  await expect(discoverProviderModels('claude')).rejects.toThrow('unavailable')
  await expect(discoverProviderModels('claude')).resolves.toEqual([])
  expect(invoke).toHaveBeenCalledTimes(2)
})
