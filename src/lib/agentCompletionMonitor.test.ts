import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentCompletionMonitor } from './agentCompletionMonitor'
import { notifyAgentDone } from './notifications'

vi.mock('./notifications', () => ({ notifyAgentDone: vi.fn(async () => {}) }))

function monitor() {
  const onStatusChange = vi.fn()
  const onComplete = vi.fn()
  const watched = new AgentCompletionMonitor({
    ptyId: 'pty-1',
    agent: 'claude',
    onStatusChange,
    onComplete,
  })
  return { watched, onStatusChange, onComplete }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
})
afterEach(() => vi.useRealTimers())

// An armed monitor always settles: the reply may be too short to count as work, or may all have
// come out before anything listened (#74).
describe('AgentCompletionMonitor', () => {
  it('settles after a short reply followed by silence', async () => {
    const { watched, onStatusChange, onComplete } = monitor()
    watched.arm('Say OK.')
    await vi.advanceTimersByTimeAsync(1_000)
    watched.handleOutput('OK')
    await vi.advanceTimersByTimeAsync(10_000)

    expect(onStatusChange.mock.calls).toEqual([['working'], ['waiting']])
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(notifyAgentDone).toHaveBeenCalledTimes(1)
  })

  it('settles when the whole reply came before it was listening', async () => {
    const { watched, onStatusChange, onComplete } = monitor()
    watched.arm('Retome a campanha X.')
    await vi.advanceTimersByTimeAsync(10_000)

    expect(onStatusChange.mock.calls).toEqual([['working'], ['waiting']])
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('stays working while the reply keeps coming, and settles once it goes quiet', async () => {
    const { watched, onStatusChange, onComplete } = monitor()
    watched.arm('Retome a campanha X.')
    for (let second = 0; second < 10; second++) {
      await vi.advanceTimersByTimeAsync(1_000)
      watched.handleOutput(`still working, step ${second}`)
    }
    expect(onStatusChange.mock.calls).toEqual([['working'], ['working']])
    expect(onComplete).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5_000)
    expect(onStatusChange).toHaveBeenLastCalledWith('waiting')
    expect(onComplete).toHaveBeenCalledTimes(1)
  })
})
