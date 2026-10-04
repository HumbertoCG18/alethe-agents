import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { USAGE_FALLBACK_THRESHOLD } from '../../lib/agentCanvasConfig'
import { DEFAULT_NIGHT_SETTINGS, type NightSettings } from '../../lib/nightScheduler'
import type { PluginStorage } from '../../lib/plugins'
import { EMPTY_PROJECTS_FILE } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'

const fs = vi.hoisted(() => ({
  files: new Map<string, string>(),
  onChange: null as ((path: string) => void) | null,
  usage: 10,
  /** A usage read waits on this while it is set. */
  usageGate: null as Promise<void> | null,
  usageFails: false,
}))

vi.mock('../../lib/terminalLifecycle', () => ({ cleanupPtys: vi.fn() }))
vi.mock('../../lib/claudeUsageCache', () => ({
  getCachedClaudeUsage: vi.fn(async () => {
    await fs.usageGate
    if (fs.usageFails) throw 'API returned 429 Too Many Requests'
    return {
      five_hour: { utilization: fs.usage, resets_at: '' },
      seven_day: { utilization: 0, resets_at: '' },
      seven_day_opus: { utilization: 0, resets_at: '' },
    }
  }),
}))
vi.mock('../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/tauri')>()),
  worktreeCheckouts: vi.fn(async (path: string) => ({
    main: path,
    worktrees: [{ path, branch: 'dev', lastCommitMs: null }],
  })),
  readTextFile: vi.fn(async (path: string) => {
    const text = fs.files.get(path)
    if (text === undefined) throw new Error('file not found')
    return text
  }),
  watchFile: vi.fn(async () => {}),
  unwatchFile: vi.fn(async () => {}),
  listenFileChanged: vi.fn(async (handler: (path: string) => void) => {
    fs.onChange = handler
    return () => {
      fs.onChange = null
    }
  }),
  findRelativePath: vi.fn(async () => null),
  // The write command's contract: replace the file only while it is still the text read.
  campaignRegistryWrite: vi.fn(async (path: string, expected: string, content: string) => {
    if ((fs.files.get(path) ?? '') !== expected) throw 'conflict'
    fs.files.set(path, content)
    return content
  }),
}))

import { getCachedClaudeUsage } from '../../lib/claudeUsageCache'
import { campaignRegistryWrite, watchFile } from '../../lib/tauri'
import { cleanupPtys } from '../../lib/terminalLifecycle'
import { startNightRunner } from './nightRunner'
import { hydrateTodos, resetTodosStoreForTests, useTodosStore } from './store'

const REPO = 'C:\\repo'
const OTHER = 'C:\\other'
const registryOf = (main: string) => `${main}\\.workflow\\campanhas.json`
const diaryOf = (main: string, night = '2026-10-03') =>
  `${main}\\.workflow\\local\\noites\\${night}.json`

/** A local time on 2026-10-03 (or the given day). */
const at = (clock: string, day = 3) => {
  const [hours, minutes] = clock.split(':').map(Number)
  return new Date(2026, 9, day, hours, minutes)
}

function writeRegistry(main: string, ids: string[]) {
  fs.files.set(
    registryOf(main),
    JSON.stringify({
      campanhas: [
        {
          id: 'N',
          titulo: 'Night',
          prioridade: 1,
          janela: 'noite',
          tarefas: ids.map((id) => ({ id, titulo: `Task ${id}`, estado: 'pronta' })),
        },
      ],
    }),
  )
}

/** Appends an entry to a diary, as `campanhas.py noite` does, and reports the change. */
function record(main: string, task: string, result: string, hora: string, notify = true) {
  const path = diaryOf(main)
  const diary = JSON.parse(fs.files.get(path) ?? '{"data":"2026-10-03","entradas":[]}')
  diary.entradas.push({ tarefa: task, resultado: result, resumo: 'r', evidencia: '', hora })
  fs.files.set(path, JSON.stringify(diary))
  if (notify) fs.onChange?.(path)
}

const entries = (main = REPO) =>
  (JSON.parse(fs.files.get(diaryOf(main)) ?? '{"entradas":[]}') as { entradas: unknown[] }).entradas

function addProject(name: string, defaultCwd: string, settings: Partial<NightSettings> = {}) {
  const project = useProjectsStore.getState().createProject({ name, defaultCwd })
  useTodosStore.getState().setNightSettings(project.id, nightOn(settings))
  return project.id
}

const nightOn = (settings: Partial<NightSettings> = {}): NightSettings => ({
  ...DEFAULT_NIGHT_SETTINGS,
  enabled: true,
  ...settings,
})

/** The night agents' terminals: every Claude tab opened for a campaign. */
const agents = () =>
  useProjectsStore
    .getState()
    .projects.flatMap((project) =>
      project.terminals.flatMap((terminal) =>
        terminal.tabs
          .filter((tab) => tab.type === 'claude' && tab.campaignId)
          .map((tab) => ({ projectId: project.id, terminal, tab })),
      ),
    )

const current = () => useTodosStore.getState().nightRun.current
const nightOf = (projectId: string) => useTodosStore.getState().nightRun.nights[projectId]

let runner: ReturnType<typeof startNightRunner> | null = null

/** Starts the runner and lets its first check end. */
async function start() {
  runner = startNightRunner()
  await runner.idle()
  return runner
}

/** Moves the clock; only the runner's own timers run checks, and each is let end. */
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms)
  await runner!.idle()
}

/** Lets microtasks run until `done` holds. */
async function until(done: () => boolean) {
  for (let turn = 0; turn < 200 && !done(); turn += 1) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(at('23:30'))
  fs.files.clear()
  fs.onChange = null
  fs.usage = 10
  fs.usageGate = null
  fs.usageFails = false
  resetTodosStoreForTests()
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
})

afterEach(() => {
  runner?.stop()
  runner = null
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('night runner', () => {
  it('starts the first free night task in a fresh Claude tab, in auto permission mode', async () => {
    const projectId = addProject('App', REPO)
    writeRegistry(REPO, ['N-01', 'N-02'])
    await start()

    const [agent] = agents()
    expect(agents()).toHaveLength(1)
    expect(agent.tab.cwd).toBe(REPO)
    expect(agent.tab.campaignId).toBe('N')
    expect(agent.tab.extraArgs).toEqual(['--permission-mode', 'auto'])
    expect(agent.tab.initialInput).toContain('para a tarefa N-01 da campanha N')
    expect(agent.tab.initialInput).toContain(`registro ${registryOf(REPO)}`)
    // A plain tab: unlike Open, no orchestration board is opened next to it.
    const [project] = useProjectsStore.getState().projects
    expect(project.terminals).toHaveLength(1)
    expect(project.paneGroups ?? []).toEqual([])
    expect(current()).toEqual({
      projectId,
      campaignId: 'N',
      taskId: 'N-01',
      terminalId: agent.terminal.id,
      tabId: agent.tab.id,
      startedAt: at('23:30').getTime(),
      deadline: at('01:00', 4).getTime(),
    })
    expect(nightOf(projectId)?.attempted).toEqual(['N-01'])
    expect(watchFile).toHaveBeenCalledWith(diaryOf(REPO))
  })

  it('runs nothing with Modo noite off, outside the window, or without a free night task', async () => {
    const projectId = addProject('App', REPO, { enabled: false })
    writeRegistry(REPO, ['N-01'])
    await start()
    expect(agents()).toHaveLength(0)

    vi.setSystemTime(at('20:00'))
    useTodosStore.getState().setNightSettings(projectId, nightOn())
    await runner!.idle()
    expect(agents()).toHaveLength(0)
    expect(nightOf(projectId)).toBeUndefined()

    vi.setSystemTime(at('23:30'))
    record(REPO, 'N-01', 'ok', '23:00')
    await advance(60_000)
    expect(agents()).toHaveLength(0)
    expect(nightOf(projectId)?.stopped).toBe('none')
  })

  it('sees the task done in the diary, closes its tab, rests 30 s and starts the next', async () => {
    addProject('App', REPO)
    writeRegistry(REPO, ['N-01', 'N-02'])
    await start()

    vi.setSystemTime(at('23:41'))
    record(REPO, 'N-01', 'aguarda-voce', '23:41')
    await runner!.idle()
    expect(agents()).toHaveLength(0)
    expect(current()).toBeNull()

    await advance(29_000)
    expect(agents()).toHaveLength(0)
    await advance(1_000)
    expect(agents().map((agent) => agent.tab.initialInput)).toEqual([
      expect.stringContaining('tarefa N-02'),
    ])
  })

  it('records a task that never wrote its line as parou at the time limit', async () => {
    addProject('App', REPO)
    writeRegistry(REPO, ['N-01', 'N-02'])
    await start()

    await advance(89 * 60_000)
    expect(agents()).toHaveLength(1)
    expect(campaignRegistryWrite).not.toHaveBeenCalled()

    await advance(60_000)
    expect(campaignRegistryWrite).toHaveBeenCalledWith(diaryOf(REPO), '', expect.any(String))
    expect(JSON.parse(fs.files.get(diaryOf(REPO))!)).toEqual({
      data: '2026-10-03',
      entradas: [
        {
          tarefa: 'N-01',
          resultado: 'parou',
          resumo: 'tempo esgotado no agendador (90 min)',
          evidencia: '',
          hora: '01:00',
        },
      ],
    })
    expect(agents()).toHaveLength(0)
    expect(current()).toBeNull()
    expect(Object.values(useTodosStore.getState().nightRun.nights)[0]).toMatchObject({
      started: 1,
      failures: 1,
    })
  })

  it('keeps the deadline set at the start: later settings neither extend nor cancel it', async () => {
    const projectId = addProject('App', REPO)
    writeRegistry(REPO, ['N-01'])
    await start()
    useTodosStore
      .getState()
      .setNightSettings(
        projectId,
        nightOn({ enabled: false, end: '00:00', maxMinutesPerTask: 600 }),
      )
    await runner!.idle()

    await advance(89 * 60_000)
    expect(agents()).toHaveLength(1)
    await advance(60_000)
    expect(agents()).toHaveLength(0)
    expect(entries()).toEqual([
      expect.objectContaining({
        resultado: 'parou',
        resumo: 'tempo esgotado no agendador (90 min)',
      }),
    ])
  })

  it('never starts a task once the settings or the clock changed during the usage read', async () => {
    const projectId = addProject('App', REPO)
    writeRegistry(REPO, ['N-01'])
    let release!: () => void
    fs.usageGate = new Promise((resolve) => (release = resolve))
    runner = startNightRunner()
    await until(() => vi.mocked(getCachedClaudeUsage).mock.calls.length > 0)
    vi.setSystemTime(at('07:00', 4))
    release()
    await runner.idle()
    expect(agents()).toHaveLength(0)
    expect(current()).toBeNull()

    // The same with Modo noite turned off meanwhile.
    vi.setSystemTime(at('23:30'))
    fs.usageGate = new Promise((resolve) => (release = resolve))
    vi.mocked(getCachedClaudeUsage).mockClear()
    void runner.tick()
    await until(() => vi.mocked(getCachedClaudeUsage).mock.calls.length > 0)
    useTodosStore.getState().setNightSettings(projectId, nightOn({ enabled: false }))
    release()
    await runner.idle()
    expect(agents()).toHaveLength(0)
  })

  it('stops at the task maximum', async () => {
    const projectId = addProject('App', REPO, { maxTasks: 1 })
    writeRegistry(REPO, ['N-01', 'N-02'])
    await start()
    record(REPO, 'N-01', 'ok', '23:30')
    await runner!.idle()
    await advance(30_000)
    expect(agents()).toHaveLength(0)
    expect(nightOf(projectId)?.stopped).toBe('max')
  })

  it('ends the night after two failed or stopped tasks in a row', async () => {
    const projectId = addProject('App', REPO)
    writeRegistry(REPO, ['N-01', 'N-02', 'N-03'])
    await start()
    record(REPO, 'N-01', 'falhou', '23:30')
    await runner!.idle()
    await advance(30_000)
    expect(agents()[0].tab.initialInput).toContain('tarefa N-02')

    vi.setSystemTime(at('23:45'))
    record(REPO, 'N-02', 'parou', '23:45')
    await runner!.idle()
    await advance(30_000)
    expect(agents()).toHaveLength(0)
    expect(nightOf(projectId)).toMatchObject({ started: 2, failures: 2, stopped: 'failures' })
  })

  it('stops when Claude’s usage reaches the fallback threshold, from the shared cache', async () => {
    const projectId = addProject('App', REPO)
    writeRegistry(REPO, ['N-01'])
    fs.usage = USAGE_FALLBACK_THRESHOLD
    await start()
    expect(getCachedClaudeUsage).toHaveBeenCalled()
    expect(agents()).toHaveLength(0)
    expect(nightOf(projectId)?.stopped).toBe('quota')
  })

  it('starts anyway when the usage cannot be read, and says so', async () => {
    addProject('App', REPO)
    writeRegistry(REPO, ['N-01'])
    fs.usageFails = true
    await start()
    expect(agents()).toHaveLength(1)
    expect(current()?.quotaUnread).toBe(true)
  })

  it('never takes a task again tonight after its diary line could not be written', async () => {
    const projectId = addProject('App', REPO)
    writeRegistry(REPO, ['N-01', 'N-02'])
    vi.mocked(campaignRegistryWrite)
      .mockRejectedValueOnce('registry in use')
      .mockRejectedValueOnce('registry in use')
    await start()

    await advance(90 * 60_000)
    // One more try at the next check, with the tab still open.
    expect(agents()).toHaveLength(1)
    expect(current()?.pendingStop).toBe('tempo esgotado no agendador (90 min)')
    await advance(60_000)
    expect(agents()).toHaveLength(0)
    expect(current()).toBeNull()
    expect(nightOf(projectId)?.stopped).toBe('diary')

    // Reconsidered after a settings change: N-01 has no diary line but was attempted.
    useTodosStore.getState().setNightSettings(projectId, nightOn({ maxTasks: 6 }))
    await advance(30_000)
    expect(agents().map((agent) => agent.tab.initialInput)).toEqual([
      expect.stringContaining('tarefa N-02'),
    ])
  })

  it('takes a line the agent wrote while the stop was being recorded, not parou', async () => {
    const projectId = addProject('App', REPO)
    writeRegistry(REPO, ['N-01'])
    vi.mocked(campaignRegistryWrite).mockImplementationOnce(async () => {
      // campanhas.py noite gets the lock first.
      record(REPO, 'N-01', 'ok', '01:00', false)
      throw 'conflict'
    })
    await start()
    await advance(90 * 60_000)
    expect(entries()).toEqual([expect.objectContaining({ tarefa: 'N-01', resultado: 'ok' })])
    expect(nightOf(projectId)?.failures).toBe(0)
    expect(agents()).toHaveLength(0)
  })

  it('closes only the night tab, never a tab the user added to its terminal', async () => {
    const projectId = addProject('App', REPO)
    writeRegistry(REPO, ['N-01'])
    await start()
    const store = useProjectsStore.getState()
    const { terminal, tab } = agents()[0]
    const mine = store.createSubTab(projectId, terminal.id, { type: 'shell', cwd: REPO })
    store.setSubTabPtyId(projectId, terminal.id, tab.id, 'pty-night')
    store.setSubTabPtyId(projectId, terminal.id, mine.id, 'pty-mine')

    record(REPO, 'N-01', 'ok', '23:30')
    await runner!.idle()
    const left = useProjectsStore
      .getState()
      .projects[0].terminals.find((item) => item.id === terminal.id)
    expect(left?.tabs.map((item) => item.id)).toEqual([mine.id])
    expect(vi.mocked(cleanupPtys).mock.calls).toEqual([[['pty-night']]])
  })

  it('persists the start before it opens the tab, and opens none when that fails', async () => {
    let release!: () => void
    let fail = false
    const saved: unknown[] = []
    const storage = {
      read: async () => ({}),
      set: vi.fn((key: string, value: unknown) => {
        if (key !== 'nightRun') return Promise.resolve()
        saved.push(value)
        if (fail) return Promise.reject(new Error('disk full'))
        return saved.length === 1
          ? new Promise<void>((resolve) => (release = resolve))
          : Promise.resolve()
      }),
    } as unknown as PluginStorage
    await hydrateTodos(storage, { todos: [], storagePath: '' })
    const projectId = addProject('App', REPO)
    writeRegistry(REPO, ['N-01', 'N-02'])
    runner = startNightRunner()

    await until(() => saved.length > 0)
    expect(saved[0]).toMatchObject({
      current: { taskId: 'N-01', terminalId: null, tabId: null },
      nights: { [projectId]: { attempted: ['N-01'], started: 1 } },
    })
    expect(agents()).toHaveLength(0)
    release()
    await runner.idle()
    expect(agents()).toHaveLength(1)

    fail = true
    record(REPO, 'N-01', 'ok', '23:30')
    await runner.idle()
    await advance(30_000)
    expect(agents()).toHaveLength(0)
    expect(current()).toBeNull()
  })

  it('after a restart, records the task it was running as parou and goes on', async () => {
    const projectId = addProject('App', REPO)
    writeRegistry(REPO, ['N-01', 'N-02'])
    const terminal = useProjectsStore.getState().createTerminal(projectId, {
      name: 'N-01',
      cwd: REPO,
      firstTab: { type: 'claude', cwd: REPO, campaignId: 'N' },
    })
    void useTodosStore.getState().setNightRun({
      current: {
        projectId,
        campaignId: 'N',
        taskId: 'N-01',
        terminalId: terminal.id,
        tabId: terminal.tabs[0].id,
        startedAt: at('23:10').getTime(),
        deadline: at('00:40', 4).getTime(),
      },
      nights: {
        [projectId]: {
          night: '2026-10-03',
          started: 1,
          failures: 0,
          stopped: null,
          attempted: ['N-01'],
        },
      },
    })
    await start()

    expect(entries()).toEqual([
      expect.objectContaining({ tarefa: 'N-01', resultado: 'parou', resumo: 'Alethe reiniciado' }),
    ])
    expect(agents()).toHaveLength(0)
    await advance(30_000)
    expect(agents()[0].tab.initialInput).toContain('tarefa N-02')
  })

  it('after a restart, takes the result the task already wrote', async () => {
    const projectId = addProject('App', REPO)
    writeRegistry(REPO, ['N-01'])
    record(REPO, 'N-01', 'ok', '23:20')
    void useTodosStore.getState().setNightRun({
      current: {
        projectId,
        campaignId: 'N',
        taskId: 'N-01',
        terminalId: null,
        tabId: null,
        startedAt: at('23:10').getTime(),
        deadline: at('00:40', 4).getTime(),
      },
      nights: {
        [projectId]: {
          night: '2026-10-03',
          started: 1,
          failures: 1,
          stopped: null,
          attempted: ['N-01'],
        },
      },
    })
    await start()
    expect(campaignRegistryWrite).not.toHaveBeenCalled()
    expect(nightOf(projectId)?.failures).toBe(0)
  })

  it('never runs two night agents at once, across projects and overlapping checks', async () => {
    addProject('App', REPO)
    addProject('Other', OTHER)
    writeRegistry(REPO, ['N-01'])
    writeRegistry(OTHER, ['N-01'])
    runner = startNightRunner()
    await Promise.all([runner.tick(), runner.tick(), runner.tick()])
    expect(agents()).toHaveLength(1)
    await advance(60_000)
    await advance(60_000)
    expect(agents()).toHaveLength(1)
  })
})
