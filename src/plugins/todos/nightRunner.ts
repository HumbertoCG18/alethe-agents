/**
 * The night scheduler (Modo noite). Inside a project's window it runs that project's free night
 * tasks one at a time, at most one across the app, each in a fresh Claude Code tab opened as Open
 * does, until a stop condition. It is started once when the Todo plugin activates, so it does not
 * depend on the Todo tab being open, and keeps its state in the plugin's storage so a restart
 * never starts a task twice.
 */
import { claudeFitness } from '../../lib/agentFitness'
import {
  type Campaign,
  type CampaignTask,
  type NightEntry,
  type NightResult,
  parseCampaigns,
  parseNightDiary,
  registryPath,
  workflowPath,
} from '../../lib/campaigns'
import { getCachedClaudeUsage } from '../../lib/claudeUsageCache'
import {
  appendNightEntry,
  inWindow,
  nextNightTask,
  nightDate,
  shouldStop,
  type StopInput,
  type StopReason,
  taskDone,
  windowEnd,
} from '../../lib/nightScheduler'
import {
  campaignRegistryWrite,
  listenFileChanged,
  readTextFile,
  worktreeCheckouts,
} from '../../lib/tauri'
import { getProjectDefaultCwd } from '../../lib/terminalFactory'
import { useProjectsStore } from '../../stores/projectsStore'
import { openCampaign, type Registry } from './campaignView'
import { type NightRun, useTodosStore } from './store'
import { createWatchSet } from './watchSet'

const TICK_MS = 60_000
/** Pause between the end of a task and the start of the next. */
const REST_MS = 30_000

type Running = NonNullable<NightRun['current']>
type Night = NightRun['nights'][string]

const todos = () => useTodosStore.getState()

/**
 * Saves the run state in the background. Only the start must be saved before going on; a later
 * save that fails leaves an older state, which a restart reads as the task still running.
 */
const save = (run: NightRun) =>
  todos()
    .setNightRun(run)
    .catch(() => {})

const noitesFolder = (main: string) => workflowPath(main, 'local', 'noites')
const diaryPath = (main: string, night: string) =>
  workflowPath(main, 'local', 'noites', `${night}.json`)

/** The diaries a task's line may land in: the night it started, and tonight (after noon). */
const diaryPaths = (main: string, startedAt: number) =>
  [...new Set([nightDate(new Date(startedAt)), nightDate(new Date())])].map((night) =>
    diaryPath(main, night),
  )

const clock = (date: Date) =>
  [date.getHours(), date.getMinutes()].map((part) => String(part).padStart(2, '0')).join(':')

async function checkoutsOf(projectId: string) {
  const { projects } = useProjectsStore.getState()
  const project = projects.find((item) => item.id === projectId)
  const path = project ? getProjectDefaultCwd(project, projects) : ''
  const checkouts = path ? await worktreeCheckouts(path).catch(() => null) : null
  return checkouts?.main ? { main: checkouts.main, checkouts } : null
}

/** The project's registry, read as the Todo tab reads it; null without a valid one. */
async function loadRegistry(projectId: string): Promise<Registry | null> {
  const found = await checkoutsOf(projectId)
  if (!found) return null
  const path = registryPath(found.main)
  const text = await readTextFile(path).catch(() => null)
  const parsed = text === null ? null : parseCampaigns(text)
  if (!parsed || text === null || parsed.errors.length > 0) return null
  return { ...parsed, projectId, path, main: found.main, checkouts: found.checkouts, text }
}

const readDiary = (path: string) => readTextFile(path).then(parseNightDiary, () => null)

type StopOutcome = { kind: 'written' } | { kind: 'done'; entry: NightEntry } | { kind: 'failed' }

/**
 * Appends `parou` for the task to the diary `campanhas.py noite` would write to now, under its
 * lock. A line the agent wrote meanwhile, seen when the write meets a conflict, wins instead.
 */
async function recordStopped(main: string, task: Running, summary: string): Promise<StopOutcome> {
  const now = new Date()
  const night = nightDate(now)
  const path = diaryPath(main, night)
  const entry = {
    task: task.taskId,
    result: 'parou' as const,
    summary,
    evidence: '',
    time: clock(now),
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const text = await readTextFile(path).catch(() => null)
    const done = taskDone(text === null ? null : parseNightDiary(text), task.taskId, task.startedAt)
    if (done) return { kind: 'done', entry: done }
    const content = appendNightEntry(text, night, entry)
    if (content === null) return { kind: 'failed' }
    try {
      await campaignRegistryWrite(path, text ?? '', content)
      return { kind: 'written' }
    } catch (error) {
      if (error !== 'conflict') return { kind: 'failed' }
    }
  }
  return { kind: 'failed' }
}

/** Claude's usage from the shared cache; null when it cannot be read. */
const claudeUsage = () => getCachedClaudeUsage().then(claudeFitness, () => null)

function saveNight(projectId: string, night: Night) {
  const { nightRun } = todos()
  void save({ ...nightRun, nights: { ...nightRun.nights, [projectId]: night } })
}

/**
 * Starts the scheduler: a check every minute, when a project's settings change and when tonight's
 * diary changes, plus one 30 s after each task ends. `tick` runs a check now and resolves when it
 * (and any check asked for meanwhile) is over; `idle` waits for the check in progress, if any.
 * Checks never overlap.
 */
export function startNightRunner(): {
  tick: () => Promise<void>
  idle: () => Promise<void>
  stop: () => void
} {
  let stopped = false
  let pending: Promise<void> | null = null
  let again = false
  let restUntil = 0
  let restTimer: ReturnType<typeof setTimeout> | undefined
  // A task already running at the first check was started before a restart.
  let firstCheck = true
  const watches = createWatchSet()

  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (pending) {
      again = true
      return pending
    }
    pending = (async () => {
      try {
        do {
          again = false
          await step()
        } while (again && !stopped)
      } catch (error) {
        console.warn('[night scheduler] check failed:', error)
      } finally {
        pending = null
      }
    })()
    return pending
  }

  const step = async () => {
    const afterRestart = firstCheck
    firstCheck = false
    const { current } = todos().nightRun
    if (current) await checkRunning(current, afterRestart)
    else if (Date.now() >= restUntil) await startNext()
  }

  const watchDiaries = (main: string, startedAt: number) => {
    const paths = diaryPaths(main, startedAt)
    for (const path of [noitesFolder(main), ...paths]) watches.watch(path)
    return paths
  }

  /** Closes the night's own tab and its process; the terminal goes only when that was all of it. */
  const closeTab = (current: Running) => {
    const projects = useProjectsStore.getState()
    const terminal = projects.projects
      .find((project) => project.id === current.projectId)
      ?.terminals.find((item) => item.id === current.terminalId)
    if (!terminal || !current.tabId || !terminal.tabs.some((tab) => tab.id === current.tabId)) {
      return
    }
    if (terminal.tabs.length === 1) projects.deleteTerminal(current.projectId, terminal.id)
    else projects.closeSubTab(current.projectId, terminal.id, current.tabId)
  }

  /** Closes the task's tab, counts its result and rests before the next one. */
  const finish = (current: Running, result: NightResult, stop: StopReason | null = null) => {
    closeTab(current)
    watches.clear()
    const { nightRun } = todos()
    const night = nightRun.nights[current.projectId]
    const failed = result === 'falhou' || result === 'parou'
    void save({
      current: null,
      nights: night
        ? {
            ...nightRun.nights,
            [current.projectId]: {
              ...night,
              failures: failed ? night.failures + 1 : 0,
              stopped: stop ?? night.stopped,
            },
          }
        : nightRun.nights,
    })
    restUntil = Date.now() + REST_MS
    clearTimeout(restTimer)
    restTimer = setTimeout(() => void tick(), REST_MS)
  }

  /**
   * Done when the diary has its line. At the deadline set when it started, or when found after a
   * restart, it is recorded as `parou`; when that line cannot be written it is tried once more at
   * the next check, and then the night ends rather than lose it.
   */
  const checkRunning = async (current: Running, afterRestart: boolean) => {
    const over = afterRestart || current.pendingStop !== undefined || Date.now() >= current.deadline
    const found = await checkoutsOf(current.projectId)
    if (!found) {
      // The project is gone or no longer a repository: there is no diary to read or write.
      if (over) finish(current, 'parou')
      return
    }
    for (const path of watchDiaries(found.main, current.startedAt)) {
      const entry = taskDone(await readDiary(path), current.taskId, current.startedAt)
      if (entry) {
        finish(current, entry.result)
        return
      }
    }
    if (!over) return
    const minutes = Math.round((current.deadline - current.startedAt) / 60_000)
    const summary =
      current.pendingStop ??
      (afterRestart ? 'Alethe reiniciado' : `tempo esgotado no agendador (${minutes} min)`)
    const outcome = await recordStopped(found.main, current, summary)
    if (outcome.kind === 'done') finish(current, outcome.entry.result)
    else if (outcome.kind === 'written') finish(current, 'parou')
    else if (current.pendingStop === undefined) {
      void save({ ...todos().nightRun, current: { ...current, pendingStop: summary } })
    } else finish(current, 'parou', 'diary')
  }

  /**
   * Starts `task` unless the settings or the clock changed during the reads that chose it. The
   * start, with the task marked attempted tonight, is saved before the tab is opened.
   */
  const begin = async (
    projectId: string,
    registry: Registry,
    pick: { campaign: Campaign; task: CampaignTask },
    counts: Night,
    quotaUnread: boolean,
  ) => {
    const settings = todos().nightSettings[projectId]
    const now = new Date()
    const end = settings ? windowEnd(now, settings.start, settings.end) : null
    if (!settings?.enabled || !end) return
    const input = { now, settings, ...counts, hasTask: true, usage: null }
    if (shouldStop(input)) return
    const startedAt = now.getTime()
    const current: Running = {
      projectId,
      campaignId: pick.campaign.id,
      taskId: pick.task.id,
      terminalId: null,
      tabId: null,
      startedAt,
      deadline: Math.min(startedAt + settings.maxMinutesPerTask * 60_000, end.getTime()),
      ...(quotaUnread ? { quotaUnread } : {}),
    }
    const nights = {
      ...todos().nightRun.nights,
      [projectId]: {
        ...counts,
        started: counts.started + 1,
        attempted: [...counts.attempted, pick.task.id],
      },
    }
    try {
      await todos().setNightRun({ current, nights })
    } catch {
      void save({ current: null, nights })
      return
    }
    const terminalId = await openCampaign(projectId, pick.campaign, 'claude', registry, pick.task)
    const tabId = terminalId
      ? (useProjectsStore
          .getState()
          .projects.find((project) => project.id === projectId)
          ?.terminals.find((terminal) => terminal.id === terminalId)?.activeTabId ?? null)
      : null
    if (!terminalId || !tabId) {
      void save({ ...todos().nightRun, current: null })
      return
    }
    void save({ ...todos().nightRun, current: { ...current, terminalId, tabId } })
    watchDiaries(registry.main, startedAt)
  }

  /** Starts the next free night task of the first project whose night may go on. */
  const startNext = async () => {
    for (const project of useProjectsStore.getState().projects) {
      const settings = todos().nightSettings[project.id]
      if (!settings?.enabled) continue
      const now = new Date()
      const night = nightDate(now)
      const saved = todos().nightRun.nights[project.id]
      const record = saved?.night === night ? saved : null
      if (record?.stopped) continue
      if (!inWindow(now, settings.start, settings.end)) {
        if (record) saveNight(project.id, { ...record, stopped: 'window' })
        continue
      }
      const registry = await loadRegistry(project.id)
      if (!registry) continue
      const counts: Night = record ?? {
        night,
        started: 0,
        failures: 0,
        stopped: null,
        attempted: [],
      }
      const diary = await readDiary(diaryPath(registry.main, night))
      const pick = nextNightTask(registry.campaigns, diary, counts.attempted)
      const input: StopInput = {
        now,
        settings,
        started: counts.started,
        failures: counts.failures,
        hasTask: pick !== null,
        usage: null,
      }
      // Usage is read last, from the shared cache, only when a task would start; a usage that
      // cannot be read does not stop the night.
      const early = shouldStop(input)
      const usage = early ? null : await claudeUsage()
      const reason = early ?? shouldStop({ ...input, usage })
      if (reason || !pick) {
        saveNight(project.id, { ...counts, stopped: reason ?? 'none' })
        continue
      }
      await begin(project.id, registry, pick, counts, usage === null)
      return
    }
  }

  const interval = setInterval(() => void tick(), TICK_MS)
  const unsubscribe = useTodosStore.subscribe((state, previous) => {
    if (state.nightSettings !== previous.nightSettings) void tick()
  })
  const unlisten = listenFileChanged((path) => {
    if (watches.has(path)) void tick()
  })
  void tick()

  return {
    tick,
    idle: () => pending ?? Promise.resolve(),
    stop: () => {
      stopped = true
      clearInterval(interval)
      clearTimeout(restTimer)
      unsubscribe()
      watches.clear()
      void unlisten.then((off) => off()).catch(() => {})
    },
  }
}
