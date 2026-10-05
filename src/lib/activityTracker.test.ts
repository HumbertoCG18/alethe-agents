import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectsStore } from '../stores/projectsStore'
import { useTerminalsStore } from '../stores/terminalsStore'
import { EMPTY_PROJECTS_FILE } from './types'

/** Each tracked pty's output listener, as the pty://activity event reaches it. */
const output = vi.hoisted(() => new Map<string, (chunk: string) => void>())

vi.mock('./tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tauri')>()),
  listenPtyData: vi.fn(async () => () => {}),
  listenPtyActivity: vi.fn(async (ptyId: string, handler: (chunk: string) => void) => {
    output.set(ptyId, handler)
    return () => output.delete(ptyId)
  }),
  listenOpenCodeBridgeStatus: vi.fn(async () => () => {}),
  recordActivitySamples: vi.fn(async () => {}),
}))

import { armAgentPrompt, startActivityTracker } from './activityTracker'

const PROMPT = 'Retome a campanha X pela tarefa X-01.'
const status = () => useTerminalsStore.getState().byPtyId['pty-1']?.status

/** A project whose only tab runs Claude Code on `pty-1`. */
function claudeTab() {
  useProjectsStore.setState({
    projects: [
      {
        id: 'project',
        terminals: [
          {
            id: 'terminal',
            tabs: [{ id: 'tab', type: 'claude', cwd: 'C:\\repo', ptyId: 'pty-1' }],
          },
        ],
      },
    ],
  } as never)
}

let stop: () => void = () => {}

beforeEach(() => {
  vi.useFakeTimers()
  output.clear()
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
  useTerminalsStore.getState().reset()
})
afterEach(() => {
  stop()
  stop = () => {}
  vi.useRealTimers()
})

// Prompts Alethe submits itself never pass through the terminal's keyboard, which is what arms
// an agent's monitor for the user's own (#74).
describe('armAgentPrompt', () => {
  it('counts a tracked agent as working until its reply goes quiet', async () => {
    claudeTab()
    useTerminalsStore.getState().registerPty('pty-1')
    stop = startActivityTracker()

    armAgentPrompt('pty-1', PROMPT)
    expect(status()).toBe('working')

    await vi.advanceTimersByTimeAsync(1_000)
    output.get('pty-1')?.('Reading the registry and the handoff…')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(status()).toBe('working')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(status()).toBe('waiting')
  })

  it('arms an agent spawned with the prompt once it is tracked, whichever pane shows it', async () => {
    stop = startActivityTracker()
    // Handed to the spawn before the tab has its pty: nothing tracks it yet.
    armAgentPrompt('pty-1', PROMPT)
    claudeTab()
    useTerminalsStore.getState().registerPty('pty-1')
    expect(status()).toBe('waiting')

    await vi.advanceTimersByTimeAsync(300)
    expect(status()).toBe('working')
    output.get('pty-1')?.('Claude Code banner and the first reply')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(status()).toBe('waiting')

    // Armed once: the next quiet stretch leaves it waiting.
    output.get('pty-1')?.('a status line redrawn by the agent')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(status()).toBe('waiting')
  })
})
