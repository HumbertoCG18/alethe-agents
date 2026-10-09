import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Detected = { installed: boolean; running: boolean }

const aiMemoryStart = vi.fn(async () => {})
const aiMemoryDetect = vi.fn<() => Promise<Detected>>(async () => ({
  installed: true,
  running: false,
}))
let aiMemoryEnabled = true

vi.mock('../lib/aiMemory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/aiMemory')>()),
  aiMemoryStart: (port: number) => aiMemoryStart(port),
}))

vi.mock('../lib/tauri', () => ({
  aiMemoryDetect: () => aiMemoryDetect(),
}))

vi.mock('../stores/projectsStore', () => ({
  useProjectsStore: {
    getState: () => ({ preferences: { enabledFeatures: { aiMemory: aiMemoryEnabled } } }),
  },
}))

const { useAiMemoryAutoStart } = await import('./useAiMemoryAutoStart')

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function renderForProfile(profileId: string) {
  return renderHook(({ profileId }) => useAiMemoryAutoStart(true, profileId), {
    initialProps: { profileId },
  })
}

beforeEach(() => {
  aiMemoryStart.mockClear()
  aiMemoryEnabled = true
})

describe('useAiMemoryAutoStart', () => {
  it('starts once for the active profile, not on every render', async () => {
    const { rerender } = renderForProfile('a')
    await flush()
    rerender({ profileId: 'a' })
    await flush()

    expect(aiMemoryStart).toHaveBeenCalledTimes(1)
  })

  it('starts again after a profile switch, which stopped the previous server', async () => {
    const { rerender } = renderForProfile('a')
    await flush()
    rerender({ profileId: 'b' })
    await flush()

    expect(aiMemoryStart).toHaveBeenCalledTimes(2)
  })

  it('leaves it off for a profile that has the feature off', async () => {
    const { rerender } = renderForProfile('a')
    await flush()
    aiMemoryEnabled = false
    rerender({ profileId: 'b' })
    await flush()

    expect(aiMemoryStart).toHaveBeenCalledTimes(1)
  })

  it('starts again on returning from a profile that has the feature off', async () => {
    const { rerender } = renderForProfile('a')
    await flush()
    aiMemoryEnabled = false
    rerender({ profileId: 'b' })
    await flush()
    aiMemoryEnabled = true
    rerender({ profileId: 'a' })
    await flush()

    expect(aiMemoryStart).toHaveBeenCalledTimes(2)
  })

  it('drops a detection that answers after the profile changed', async () => {
    let answer: (status: Detected) => void = () => undefined
    aiMemoryDetect.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    const { rerender } = renderForProfile('a')
    aiMemoryEnabled = false
    rerender({ profileId: 'b' })
    answer({ installed: true, running: false })
    await flush()

    expect(aiMemoryStart).not.toHaveBeenCalled()
  })
})
