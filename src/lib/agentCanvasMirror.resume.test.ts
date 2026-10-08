import { describe, expect, it, vi } from 'vitest'

import { resumeAgentCanvasMirror } from './agentCanvasMirror'
import { agentCanvasMirror, setAgentCanvasMirror } from './tauri'

vi.mock('./tauri', () => ({
  setAgentCanvasMirror: vi.fn(async () => undefined),
  agentCanvasMirror: vi.fn(async () => null),
}))

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

// Its own file: publishing, once started, lasts for the module, so it cannot share one with tests
// that start it.
describe('agent canvas mirror after a main window reload', () => {
  it('publishes again only when a board was detached during this run', async () => {
    vi.mocked(agentCanvasMirror).mockResolvedValueOnce(null)
    resumeAgentCanvasMirror()
    await settle()
    expect(setAgentCanvasMirror).not.toHaveBeenCalled()

    // A board keeps showing the last snapshot, so a reloaded main window has to keep feeding it.
    vi.mocked(agentCanvasMirror).mockResolvedValueOnce('{"seq":1}')
    resumeAgentCanvasMirror()
    await settle()
    expect(setAgentCanvasMirror).toHaveBeenCalledTimes(1)
  })
})
