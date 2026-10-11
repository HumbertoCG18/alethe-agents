import { act, renderHook, waitFor } from '@testing-library/react'
import type { Mock } from 'vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { armAgentPrompt } from '../../lib/activityTracker'
import { deliverOpenCodePrompt } from '../../lib/agentPromptDelivery'
import { plannerLabelFor } from '../../lib/claudeMcpConfigs'
import { notifyAgentDone } from '../../lib/notifications'
import { isWindows } from '../../lib/platform'
import { resetSessionClaimsForTests } from '../../lib/sessionDiscovery'
import { peekSession, saveSession } from '../../lib/sessionResume'
import * as tauri from '../../lib/tauri'
import { EMPTY_PROJECTS_FILE } from '../../lib/types'
import type { AgentHookPayload } from '../../stores/agentCanvasStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useUiStore } from '../../stores/uiStore'
import { resetInitialInputsForTests, submitInitialInput, useXtermSession } from './useXtermSession'

const hooks = vi.hoisted(() => new Set<(event: { payload: AgentHookPayload }) => void>())
const scrolls = vi.hoisted(() => [] as Array<() => void>)
/** The latest output listener of each pty, as pty://activity reaches it. */
const activity = vi.hoisted(() => new Map<string, (chunk: string) => void>())
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name, handler) => {
    hooks.add(handler)
    return () => {
      hooks.delete(handler)
    }
  }),
}))
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}))
const exits = vi.hoisted(() => new Map<string, (payload: { code?: number }) => void>())
const terminals = vi.hoisted(
  () => [] as Array<{ writes: string[]; modes: Record<string, unknown> }>,
)
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    unicode = { activeVersion: '11' }
    options = { fontSize: 14 }
    buffer = {
      active: {
        type: 'normal' as 'normal' | 'alternate',
        baseY: 0,
        viewportY: 0,
        getLine: () => undefined,
      },
    }
    modes = {
      mouseTrackingMode: 'none',
      bracketedPasteMode: false,
      sendFocusMode: false,
    }
    writes: string[] = []
    scrollLines = vi.fn()
    scrollToLine = vi.fn()
    scrollToBottom() {}
    clear() {}
    constructor() {
      terminals.push(this)
    }
    write(data: string, callback?: () => void) {
      this.writes.push(data)
      if (callback) queueMicrotask(callback)
    }
    loadAddon() {}
    open() {}
    focus() {}
    registerLinkProvider() {
      return { dispose() {} }
    }
    onScroll(handler: () => void) {
      scrolls.push(handler)
      return { dispose() {} }
    }
    keyHandler?: (event: KeyboardEvent) => boolean
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      this.keyHandler = handler
    }
    onData() {}
    dispose() {}
    refresh() {}
    writeln() {}
    // A full reset (RIS) leaves the alternate screen and turns the modes off.
    reset() {
      this.buffer.active.type = 'normal'
      this.modes = { mouseTrackingMode: 'none', bracketedPasteMode: false, sendFocusMode: false }
    }
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }))
const panel = vi.hoisted(() => ({ visible: false }))
vi.mock('../../lib/ptyVisibility', () => ({ usePtyPanelVisible: () => panel.visible }))
vi.mock('../../lib/activityTracker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/activityTracker')>()),
  armAgentPrompt: vi.fn(),
}))
vi.mock('../../lib/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/notifications')>()),
  notifyAgentDone: vi.fn(async () => {}),
}))
vi.mock('../../lib/agentPromptDelivery', () => ({
  deliverOpenCodePrompt: vi.fn(async () => true),
}))
vi.mock('../../lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/platform')>()),
  isWindows: vi.fn(() => false),
}))
vi.mock('../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof tauri>()),
  ptyExists: vi.fn(async () => false),
  attachPty: vi.fn(async () => ''),
  setPtyVisible: vi.fn(async () => true),
  listenPtyData: vi.fn(async () => () => {}),
  listenPtyActivity: vi.fn(async (id: string, handler: (chunk: string) => void) => {
    activity.set(id, handler)
    return () => {}
  }),
  listenPtyExit: vi.fn(async (id: string, handler: (payload: { code?: number }) => void) => {
    exits.set(id, handler)
    return () => {
      exits.delete(id)
    }
  }),
  findCliLauncher: vi.fn(async () => 'claude'),
  snapshotClaudeSessions: vi.fn(async () => [
    { id: 'bananas', modified_at_ms: 1 },
    { id: 'new-chat', modified_at_ms: 2 },
  ]),
  agentHooksSettingsPath: vi.fn(async () => 'hooks.json'),
  spawnPty: vi.fn(async () => ({ id: 'pty-0' })),
  writePty: vi.fn(async () => {}),
  clearPtyScrollback: vi.fn(async () => {}),
}))

function emit(sessionId: string, plannerId = 'pty-0') {
  for (const handler of hooks)
    handler({
      payload: {
        hook_event_name: 'SessionStart',
        session_id: sessionId,
        plannerId,
      },
    })
}

const ref = <T>(current: T) => ({ current })
function params(): Parameters<typeof useXtermSession>[0] {
  return {
    ptyId: 'pty-0',
    command: 'claude',
    cwd: 'D:/repo',
    sessionId: 'bananas',
    runtimeProfile: 'lean',
    terminalTheme: 'dark',
    cliPathOverride: null,
    sessionPersistenceKey: 'tab-0',
    retryKey: 0,
    containerRef: ref(document.createElement('div')),
    terminalRef: ref(null),
    ptyIdRef: ref(null),
    lastCtrlCRef: ref(0),
    spawnedAtRef: ref(0),
    usedResumeRef: ref(false),
    earlyExitRetriedRef: ref(false),
    forceFreshRef: ref(false),
    onSpawnedRef: ref(vi.fn()),
    onSessionIdRef: ref(vi.fn()),
    onInitialInputSentRef: ref(vi.fn()),
    onExitRef: ref(vi.fn()),
    onLaunchErrorRef: ref(vi.fn()),
    onAgentCompleteRef: ref(vi.fn()),
    setBootPhase: vi.fn(),
    setCommandNotFound: vi.fn(),
    hideLinkActions: vi.fn(),
    setRetryKey: vi.fn(),
    setDropActive: vi.fn(),
    showLinkActionsMenu: vi.fn(),
    recordPromptInput: () => false,
    navigateHistory: vi.fn(),
  }
}

type MockTerminal = {
  writes: string[]
  buffer: { active: { type: 'normal' | 'alternate' } }
  modes: { mouseTrackingMode: string; bracketedPasteMode: boolean; sendFocusMode: boolean }
  scrollLines: Mock
  keyHandler: (event: KeyboardEvent) => boolean
}

/** The terminal the hook built, with the pieces these tests read and drive. */
function paneTerminal(input: Parameters<typeof useXtermSession>[0]): MockTerminal {
  return input.terminalRef.current as unknown as MockTerminal
}

beforeEach(() => {
  vi.clearAllMocks()
  panel.visible = false
  hooks.clear()
  activity.clear()
  localStorage.clear()
  resetSessionClaimsForTests()
  resetInitialInputsForTests()
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: false })
  useTerminalsStore.setState({ byPtyId: {} })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
})
afterEach(() => vi.unstubAllGlobals())

describe('plannerLabelFor', () => {
  // Only what the lookup reads: a project's terminals, their names and their tabs' ids.
  function withTerminal(name: string, tab: { id: string; ptyId: string | null }) {
    useProjectsStore.setState({ projects: [{ terminals: [{ name, tabs: [tab] }] }] } as never)
  }

  it('names a planner by its terminal before the first spawn has given the tab a pty (#264)', () => {
    // The pane spawns under `tab.ptyId ?? tab.id`; the tab only gets its ptyId after the spawn.
    withTerminal('Night planner', { id: 'tab-1', ptyId: null })
    expect(plannerLabelFor('tab-1')).toBe('Night planner')
  })

  it('still finds a terminal by the pty its tab already has', () => {
    withTerminal('Night planner', { id: 'tab-1', ptyId: 'pty-9' })
    expect(plannerLabelFor('pty-9')).toBe('Night planner')
  })

  it('falls back to the id when no terminal has it', () => {
    withTerminal('Night planner', { id: 'tab-1', ptyId: 'pty-9' })
    expect(plannerLabelFor('tab-1')).toBe('tab-1')
    expect(plannerLabelFor('elsewhere')).toBe('elsewhere')
  })
})

describe('Claude terminal session lifecycle', () => {
  it('changes the open terminal font without replacing its renderer or spawning again', async () => {
    const input = params()
    const view = renderHook(() => useXtermSession(input))
    await waitFor(() => expect(input.setBootPhase).toHaveBeenCalledWith('ready'))
    const renderer = input.terminalRef.current
    act(() =>
      useProjectsStore.setState((state) => ({
        preferences: { ...state.preferences, terminalFontFamily: '"Consolas", monospace' },
      })),
    )
    // Preferences announce a font change the way they announce a zoom change.
    act(() => {
      window.dispatchEvent(new CustomEvent('alethe:terminal-font-changed'))
    })
    expect(input.terminalRef.current).toBe(renderer)
    expect(renderer?.options.fontFamily).toContain('Consolas')
    expect(tauri.spawnPty).toHaveBeenCalledTimes(1)
    view.unmount()
  })
  it('passes the saved shell only to a new plain-shell terminal', async () => {
    useProjectsStore.setState((state) => ({
      preferences: { ...state.preferences, shellPath: '/bin/bash' },
    }))
    const input = params()
    input.command = null
    input.sessionId = undefined
    const view = renderHook(() => useXtermSession(input))
    await waitFor(() => expect(tauri.spawnPty).toHaveBeenCalled())
    expect(tauri.spawnPty).toHaveBeenLastCalledWith(
      expect.objectContaining({ command: undefined, launcherOverride: '/bin/bash' }),
    )
    view.unmount()
  })
  describe('a plain shell tab saved with its own shell', () => {
    beforeEach(() => {
      useUiStore.setState({ toasts: [], notifications: [] })
      useProjectsStore.setState((state) => ({
        preferences: { ...state.preferences, shellPath: '/bin/bash' },
        projects: [
          {
            terminals: [
              { tabs: [{ id: 'tab-0', ptyId: 'pty-0', type: 'shell', shell: '/bin/zsh' }] },
            ],
          },
        ] as never,
      }))
    })
    const spawnShell = () => {
      const input = params()
      input.command = null
      input.sessionId = undefined
      return { input, view: renderHook(() => useXtermSession(input)) }
    }

    it('spawns on that shell again, the default as its fallback', async () => {
      const { input, view } = spawnShell()
      await waitFor(() => expect(input.setBootPhase).toHaveBeenCalledWith('ready'))
      expect(tauri.spawnPty).toHaveBeenLastCalledWith(
        expect.objectContaining({
          command: undefined,
          launcherOverride: '/bin/zsh',
          fallbackLauncher: '/bin/bash',
        }),
      )
      expect(useUiStore.getState().notifications).toEqual([])
      view.unmount()
    })

    it('says so when the backend fell back because that shell is gone', async () => {
      vi.mocked(tauri.spawnPty).mockResolvedValueOnce({ id: 'pty-0', shellFallback: true })
      const { input, view } = spawnShell()
      await waitFor(() => expect(input.setBootPhase).toHaveBeenCalledWith('ready'))
      expect(useUiStore.getState().notifications).toHaveLength(1)
      expect(useUiStore.getState().notifications[0]).toMatchObject({
        title: 'Saved shell is unavailable. The default shell is used instead.',
        body: '/bin/zsh',
      })
      view.unmount()
    })
  })
  it.each(['frontend', 'backend'])(
    'tracks /new after attaching a live PTY found in the %s',
    async (source) => {
      if (source === 'frontend') useTerminalsStore.getState().registerPty('pty-0')
      else vi.mocked(tauri.ptyExists).mockResolvedValueOnce(true)
      const input = params()
      const view = renderHook(() => useXtermSession(input))
      await waitFor(() => expect(input.setBootPhase).toHaveBeenCalledWith('ready'))
      act(() => emit('new-chat'))
      expect(peekSession('tab-0')?.claudeSessionId).toBe('new-chat')
      expect(input.onSessionIdRef.current).toHaveBeenLastCalledWith('new-chat')
      expect(tauri.spawnPty).not.toHaveBeenCalled()
      view.unmount()
      expect(hooks.size).toBe(0)
    },
  )

  it('does not overwrite a SessionStart received before spawn finishes', async () => {
    vi.mocked(tauri.spawnPty).mockImplementationOnce(async () => {
      emit('new-chat')
      return { id: 'pty-0' }
    })
    const input = params()
    renderHook(() => useXtermSession(input))
    await waitFor(() => expect(input.setBootPhase).toHaveBeenCalledWith('ready'))
    expect(input.onLaunchErrorRef.current).not.toHaveBeenCalled()
    expect(peekSession('tab-0')?.claudeSessionId).toBe('new-chat')
    expect(input.onSessionIdRef.current).toHaveBeenLastCalledWith('new-chat')
  })

  it('resumes the synchronous saved conversation when projects.json still has the old ID', async () => {
    saveSession('tab-0', {
      sessionId: 'pty-0',
      claudeSessionId: 'new-chat',
      agent: 'claude',
      cwd: 'D:/repo',
      timestamp: 1,
    })
    const input = params()
    renderHook(() => useXtermSession(input))
    await waitFor(() => expect(input.setBootPhase).toHaveBeenCalledWith('ready'))
    expect(tauri.spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({
        extraArgs: expect.arrayContaining(['--resume', 'new-chat']),
      }),
    )
    expect(peekSession('tab-0')?.claudeSessionId).toBe('new-chat')
  })

  it('keeps the session callback tied to its tab and ignores other panes', async () => {
    useTerminalsStore.getState().registerPty('pty-0')
    const input = params()
    const original = input.onSessionIdRef.current
    renderHook(() => useXtermSession(input))
    await waitFor(() => expect(input.setBootPhase).toHaveBeenCalledWith('ready'))
    input.onSessionIdRef.current = vi.fn()
    act(() => {
      emit('neighbour', 'pty-1')
      emit('new-chat')
    })
    expect(original).toHaveBeenLastCalledWith('new-chat')
    expect(input.onSessionIdRef.current).not.toHaveBeenCalled()
    expect(peekSession('tab-0')?.claudeSessionId).toBe('new-chat')
  })

  // A link lookup still pending when the terminal scrolls must not open the menu where it was.
  it('drops a pending link menu when the terminal scrolls', async () => {
    scrolls.length = 0
    const input = params()
    renderHook(() => useXtermSession(input))
    await waitFor(() => expect(scrolls).toHaveLength(1))
    act(() => scrolls[0]())
    expect(input.hideLinkActions).toHaveBeenCalled()
  })

  it('frees a pane when a fullscreen session exits without undoing its modes', async () => {
    const input = params()
    renderHook(() => useXtermSession(input))
    await waitFor(() => expect(exits.has('pty-0')).toBe(true))

    // What Claude Code in fullscreen rendering leaves on the pane when it is killed.
    const terminal = paneTerminal(input)
    terminal.modes.mouseTrackingMode = 'vt200'
    // Past the early-exit window, so this is a real exit and not the start-up retry.
    input.spawnedAtRef.current = Date.now() - 30_000

    act(() => exits.get('pty-0')?.({ code: 0 }))

    await waitFor(() => expect(terminal.writes.join('')).toContain('\x1b[?1049l\x1b[?1000l'))
  })

  it('frees a pane whose fullscreen modes were still queued when the session exited', async () => {
    const data = new Map<string, (chunk: string) => void>()
    vi.mocked(tauri.listenPtyData).mockImplementation(async (id, handler) => {
      data.set(id, handler as (chunk: string) => void)
      return () => {}
    })
    const input = params()
    renderHook(() => useXtermSession(input))
    await waitFor(() => expect(exits.has('pty-0') && data.has('pty-0')).toBe(true))
    const terminal = paneTerminal(input) as MockTerminal & {
      write: (chunk: string, callback?: () => void) => void
    }
    // The mock parses only what this needs: entering the alternate screen with the mouse on.
    const write = terminal.write.bind(terminal)
    terminal.write = (chunk, callback) => {
      if (chunk.includes('\x1b[?1049h')) {
        terminal.buffer.active.type = 'alternate'
        terminal.modes.mouseTrackingMode = 'vt200'
      }
      write(chunk, callback)
    }
    input.spawnedAtRef.current = Date.now() - 30_000

    // The renderer's last output is still in the pane's write queue when the exit arrives.
    act(() => {
      data.get('pty-0')?.('\x1b[?1049h\x1b[?1000h')
      exits.get('pty-0')?.({ code: 0 })
    })

    await waitFor(() => expect(terminal.writes.join('')).toContain('\x1b[?1049l\x1b[?1000l'))
  })

  it('frees a dead pane again when a resync replays the fullscreen it died in', async () => {
    const input = params()
    const view = renderHook(() => useXtermSession(input))
    await waitFor(() => expect(exits.has('pty-0')).toBe(true))
    const terminal = paneTerminal(input) as MockTerminal & {
      write: (chunk: string, callback?: () => void) => void
    }
    const write = terminal.write.bind(terminal)
    terminal.write = (chunk, callback) => {
      if (chunk.includes('\x1b[?1049h')) {
        terminal.buffer.active.type = 'alternate'
        terminal.modes.mouseTrackingMode = 'vt200'
      }
      write(chunk, callback)
    }
    input.spawnedAtRef.current = Date.now() - 30_000

    // Killed in fullscreen while the pane was hidden: its output never reached the screen.
    act(() => {
      useTerminalsStore.getState().recordIo('pty-0')
      exits.get('pty-0')?.({ code: 0 })
    })
    vi.mocked(tauri.attachPty).mockResolvedValue('\x1b[?1049h\x1b[?1000hthe fullscreen UI')
    terminal.writes.length = 0

    // Shown again, the pane rebuilds itself from the scrollback, fullscreen bytes included.
    panel.visible = true
    view.rerender()

    await waitFor(() => expect(terminal.writes.join('')).toContain('the fullscreen UI'))
    await waitFor(() => expect(terminal.writes.join('')).toContain('\x1b[?1049l\x1b[?1000l'))
  })

  it('gives a dead pane its scrollback back on the wheel', async () => {
    const input = params()
    renderHook(() => useXtermSession(input))
    await waitFor(() => expect(exits.has('pty-0')).toBe(true))
    input.spawnedAtRef.current = Date.now() - 30_000
    act(() => exits.get('pty-0')?.({ code: 0 }))

    const terminal = paneTerminal(input)
    terminal.buffer.active.type = 'alternate'
    terminal.modes.mouseTrackingMode = 'vt200'
    terminal.writes.length = 0

    act(() => {
      input.containerRef.current.dispatchEvent(
        new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true }),
      )
    })

    // The pane is stuck on a screen nobody owns: the modes come off, then the scroll happens.
    expect(terminal.writes.join('')).toContain('\x1b[?1049l')
    await waitFor(() => expect(terminal.scrollLines).toHaveBeenCalled())
  })

  it('leaves the wheel to a live fullscreen session', async () => {
    const input = params()
    renderHook(() => useXtermSession(input))
    await waitFor(() => expect(input.setBootPhase).toHaveBeenCalledWith('ready'))

    const terminal = paneTerminal(input)
    terminal.buffer.active.type = 'alternate'
    terminal.modes.mouseTrackingMode = 'vt200'
    terminal.writes.length = 0

    act(() => {
      input.containerRef.current.dispatchEvent(
        new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true }),
      )
    })

    expect(terminal.scrollLines).not.toHaveBeenCalled()
    expect(terminal.writes.join('')).not.toContain('\x1b[?1049l')
  })
})

describe('Enter shortcuts', () => {
  const written = () => vi.mocked(tauri.writePty).mock.calls.map(([, data]) => data)
  /** Presses a key in the pane; returns whether xterm should still handle it. */
  async function press(
    over: Partial<Parameters<typeof params>[0]>,
    init: KeyboardEventInit,
  ): Promise<boolean> {
    vi.useRealTimers() // waitFor needs real ones; a second press follows a faked first
    const input = { ...params(), ...over }
    renderHook(() => useXtermSession(input))
    await waitFor(() => expect(input.setBootPhase).toHaveBeenCalledWith('ready'))
    vi.mocked(tauri.writePty).mockClear()
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    let handled = true
    act(() => {
      handled = paneTerminal(input).keyHandler(
        new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, ...init }),
      )
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    return handled
  }
  afterEach(() => vi.useRealTimers())

  it('adds a line on Shift+Enter instead of submitting', async () => {
    expect(await press({}, { shiftKey: true })).toBe(false)
    expect(written()).toEqual(['\x1b\r'])
  })

  it('adds a line on Shift+Enter in a Codex pane too', async () => {
    await press({ command: 'codex' }, { shiftKey: true })
    expect(written()).toEqual(['\x1b\r'])
  })

  it('sends now on Ctrl+Enter in a Claude pane: ctrl+x, then ctrl+s', async () => {
    expect(await press({}, { ctrlKey: true })).toBe(false)
    expect(written()).toEqual(['\x18', '\x13'])
  })

  it('sends now on Cmd+Enter in a Claude pane', async () => {
    await press({}, { metaKey: true })
    expect(written()).toEqual(['\x18', '\x13'])
  })

  it('leaves Ctrl+Enter alone outside Claude Code panes', async () => {
    expect(await press({ command: 'codex' }, { ctrlKey: true })).toBe(true)
    expect(await press({ command: 'powershell' }, { ctrlKey: true })).toBe(true)
    expect(written()).toEqual([])
  })

  it('tracks Ctrl+Enter as the Enter it stands for, like onData does', async () => {
    const recordPromptInput = vi.fn(() => false)
    await press({ recordPromptInput }, { ctrlKey: true })
    expect(recordPromptInput).toHaveBeenCalledWith('\r')
    expect(written()).toEqual(['\x18', '\x13'])
  })

  it('clears the screen and scrollback when /new is sent with Ctrl+Enter', async () => {
    await press({ recordPromptInput: () => true }, { ctrlKey: true })
    expect(tauri.clearPtyScrollback).toHaveBeenCalledWith('pty-0')
  })

  it('does not count Shift+Enter as a submission', async () => {
    const recordPromptInput = vi.fn(() => false)
    await press({ recordPromptInput }, { shiftKey: true })
    expect(recordPromptInput).not.toHaveBeenCalled()
  })

  it.each([
    ['isComposing', { isComposing: true }],
    ['keyCode 229', { keyCode: 229 }],
  ])('leaves an IME Enter (%s) to xterm', async (_name, ime) => {
    expect(await press({}, { shiftKey: true, ...ime })).toBe(true)
    expect(await press({}, { ctrlKey: true, ...ime })).toBe(true)
    expect(written()).toEqual([])
  })

  it('leaves plain Enter to xterm', async () => {
    expect(await press({}, {})).toBe(true)
    expect(written()).toEqual([])
  })

  it('writes nothing in a read-only pane', async () => {
    await press({ readOnly: true }, { shiftKey: true })
    await press({ readOnly: true }, { ctrlKey: true })
    expect(written()).toEqual([])
  })
})

const enters = () => vi.mocked(tauri.writePty).mock.calls.filter(([, data]) => data === '\r').length
/** The argv the last spawn was asked for. */
const spawnArgs = () => vi.mocked(tauri.spawnPty).mock.lastCall?.[0].extraArgs ?? []

describe('initial input', () => {
  const status = (value: 'working' | 'waiting') =>
    act(() => useTerminalsStore.getState().setStatus('pty-0', value))

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('submits with Enter, then its retries, in an idle fresh session', async () => {
    useTerminalsStore.getState().registerPty('pty-0')
    const sent = submitInitialInput('pty-0')
    await vi.advanceTimersByTimeAsync(150)
    await sent
    expect(enters()).toBe(1)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(enters()).toBe(4)
  })

  // Arming the agent at the first Enter marks it working itself: that is not the agent taking the
  // prompt, so the retries go on as before.
  it('keeps its retries when the first Enter arms the agent', async () => {
    useTerminalsStore.getState().registerPty('pty-0')
    const armed = vi.fn(() => useTerminalsStore.getState().setStatus('pty-0', 'working'))
    const sent = submitInitialInput('pty-0', armed)
    await vi.advanceTimersByTimeAsync(150)
    await sent
    expect(enters()).toBe(1)
    expect(armed).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(6_000)
    expect(enters()).toBe(4)
    expect(armed).toHaveBeenCalledTimes(1)
  })

  it('still stops the retries when the agent starts working after it was armed and done', async () => {
    useTerminalsStore.getState().registerPty('pty-0')
    const sent = submitInitialInput('pty-0', () =>
      useTerminalsStore.getState().setStatus('pty-0', 'working'),
    )
    await vi.advanceTimersByTimeAsync(1_400)
    await sent
    expect(enters()).toBe(2)
    status('waiting')
    status('working')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(enters()).toBe(2)
  })

  it('sends no Enter while the agent is working', async () => {
    useTerminalsStore.getState().registerPty('pty-0')
    status('working')
    const sent = submitInitialInput('pty-0')
    await vi.advanceTimersByTimeAsync(10_000)
    await sent
    expect(enters()).toBe(0)
  })

  it('stops the retries once the agent is working, even when it is done again by the next one', async () => {
    useTerminalsStore.getState().registerPty('pty-0')
    const sent = submitInitialInput('pty-0')
    await vi.advanceTimersByTimeAsync(1_400)
    await sent
    expect(enters()).toBe(2)
    status('working')
    await vi.advanceTimersByTimeAsync(500)
    status('waiting')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(enters()).toBe(2)
  })

  it('goes through that guard when a fresh session is given its initial input', async () => {
    // Typed: on Windows a batch-file launcher cannot take the prompt in its argv.
    vi.mocked(isWindows).mockReturnValue(true)
    vi.mocked(tauri.findCliLauncher).mockResolvedValue('C:\\npm\\claude.cmd')
    try {
      const input = { ...params(), sessionId: undefined, initialInput: 'Retome a campanha X.' }
      renderHook(() => useXtermSession(input))
      await vi.advanceTimersByTimeAsync(1_000)
      // The agent starts a turn of its own before the prompt is submitted.
      status('working')
      await vi.advanceTimersByTimeAsync(15_000)
      expect(tauri.writePty).toHaveBeenCalledWith('pty-0', 'Retome a campanha X.')
      expect(enters()).toBe(0)
      expect(spawnArgs()).not.toContain('Retome a campanha X.')
    } finally {
      vi.mocked(isWindows).mockReturnValue(false)
      vi.mocked(tauri.findCliLauncher).mockResolvedValue('claude')
    }
  })
})

// Claude Code and Codex take their first prompt at launch, so a pane remounted right after the
// spawn (an orchestration board grouped with it) can neither drop nor repeat it (#74).
describe('initial prompt at launch', () => {
  const prompt = 'Retome a campanha X pela tarefa X-01, pelo registro C:\\repo\\campanhas.json.'
  const typed = () =>
    vi.mocked(tauri.writePty).mock.calls.filter(([, data]) => data.includes('Retome'))

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('gives a fresh Claude Code session the prompt as its last argument, and clears it once spawned', async () => {
    const input = { ...params(), sessionId: undefined, initialInput: prompt }
    renderHook(() => useXtermSession(input))
    await vi.advanceTimersByTimeAsync(1_000)

    expect(tauri.spawnPty).toHaveBeenCalledTimes(1)
    expect(spawnArgs().slice(0, 1)).toEqual(['--session-id'])
    expect(spawnArgs().slice(-2)).toEqual(['--', prompt])
    expect(input.onInitialInputSentRef.current).toHaveBeenCalledTimes(1)
    // Alethe submitted it, so the pty counts as working until the agent goes quiet.
    expect(armAgentPrompt).toHaveBeenCalledWith('pty-0', prompt)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(typed()).toEqual([])
    expect(enters()).toBe(0)
  })

  it('puts it after a resumed Claude conversation and its flags, keeping it until the resume holds', async () => {
    const input = {
      ...params(),
      extraArgs: ['--permission-mode', 'auto'],
      initialInput: prompt,
    }
    renderHook(() => useXtermSession(input))
    await vi.advanceTimersByTimeAsync(1_000)

    expect(spawnArgs().slice(0, 2)).toEqual(['--resume', 'bananas'])
    expect(spawnArgs().slice(-4)).toEqual(['--permission-mode', 'auto', '--', prompt])
    // A conversation that is gone exits at once and is reopened fresh: that launch needs it too.
    expect(input.onInitialInputSentRef.current).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(input.onInitialInputSentRef.current).toHaveBeenCalledTimes(1)
    expect(typed()).toEqual([])
  })

  it('gives Codex the prompt after its resume subcommand and flags', async () => {
    const input = {
      ...params(),
      command: 'codex' as const,
      sessionId: 'thread-1',
      trustSessionId: true,
      initialInput: prompt,
    }
    renderHook(() => useXtermSession(input))
    await vi.advanceTimersByTimeAsync(5_000)

    expect(spawnArgs()).toEqual(['resume', 'thread-1', '--no-alt-screen', '--', prompt])
    expect(input.onInitialInputSentRef.current).toHaveBeenCalledTimes(1)
    expect(armAgentPrompt).toHaveBeenCalledWith('pty-0', prompt)
    expect(typed()).toEqual([])
  })

  it('keeps typing it for OpenCode', async () => {
    const input = { ...params(), command: 'opencode' as const, sessionId: undefined }
    renderHook(() => useXtermSession({ ...input, initialInput: prompt }))
    await vi.advanceTimersByTimeAsync(6_000)

    expect(spawnArgs()).not.toContain(prompt)
    expect(deliverOpenCodePrompt).toHaveBeenCalledWith(
      prompt,
      expect.any(Number),
      expect.anything(),
    )
    expect(input.onInitialInputSentRef.current).toHaveBeenCalledTimes(1)
  })

  it('counts the prompt typed into OpenCode as its turn from the first Enter', async () => {
    vi.mocked(deliverOpenCodePrompt).mockImplementationOnce(async (text, _deadline, io) => {
      await io.write(text)
      expect(armAgentPrompt).not.toHaveBeenCalled()
      await io.write('\r')
      await io.write('\r')
      return true
    })
    const input = { ...params(), command: 'opencode' as const, sessionId: undefined }
    renderHook(() => useXtermSession({ ...input, initialInput: prompt }))
    await vi.advanceTimersByTimeAsync(6_000)
    expect(armAgentPrompt).toHaveBeenCalledTimes(1)
    expect(armAgentPrompt).toHaveBeenCalledWith('pty-0', prompt)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(input.onAgentCompleteRef.current).toHaveBeenCalledTimes(1)
    expect(notifyAgentDone).toHaveBeenCalledTimes(1)
  })

  it('neither loses nor repeats it when the pane remounts right after the spawn', async () => {
    let finishSpawn: (value: { id: string }) => void = () => {}
    vi.mocked(tauri.spawnPty).mockImplementationOnce(
      () => new Promise((resolve) => (finishSpawn = resolve)),
    )
    const input = { ...params(), sessionId: undefined, initialInput: prompt }
    const first = renderHook(() => useXtermSession(input))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(tauri.spawnPty).toHaveBeenCalledTimes(1)

    // Grouping the terminal with its board re-parents the pane while its pty is being spawned.
    first.unmount()
    finishSpawn({ id: 'pty-0' })
    await vi.advanceTimersByTimeAsync(0)
    vi.mocked(tauri.ptyExists).mockResolvedValue(true)
    try {
      renderHook(() => useXtermSession(input))
      await vi.advanceTimersByTimeAsync(15_000)
    } finally {
      vi.mocked(tauri.ptyExists).mockResolvedValue(false)
    }

    expect(tauri.spawnPty).toHaveBeenCalledTimes(1)
    expect(spawnArgs().filter((arg) => arg === prompt)).toHaveLength(1)
    expect(input.onInitialInputSentRef.current).toHaveBeenCalledTimes(1)
    expect(armAgentPrompt).toHaveBeenCalledTimes(1)
    expect(typed()).toEqual([])
  })

  // The typed path never armed the pane's monitor either: Alethe's own writes skip the keyboard.
  it('waits on the reply in its own pane: the tab is told when it settles, with a notification', async () => {
    const input = { ...params(), sessionId: undefined, initialInput: prompt }
    renderHook(() => useXtermSession(input))
    await vi.advanceTimersByTimeAsync(1_000)
    act(() => activity.get('pty-0')?.('Reading the registry and the handoff…'))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(input.onAgentCompleteRef.current).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5_000)
    expect(input.onAgentCompleteRef.current).toHaveBeenCalledTimes(1)
    expect(notifyAgentDone).toHaveBeenCalledTimes(1)
    expect(useTerminalsStore.getState().byPtyId['pty-0']?.status).toBe('waiting')
  })

  it('lets the pane remounted after the spawn wait on that reply instead', async () => {
    let finishSpawn: (value: { id: string }) => void = () => {}
    vi.mocked(tauri.spawnPty).mockImplementationOnce(
      () => new Promise((resolve) => (finishSpawn = resolve)),
    )
    const first = { ...params(), sessionId: undefined, initialInput: prompt }
    const view = renderHook(() => useXtermSession(first))
    await vi.advanceTimersByTimeAsync(1_000)
    view.unmount()
    finishSpawn({ id: 'pty-0' })
    await vi.advanceTimersByTimeAsync(0)
    vi.mocked(tauri.ptyExists).mockResolvedValue(true)
    const second = { ...first, onAgentCompleteRef: ref(vi.fn()) }
    try {
      renderHook(() => useXtermSession(second))
      await vi.advanceTimersByTimeAsync(1_000)
      act(() => activity.get('pty-0')?.('Reading the registry and the handoff…'))
      await vi.advanceTimersByTimeAsync(6_000)
    } finally {
      vi.mocked(tauri.ptyExists).mockResolvedValue(false)
    }

    expect(second.onAgentCompleteRef.current).toHaveBeenCalledTimes(1)
    expect(first.onAgentCompleteRef.current).not.toHaveBeenCalled()
    expect(notifyAgentDone).toHaveBeenCalledTimes(1)
  })

  it('hands a reply still due to the pane that replaces the one waiting on it', async () => {
    const first = { ...params(), sessionId: undefined, initialInput: prompt }
    const view = renderHook(() => useXtermSession(first))
    await vi.advanceTimersByTimeAsync(1_000)
    act(() => activity.get('pty-0')?.('Reading the registry and the handoff…'))
    await vi.advanceTimersByTimeAsync(2_000)

    // Grouped with its board while the reply is still coming.
    view.unmount()
    const second = { ...first, onAgentCompleteRef: ref(vi.fn()) }
    renderHook(() => useXtermSession(second))
    await vi.advanceTimersByTimeAsync(1_000)
    act(() => activity.get('pty-0')?.('Updating the campaign registry…'))
    await vi.advanceTimersByTimeAsync(15_000)

    expect(second.onAgentCompleteRef.current).toHaveBeenCalledTimes(1)
    expect(first.onAgentCompleteRef.current).not.toHaveBeenCalled()
    expect(notifyAgentDone).toHaveBeenCalledTimes(1)
    expect(useTerminalsStore.getState().byPtyId['pty-0']?.status).toBe('waiting')
  })

  it('waits on a launch reply only once, whichever pane saw it settle', async () => {
    const first = { ...params(), sessionId: undefined, initialInput: prompt }
    const view = renderHook(() => useXtermSession(first))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(first.onAgentCompleteRef.current).toHaveBeenCalledTimes(1)

    view.unmount()
    const second = { ...first, onAgentCompleteRef: ref(vi.fn()) }
    renderHook(() => useXtermSession(second))
    await vi.advanceTimersByTimeAsync(15_000)
    expect(second.onAgentCompleteRef.current).not.toHaveBeenCalled()
    expect(notifyAgentDone).toHaveBeenCalledTimes(1)
  })

  // A batch-file launcher (or a prompt PowerShell would mangle) gets it typed: grouping the new
  // terminal with its board remounts the pane while that is still to happen.
  describe('typed instead', () => {
    beforeEach(() => {
      vi.mocked(isWindows).mockReturnValue(true)
      vi.mocked(tauri.findCliLauncher).mockResolvedValue('C:\\npm\\claude.cmd')
    })
    afterEach(() => {
      vi.mocked(isWindows).mockReturnValue(false)
      vi.mocked(tauri.findCliLauncher).mockResolvedValue('claude')
      vi.mocked(tauri.ptyExists).mockResolvedValue(false)
    })
    const sent = (...inputs: ReturnType<typeof params>[]) =>
      inputs.reduce(
        (count, input) => count + vi.mocked(input.onInitialInputSentRef.current!).mock.calls.length,
        0,
      )

    it('counts it as the agent turn once submitted: working, then waiting, told once', async () => {
      const input = { ...params(), sessionId: undefined, initialInput: prompt }
      renderHook(() => useXtermSession(input))
      await vi.advanceTimersByTimeAsync(2_000)
      expect(typed()).toEqual([['pty-0', prompt]])
      expect(enters()).toBe(1)
      expect(useTerminalsStore.getState().byPtyId['pty-0']?.status).toBe('working')
      expect(armAgentPrompt).toHaveBeenCalledWith('pty-0', prompt)

      act(() => activity.get('pty-0')?.('Reading the registry and the handoff…'))
      await vi.advanceTimersByTimeAsync(13_000)
      // Arming changed nothing in the retries.
      expect(enters()).toBe(4)
      expect(armAgentPrompt).toHaveBeenCalledTimes(1)
      expect(input.onAgentCompleteRef.current).toHaveBeenCalledTimes(1)
      expect(notifyAgentDone).toHaveBeenCalledTimes(1)
      expect(useTerminalsStore.getState().byPtyId['pty-0']?.status).toBe('waiting')
    })

    it('keeps typing it through the pane that replaces the one that started', async () => {
      const first = { ...params(), sessionId: undefined, initialInput: prompt }
      const view = renderHook(() => useXtermSession(first))
      await vi.advanceTimersByTimeAsync(500)
      expect(spawnArgs()).not.toContain(prompt)
      view.unmount()
      const second = { ...first, onInitialInputSentRef: ref(vi.fn()) }
      renderHook(() => useXtermSession(second))
      await vi.advanceTimersByTimeAsync(15_000)

      expect(tauri.spawnPty).toHaveBeenCalledTimes(1)
      expect(typed()).toEqual([['pty-0', prompt]])
      expect(enters()).toBeGreaterThan(0)
      expect(sent(first, second)).toBe(1)
    })

    it('starts typing it from the remounted pane when the first one went before it could', async () => {
      let finishSpawn: (value: { id: string }) => void = () => {}
      vi.mocked(tauri.spawnPty).mockImplementationOnce(
        () => new Promise((resolve) => (finishSpawn = resolve)),
      )
      const first = { ...params(), sessionId: undefined, initialInput: prompt }
      const view = renderHook(() => useXtermSession(first))
      await vi.advanceTimersByTimeAsync(1_000)
      view.unmount()
      finishSpawn({ id: 'pty-0' })
      await vi.advanceTimersByTimeAsync(0)
      vi.mocked(tauri.ptyExists).mockResolvedValue(true)
      const second = { ...first, onInitialInputSentRef: ref(vi.fn()) }
      renderHook(() => useXtermSession(second))
      await vi.advanceTimersByTimeAsync(15_000)

      expect(tauri.spawnPty).toHaveBeenCalledTimes(1)
      expect(typed()).toEqual([['pty-0', prompt]])
      expect(sent(first, second)).toBe(1)
    })

    it('never types it again into a pty that already got it', async () => {
      const input = { ...params(), sessionId: undefined, initialInput: prompt }
      const view = renderHook(() => useXtermSession(input))
      await vi.advanceTimersByTimeAsync(15_000)
      expect(typed()).toHaveLength(1)

      // A pane mounted with the tab's input from before it was cleared.
      view.unmount()
      renderHook(() => useXtermSession(input))
      await vi.advanceTimersByTimeAsync(15_000)
      expect(typed()).toHaveLength(1)
    })

    it('stops once the pty is gone', async () => {
      const input = { ...params(), sessionId: undefined, initialInput: prompt }
      const view = renderHook(() => useXtermSession(input))
      await vi.advanceTimersByTimeAsync(500)
      view.unmount()
      act(() => useTerminalsStore.getState().markExited('pty-0'))
      await vi.advanceTimersByTimeAsync(15_000)
      expect(typed()).toEqual([])
    })
  })
})
