/**
 * The campaign registry as the Todo tab uses it: read and watched once, shared by the list and the
 * Campaigns map, and edited from the list through the registry write command.
 */
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import {
  activeCampaign,
  addCampaignTask,
  type Campaign,
  campaignActivity,
  campaignCwd,
  campaignPrerequisites,
  type CampaignRegistry,
  campaignStepTitle,
  type CampaignTab,
  type CampaignTask,
  campaignWorkers,
  checkedResult,
  inCheckouts,
  isoDay,
  liveTaskWorkers,
  type NightDiary,
  nightDiaryFiles,
  type NightEntry,
  nightPrompt,
  parseCampaigns,
  parseNightDiary,
  registryPath,
  resumePrompt,
  setCampaignDependencies,
  setCampaignTaskState,
  type TaskState,
  type TaskWorkers,
  workflowPath,
} from '../../lib/campaigns'
import {
  getLocale,
  intlLocale,
  type MessageKey,
  type TFunction,
  translate,
  useT,
} from '../../lib/i18n'
import { createOrchestratedTerminal } from '../../lib/orchestrationOnTerminal'
import type { SessionEvent } from '../../lib/sessionEvents'
import {
  campaignRegistryWrite,
  findRelativePath,
  type GitCheckouts,
  listDirectory,
  listenFileChanged,
  listenOrchestratorJobs,
  orchestratorCancel,
  type OrchestratorJob,
  orchestratorJobs,
  type OrchestratorSnapshot,
  readTextFile,
  recordFrontendError,
  unwatchFile,
  watchFile,
  worktreeCheckouts,
  writePty,
} from '../../lib/tauri'
import { getProjectDefaultCwd } from '../../lib/terminalFactory'
import type { PtyStatus, SubTab, Terminal, TerminalCreationPreset } from '../../lib/types'
import { useCampaignStepsStore } from '../../stores/campaignStepsStore'
import { selectActiveProject, useProjectsStore } from '../../stores/projectsStore'
import {
  refreshSession,
  sessionKeyId,
  useRetainSessions,
  useSessionStore,
} from '../../stores/sessionStore'
import { anyTabWorking, type PtyRuntime, useTerminalsStore } from '../../stores/terminalsStore'
import { useUiStore } from '../../stores/uiStore'
import { WINDOW_KEYS } from './labels'
import { useTodosStore } from './store'
import { createWatchSet } from './watchSet'

export const STATE_KEYS: Record<TaskState, MessageKey> = {
  proposta: 'todo.campaigns.stateProposed',
  pronta: 'todo.campaigns.stateReady',
  'em execução': 'todo.campaigns.stateRunning',
  bloqueada: 'todo.campaigns.stateBlocked',
  reservada: 'todo.campaigns.stateReserved',
  concluída: 'todo.campaigns.stateDone',
}

/** The agents a campaign opens in. */
export const AGENTS = ['claude', 'codex'] as const
export type CampaignAgent = (typeof AGENTS)[number]

export const TASK_LANES: Record<TaskState, string> = {
  proposta: 'idle',
  pronta: 'queued',
  'em execução': 'running',
  bloqueada: 'blocked',
  reservada: 'idle',
  concluída: 'finished',
}

export type Registry = CampaignRegistry & {
  projectId: string
  /** Absolute path of `.workflow/campanhas.json` in the main checkout. */
  path: string
  main: string
  checkouts: GitCheckouts
  /** The file as read: the version a write expects to replace. */
  text: string
}

/**
 * Why there is no registry to show: nothing is at its path, or a stage of reading it failed, with
 * the reason; an empty one is the stage's own (no main checkout, or JSON that is no registry).
 */
export type RegistryProblem =
  { kind: 'missing' } | { kind: 'error'; stage: 'checkouts' | 'read' | 'parse'; message: string }

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The JSON error of a text that is no registry; empty when it is JSON of another shape. */
function jsonError(text: string): string {
  try {
    JSON.parse(text)
    return ''
  } catch (error) {
    return reason(error)
  }
}

/** The failures already logged, oldest first, so that retrying one does not log it again. */
const loggedProblems = new Set<string>()
const MAX_LOGGED_PROBLEMS = 50

/**
 * Logs a registry failure of `projectPath` (`problem`) once: the same one again is skipped until
 * that registry reads fine (null). Only the last 50 are remembered.
 */
export function logRegistryProblem(projectPath: string, problem: string | null) {
  const prefix = `Campaign registry of ${projectPath}: `
  if (problem === null) {
    for (const line of loggedProblems) if (line.startsWith(prefix)) loggedProblems.delete(line)
    return
  }
  const line = prefix + problem
  if (loggedProblems.has(line)) return
  loggedProblems.add(line)
  if (loggedProblems.size > MAX_LOGGED_PROBLEMS) {
    loggedProblems.delete(loggedProblems.values().next().value as string)
  }
  void recordFrontendError(line, null, 'todo-registry')
}

/** A stage's own reason, for the log, when its error has none. */
const STAGE_REASONS = {
  checkouts: 'no main checkout',
  read: 'unreadable',
  parse: 'not a campaign registry',
} as const

/**
 * Reads the registry in the main checkout of `projectPath` and re-reads it when the file changes;
 * `reload` re-reads it now, and `publish` shows text just written to it. Without a registry,
 * `problem` says why.
 */
export function useCampaignRegistry(
  projectId: string | null,
  projectPath: string,
): Pick<CampaignView, 'registry' | 'problem' | 'reload' | 'publish'> {
  const [registry, setRegistry] = useState<Registry | null>(null)
  const [problem, setProblem] = useState<{ projectId: string; problem: RegistryProblem } | null>(
    null,
  )
  const reloadRef = useRef<() => Promise<void>>(async () => {})
  const publishRef = useRef<(path: string, text: string) => void>(() => {})

  useEffect(() => {
    if (!projectId || !projectPath) return
    let cancelled = false
    let latest = 0
    let target: string | null = null
    let watched: string | null = null
    let watching: string | null = null
    // The last read failed: coming back to the window tries again.
    let failed = false
    // The path counts as watched only once the watch is in place; it fails while `.workflow`
    // does not exist, and `retry` tries again when the user comes back to the window.
    const watch = async (path: string) => {
      if (watched === path || watching === path) return
      watching = path
      const ok = await watchFile(path).then(
        () => true,
        () => false,
      )
      if (watching === path) watching = null
      if (!ok) return
      if (cancelled || target !== path) {
        void unwatchFile(path).catch(() => {})
        return
      }
      if (watched) void unwatchFile(watched).catch(() => {})
      watched = path
    }
    const show = (shown: Registry | null, next: RegistryProblem | null) => {
      failed = next?.kind === 'error'
      setRegistry(shown)
      setProblem(next ? { projectId, problem: next } : null)
      if (shown) logRegistryProblem(projectPath, null)
      if (next?.kind !== 'error') return
      logRegistryProblem(projectPath, `${next.stage}: ${next.message || STAGE_REASONS[next.stage]}`)
    }
    const reload = async () => {
      // Reloads overlap (file events, focus); only the newest one may publish.
      const request = ++latest
      const stale = () => cancelled || request !== latest
      let checkouts: GitCheckouts
      try {
        checkouts = await worktreeCheckouts(projectPath)
      } catch (error) {
        if (!stale()) show(null, { kind: 'error', stage: 'checkouts', message: reason(error) })
        return
      }
      if (stale()) return
      const { main } = checkouts
      // A bare repository: no checkout to hold the registry, which is no proof that there is none.
      if (!main) {
        show(null, { kind: 'error', stage: 'checkouts', message: '' })
        return
      }
      const path = registryPath(main)
      target = path
      await watch(path)
      let text: string
      try {
        text = await readTextFile(path)
      } catch (error) {
        if (stale()) return
        // read_text_file's own words for a path that is no file.
        const message = reason(error)
        show(
          null,
          message === 'file not found'
            ? { kind: 'missing' }
            : { kind: 'error', stage: 'read', message },
        )
        return
      }
      if (stale()) return
      const parsed = parseCampaigns(text)
      if (!parsed) {
        show(null, { kind: 'error', stage: 'parse', message: jsonError(text) })
        return
      }
      show({ ...parsed, projectId, path, main, checkouts, text }, null)
    }
    reloadRef.current = reload
    publishRef.current = (path, text) => {
      const parsed = cancelled || path !== target ? null : parseCampaigns(text)
      if (parsed)
        setRegistry((shown) => (shown?.path === path ? { ...shown, ...parsed, text } : shown))
    }
    const retry = () => {
      if (document.visibilityState === 'hidden') return
      if ((target && watched !== target) || failed) void reload()
    }
    void reload()
    const unlisten = listenFileChanged((path) => {
      if (path === watched) void reload()
    })
    window.addEventListener('focus', retry)
    document.addEventListener('visibilitychange', retry)
    return () => {
      cancelled = true
      window.removeEventListener('focus', retry)
      document.removeEventListener('visibilitychange', retry)
      if (watched) void unwatchFile(watched).catch(() => {})
      void unlisten.then((stop) => stop()).catch(() => {})
    }
  }, [projectId, projectPath])

  // Keyed by project, not path: opening a terminal moves the project's default cwd to another
  // worktree of the same repository, and the panel should not blink while it re-reads.
  return {
    registry: registry?.projectId === projectId ? registry : null,
    problem: problem?.projectId === projectId ? problem.problem : null,
    reload: () => reloadRef.current(),
    publish: (path, text) => publishRef.current(path, text),
  }
}

/** The focused terminal tab, when it belongs to the active project. */
function useFocusedTab(): CampaignTab | null {
  const target = useUiStore((state) => state.activeTerminal)
  const terminal = useProjectsStore((state) =>
    target && target.projectId === state.activeProjectId
      ? state.projects
          .find((project) => project.id === target.projectId)
          ?.terminals.find((item) => item.id === target.terminalId)
      : undefined,
  )
  if (!terminal || (terminal.kind ?? 'terminal') !== 'terminal') return null
  const tab = terminal.tabs.find((item) => item.id === terminal.activeTabId)
  return tab ? { campaignId: tab.campaignId, cwd: tab.cwd || terminal.cwd } : null
}

export type CampaignView = {
  projectId: string | null
  registry: Registry | null
  /** Why there is no registry, once that is known; null while it loads or once it is read. */
  problem: RegistryProblem | null
  /** The campaign being worked on: the focused terminal's, else the project's last one. */
  activeId: string | null
  reload: () => Promise<void>
  /** Shows `text`, just written to the registry at `path`, when that registry is the one shown. */
  publish: (path: string, text: string) => void
}

/** The active project's registry and active campaign, shared by the Todo list and the map. */
export function useCampaignView(): CampaignView {
  const projectId = useProjectsStore((state) => state.activeProjectId)
  const projectPath = useProjectsStore((state) =>
    getProjectDefaultCwd(selectActiveProject(state), state.projects),
  )
  const { registry, problem, reload, publish } = useCampaignRegistry(projectId, projectPath)
  const focused = useFocusedTab()
  const remembered = useTodosStore((state) =>
    projectId ? (state.activeCampaigns[projectId] ?? null) : null,
  )
  const rememberCampaign = useTodosStore((state) => state.rememberCampaign)
  const activeId = registry
    ? activeCampaign(registry.campaigns, registry.checkouts, focused, remembered)
    : null

  useEffect(() => {
    if (projectId && activeId && activeId !== remembered) rememberCampaign(projectId, activeId)
  }, [projectId, activeId, remembered, rememberCampaign])

  // Where each campaign is by its steps, for the terminal titles; none once the registry is gone,
  // or once the Todo panel is, since nothing would keep them current.
  const publishSteps = useCampaignStepsStore((state) => state.publish)
  useEffect(() => {
    if (!projectId) return
    const titles = registry?.campaigns.flatMap((campaign) => {
      const title = campaignStepTitle(campaign)
      return title ? [[campaign.id, title] as const] : []
    })
    publishSteps(projectId, titles ? Object.fromEntries(titles) : null)
  }, [projectId, registry, publishSteps])
  useEffect(() => {
    if (projectId) return () => publishSteps(projectId, null)
  }, [projectId, publishSteps])

  return { projectId, registry, problem, activeId, reload, publish }
}

/** The first open terminal tab that `matches`, in the focused terminal first, then in enabled ones. */
function findTab(
  terminals: readonly Terminal[],
  focused: string | undefined,
  matches: (tab: SubTab) => boolean,
): { terminal: Terminal; tab: SubTab } | null {
  const ordered = [...terminals].sort(
    (a, b) =>
      Number(b.id === focused) - Number(a.id === focused) ||
      Number(Boolean(a.disabled)) - Number(Boolean(b.disabled)),
  )
  for (const terminal of ordered) {
    if ((terminal.kind ?? 'terminal') !== 'terminal') continue
    const tab = terminal.tabs.find(matches)
    if (tab) return { terminal, tab }
  }
  return null
}

/**
 * Makes the first open terminal tab that `matches` the active one (see `findTab`); returns its
 * terminal id, or null when none matches. A disabled terminal is enabled again: its tab still
 * counts the campaign as Active.
 */
function activateTab(
  projectId: string,
  matches: (tab: SubTab) => boolean,
  allowDisabled = true,
): string | null {
  const store = useProjectsStore.getState()
  const found = findTab(
    (store.projects.find((item) => item.id === projectId)?.terminals ?? []).filter(
      (terminal) => allowDisabled || !terminal.disabled,
    ),
    useUiStore.getState().activeTerminal?.terminalId,
    matches,
  )
  if (!found) return null
  const { terminal, tab } = found
  if (terminal.disabled) store.setTerminalDisabled(projectId, terminal.id, false)
  store.setActiveTab(projectId, terminal.id, tab.id)
  return terminal.id
}

/**
 * Focuses the terminal, opening its grid when it is not shown. `show`, for the user's own click,
 * also leaves Home for the workspace; the night scheduler never moves the user's view.
 */
function focusTerminal(projectId: string, terminalId: string, show: boolean) {
  useProjectsStore.getState().focusWorkspaceTerminal(projectId, terminalId)
  const ui = useUiStore.getState()
  ui.setActiveTerminal(projectId, terminalId)
  ui.requestPaneFocus(terminalId)
  if (show) ui.setActiveView('workspace')
}

/**
 * The campaign's handoff as found on disk. Handoff paths are relative to the main checkout;
 * find_relative_path also looks in the sibling worktree named by the first segment.
 */
const findHandoff = (campaign: Campaign, registry: Registry): Promise<string | null> =>
  campaign.handoff
    ? findRelativePath(registry.main, campaign.handoff).catch(() => null)
    : Promise.resolve(null)

/**
 * Focuses the `agent` tab opened for this campaign, or opens one with its resume prompt (from
 * `resumeFrom` when given), as a planner grouped with an orchestration board, and returns its
 * terminal id. A tab opened by hand, or for another campaign, is never reused even in the same
 * checkout: it would not get this campaign's prompt. A `nightTask` (the night scheduler) always
 * gets a fresh plain tab, with the night prompt for that task. Without a tab of its own, the user's
 * campaign is refused, with a toast and null, while it waits on a campaign with a tab open or such
 * a campaign waits on it.
 */
/** A new campaign session always goes through the shared session dialog. */
export function requestCampaignSession(
  projectId: string,
  campaign: Campaign,
  registry: Registry,
  resumeFrom?: CampaignTask,
) {
  const cwd = campaignCwd(campaign, registry.checkouts)
  if (!cwd) return
  useUiStore.getState().openModal_('newTerminal', {
    projectId,
    cwd,
    only: [...AGENTS],
    onCreate: async (
      creation: TerminalCreationPreset,
      mode: 'terminal' | 'orchestration' = 'terminal',
    ) => {
      try {
        if (!AGENTS.includes(creation.firstTab.type as CampaignAgent)) return false
        const text = await readTextFile(registry.path)
        const parsed = parseCampaigns(text)
        const current = parsed?.campaigns.find((item) => item.id === campaign.id)
        if (!current || !parsed || parsed.errors.length)
          throw new Error('Invalid campaign registry')
        const task = resumeFrom
          ? current.tasks.find((item) => item.id === resumeFrom.id)
          : undefined
        if (resumeFrom && !task) throw new Error('Campaign task no longer exists')
        const opened = await openCampaign(
          projectId,
          current,
          creation.firstTab.type as CampaignAgent,
          { ...registry, ...parsed, text },
          undefined,
          task,
          creation,
          mode,
        )
        if (opened) useTodosStore.getState().rememberCampaign(projectId, current.id)
        return opened !== null
      } catch (error) {
        useUiStore.getState().pushToast({
          title: translate(getLocale(), 'todo.campaignWrite.title'),
          body: translate(getLocale(), 'todo.campaignWrite.failed', { message: reason(error) }),
        })
        return false
      }
    },
  })
}

export async function openCampaign(
  projectId: string,
  campaign: Campaign,
  agent: CampaignAgent,
  registry: Registry,
  nightTask?: CampaignTask,
  resumeFrom?: CampaignTask,
  creation?: TerminalCreationPreset,
  mode: 'terminal' | 'orchestration' = 'orchestration',
): Promise<string | null> {
  const cwd = creation?.cwd ?? campaignCwd(campaign, registry.checkouts)
  if (!cwd || !useProjectsStore.getState().projects.some((item) => item.id === projectId)) {
    return null
  }
  const refused = () => {
    if (nightTask) return false
    const ids = [
      ...new Set([
        ...campaignPrerequisites(campaign, registry.campaigns),
        ...(resumeFrom?.unmet ?? []),
      ]),
    ]
    if (!ids.length) return false
    useUiStore.getState().pushToast({
      title: translate(getLocale(), 'todo.campaigns.blockedTitle', { id: campaign.id }),
      body: translate(getLocale(), 'todo.campaigns.prerequisites', { ids: ids.join(', ') }),
    })
    return true
  }
  if (refused()) return null
  // Continue (`resumeFrom`) takes a tab of any agent, as it does before calling this; Open wants
  // the agent chosen.
  const running = (tab: SubTab) =>
    !nightTask && (resumeFrom !== undefined || tab.type === agent) && tab.campaignId === campaign.id
  let terminalId = creation ? null : activateTab(projectId, running)
  if (!terminalId) {
    const handoff = await findHandoff(campaign, registry)
    // Checked again: the tab, or one of a campaign it may not run beside, may have been opened
    // while the handoff was looked up.
    terminalId = creation ? null : activateTab(projectId, running)
    if (!terminalId && refused()) return null
    if (!terminalId) {
      if (creation) {
        const text = await readTextFile(registry.path)
        const parsed = parseCampaigns(text)
        const current = parsed?.campaigns.find((item) => item.id === campaign.id)
        if (!current || !parsed || parsed.errors.length)
          throw new Error('Invalid campaign registry')
        campaign = current
        registry = { ...registry, ...parsed, text }
        resumeFrom = resumeFrom
          ? current.tasks.find((item) => item.id === resumeFrom?.id)
          : undefined
        if (refused()) return null
      }
      // createTerminal, not createAgentTerminal: the tab belongs in the campaign's checkout, which
      // the project's automatic worktree isolation would replace with a new one.
      const create = () =>
        useProjectsStore.getState().createTerminal(projectId, {
          name: nightTask?.id ?? campaign.id,
          cwd,
          firstTab: {
            type: agent,
            cwd,
            campaignId: campaign.id,
            // Night work runs unattended in Claude's auto mode, never bypassing permissions: a
            // denied tool call becomes part of the task's result.
            extraArgs: nightTask ? ['--permission-mode', 'auto'] : creation?.firstTab.extraArgs,
            runtimeProfile: creation?.firstTab.runtimeProfile,
            useRouter9: creation?.firstTab.useRouter9,
            initialInput: nightTask
              ? nightPrompt(campaign, nightTask, registry.path, handoff)
              : resumePrompt(campaign, registry.path, handoff, resumeFrom),
          },
        })
      // Attach a board only when selected; unattended night sessions remain individual.
      terminalId = (
        nightTask || mode === 'terminal'
          ? create()
          : await createOrchestratedTerminal(projectId, cwd, create)
      ).id
    }
  }
  focusTerminal(projectId, terminalId, !nightTask)
  return terminalId
}

/** Focus an enabled session only; reactivation must go through launch validation. */
export function continueCampaign(projectId: string, campaign: Campaign): boolean {
  const terminalId = activateTab(projectId, (tab) => tab.campaignId === campaign.id, false)
  if (terminalId) focusTerminal(projectId, terminalId, true)
  return terminalId !== null
}

/** The campaign's tabs in the project, with their terminals. */
function campaignTabs(projectId: string, campaignId: string) {
  const terminals =
    useProjectsStore.getState().projects.find((item) => item.id === projectId)?.terminals ?? []
  return terminals.flatMap((terminal) =>
    terminal.tabs.filter((tab) => tab.campaignId === campaignId).map((tab) => ({ terminal, tab })),
  )
}

const tabWorking = (tab: SubTab) => anyTabWorking([tab], useTerminalsStore.getState().byPtyId)

/**
 * Continue campaign, offered to a campaign without a tab: opens Claude Code with its board and the
 * prompt to resume from `task`. A tab opened for it meanwhile is focused instead, as by Go to tab.
 */
export async function resumeCampaign(
  projectId: string,
  campaign: Campaign,
  registry: Registry,
  task: CampaignTask,
): Promise<void> {
  if (continueCampaign(projectId, campaign)) return
  requestCampaignSession(projectId, campaign, registry, task)
}

/**
 * Pause campaign: Esc to each of its tabs whose agent is working, which interrupts the turn as
 * pressing it in Claude Code or Codex does. Orchestration workers are left running.
 */
export async function pauseCampaign(projectId: string, campaignId: string): Promise<void> {
  const working = campaignTabs(projectId, campaignId).flatMap(({ tab }) =>
    tab.ptyId && tabWorking(tab) ? [tab.ptyId] : [],
  )
  await Promise.all(working.map((ptyId) => writePty(ptyId, '\x1b').catch(() => {})))
}

const LIVE_JOBS: ReadonlySet<OrchestratorJob['status']> = new Set(['queued', 'running', 'blocked'])

export type CampaignCancel = {
  tabs: number
  /** Workers cancelled, as the next snapshot shows them. */
  jobs: number
  /** Tasks with a worker still live after the cancel: refused, still running, or started since. */
  live: string[]
}

/**
 * Cancel campaign, once the user agreed. Its live orchestration workers (those on its tasks in this
 * repository's checkouts, one stopped on a question included) are listed first: when they cannot
 * be, it throws before anything is done. Then it interrupts its working tabs, cancels those
 * workers, checks a new snapshot for any of its workers still live, and closes its tabs the way the
 * UI does,
 * which kills their ptys: a terminal holding only its tabs is deleted, another one loses just those
 * tabs. The registry is left to the caller.
 */
export async function cancelCampaign(
  projectId: string,
  campaign: Campaign,
  registry: Registry,
): Promise<CampaignCancel> {
  const tasks = new Set(campaign.tasks.map((task) => task.id))
  const liveJobs = (snapshot: OrchestratorSnapshot) =>
    snapshot.jobs.filter(
      (job) =>
        job.task &&
        tasks.has(job.task) &&
        LIVE_JOBS.has(job.status) &&
        inCheckouts(job.cwd, registry.checkouts),
    )
  const jobs = liveJobs(await orchestratorJobs())
  await pauseCampaign(projectId, campaign.id)
  const results = await Promise.allSettled(jobs.map((job) => orchestratorCancel(job.id)))
  // Any worker of the campaign live now counts, also one started since the first listing; without
  // a new snapshot, no cancel is confirmed.
  const after = await orchestratorJobs().catch(() => null)
  const stillLive = after ? liveJobs(after) : jobs
  const refused = jobs.filter((_, index) => results[index].status === 'rejected')
  const live = [...refused, ...stillLive]
  const store = useProjectsStore.getState()
  const own = campaignTabs(projectId, campaign.id)
  for (const terminal of new Set(own.map((item) => item.terminal))) {
    const tabs = own.filter((item) => item.terminal === terminal).map((item) => item.tab)
    if (tabs.length === terminal.tabs.length) store.deleteTerminal(projectId, terminal.id)
    else for (const tab of tabs) store.closeSubTab(projectId, terminal.id, tab.id)
  }
  return {
    tabs: own.length,
    jobs: jobs.filter((job) => !live.some((other) => other.id === job.id)).length,
    live: [...new Set(live.flatMap((job) => (job.task ? [job.task] : [])))],
  }
}

/** What a campaign with something live for it shows: a subset of the pty statuses. */
export type CampaignLive = Extract<PtyStatus, 'working' | 'stopped'>

/**
 * The campaigns with a tab opened for them in `terminals`, or a live worker on one of their tasks:
 * `working` while one of those tabs works or one of those workers runs, else `stopped`. Campaigns
 * with neither are left out.
 */
export function campaignLiveStatus(
  campaigns: readonly Campaign[],
  terminals: readonly Pick<Terminal, 'tabs'>[],
  byPtyId: Readonly<Record<string, Pick<PtyRuntime, 'status'>>>,
  workers: ReadonlyMap<string, TaskWorkers>,
): Map<string, CampaignLive> {
  const tabs = terminals.flatMap((terminal) => terminal.tabs)
  const live = new Map<string, CampaignLive>()
  for (const campaign of campaigns) {
    const own = tabs.filter((tab) => tab.campaignId === campaign.id)
    const { running, queued } = campaignWorkers(
      campaign.tasks.map((task) => task.id),
      workers,
    )
    if (own.length === 0 && running + queued === 0) continue
    live.set(campaign.id, running > 0 || anyTabWorking(own, byPtyId) ? 'working' : 'stopped')
  }
  return live
}

// Stable fallback, so the selector below returns the same value while nothing changes.
const NO_TERMINALS: Terminal[] = []

/** `campaignLiveStatus` over the project's terminals. */
export function useCampaignLive(
  projectId: string | null,
  campaigns: readonly Campaign[],
  workers: ReadonlyMap<string, TaskWorkers>,
): ReadonlyMap<string, CampaignLive> {
  const terminals = useProjectsStore(
    (state) =>
      state.projects.find((project) => project.id === projectId)?.terminals ?? NO_TERMINALS,
  )
  // Read as a string, so output on a pty (recorded every 250 ms) does not re-render the caller.
  const key = useTerminalsStore((state) =>
    JSON.stringify([...campaignLiveStatus(campaigns, terminals, state.byPtyId, workers)]),
  )
  return useMemo(() => new Map<string, CampaignLive>(JSON.parse(key)), [key])
}

export type TaskJob = Pick<
  OrchestratorJob,
  'id' | 'task' | 'status' | 'cwd' | 'agent' | 'model'
> & {
  /** Whole minutes it has run (or ran); null before it starts. */
  minutes: number | null
}

/**
 * The orchestrator jobs that name a registry task, from the same snapshot and event the board
 * reads. Only that projection is kept, so a worker streaming its reply does not re-render the tab;
 * its elapsed time counts whole minutes. A worker can stay silent for minutes, so while one is live
 * a single clock adds the time since the snapshot each minute: the tab re-renders once a minute at
 * most, and only when a count changes.
 */
export function useTaskJobs(): TaskJob[] {
  const [key, setKey] = useState('[]')
  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined
    let clock: number | undefined
    // The latest snapshot's jobs, with their seconds as reported, and when it arrived.
    let latest: { at: number; jobs: Array<Omit<TaskJob, 'minutes'> & { seconds: number | null }> } =
      { at: 0, jobs: [] }
    const publish = () => {
      const since = (Date.now() - latest.at) / 1000
      const jobs = latest.jobs.map(({ seconds, ...job }) => ({
        ...job,
        minutes:
          seconds == null
            ? null
            : Math.floor((seconds + (LIVE_JOBS.has(job.status) ? since : 0)) / 60),
      }))
      setKey(JSON.stringify(jobs))
    }
    const apply = (snapshot: OrchestratorSnapshot) => {
      if (cancelled) return
      latest = {
        at: Date.now(),
        jobs: snapshot.jobs
          .filter((job) => job.task)
          .map(({ id, task, status, cwd, agent, model, seconds }) => ({
            id,
            task,
            status,
            cwd,
            agent,
            model,
            seconds,
          })),
      }
      publish()
      const live = latest.jobs.some((job) => LIVE_JOBS.has(job.status))
      if (live && clock === undefined) clock = window.setInterval(publish, 60_000)
      else if (!live && clock !== undefined) {
        window.clearInterval(clock)
        clock = undefined
      }
    }
    orchestratorJobs().then(apply, () => {})
    listenOrchestratorJobs(apply).then(
      (off) => {
        if (cancelled) off()
        else unlisten = off
      },
      () => {},
    )
    return () => {
      cancelled = true
      unlisten?.()
      window.clearInterval(clock)
    }
  }, [])
  return useMemo(() => JSON.parse(key) as TaskJob[], [key])
}

/** Live orchestrator workers per task of the registry's repository, from `useTaskJobs`. */
export function useTaskWorkers(
  registry: Registry | null,
  jobs: readonly TaskJob[],
): ReadonlyMap<string, TaskWorkers> {
  const checkouts = registry?.checkouts
  return useMemo(
    () => (checkouts ? liveTaskWorkers(jobs, checkouts) : new Map()),
    [jobs, checkouts],
  )
}

/**
 * The latest readable diary in `<main>/.workflow/local/noites`. Once the folder exists it is
 * watched (watch_file on a folder reports the files written in it), and so is every diary in it,
 * so an edit that fixes a malformed newest one is seen. Coming back to the window re-reads it too,
 * for the folder's creation.
 */
export function useNightDiary(main: string | null): NightDiary | null {
  const [state, setState] = useState<{ main: string; diary: NightDiary } | null>(null)

  useEffect(() => {
    if (!main) return
    const folder = workflowPath(main, 'local', 'noites')
    let cancelled = false
    let latest = 0
    const watches = createWatchSet()
    const reload = async () => {
      const request = ++latest
      const stale = () => cancelled || request !== latest
      const files = await listDirectory(folder).then(nightDiaryFiles, () => null)
      if (stale()) return
      if (files) for (const path of [folder, ...files]) watches.watch(path)
      for (const path of files ?? []) {
        const text = await readTextFile(path).catch(() => null)
        if (stale()) return
        const diary = text === null ? null : parseNightDiary(text)
        if (!diary) continue
        setState({ main, diary })
        return
      }
      setState(null)
    }
    void reload()
    const unlisten = listenFileChanged((path) => {
      if (watches.has(path)) void reload()
    })
    const retry = () => {
      if (document.visibilityState !== 'hidden') void reload()
    }
    window.addEventListener('focus', retry)
    document.addEventListener('visibilitychange', retry)
    return () => {
      cancelled = true
      window.removeEventListener('focus', retry)
      document.removeEventListener('visibilitychange', retry)
      watches.clear()
      void unlisten.then((stop) => stop()).catch(() => {})
    }
  }, [main])

  return state && state.main === main ? state.diary : null
}

/**
 * Whether a night entry still waits on the user: it waits on you, and its task, still in the
 * registry, was neither concluded nor put back in the queue.
 */
export function nightUndecided(entry: NightEntry, campaigns: readonly Campaign[]): boolean {
  if (entry.result !== 'aguarda-voce') return false
  const state = campaigns
    .flatMap((campaign) => campaign.tasks)
    .find((task) => task.id === entry.task)?.state
  return state !== undefined && state !== 'concluída' && state !== 'pronta'
}

/** "2 running · 1 queued"; null when nothing is live. */
export function workersLabel(t: TFunction, workers: TaskWorkers | undefined): string | null {
  const parts = [
    workers?.running ? t('todo.workers.running', { count: workers.running }) : null,
    workers?.queued ? t('todo.workers.queued', { count: workers.queued }) : null,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : null
}

const DONE: TaskState = 'concluída'

type Previous = { state: TaskState; result: string | null; evidence: string | null }
/** A check made here: the task as it was, and the result and evidence (if any) the check wrote. */
type Check = { previous: Previous; result: string; evidence?: string }
/** The registry an edit starts from: where it is, and its text as read. */
type Base = Pick<Registry, 'path' | 'text'>

export type CampaignEdits = ReturnType<typeof useCampaignEdits>

/**
 * Edits of the registry from the list. Each starts from the registry as last read, so a change
 * the script made meanwhile is refused as a conflict; the list shows a written edit at once and
 * reloads after a refused one.
 */
export function useCampaignEdits(view: CampaignView) {
  const t = useT()
  const pushToast = useUiStore((state) => state.pushToast)
  const latest = useRef(view)
  latest.current = view
  const busy = useRef(false)
  // State before each check made here, by registry path and task id: what undo puts back.
  const undo = useRef(new Map<string, Check>())
  const [, rerender] = useReducer((count: number) => count + 1, 0)

  const notify = (body: string, actions?: { label: string; run: () => void }[]) =>
    pushToast({ title: t('todo.campaignWrite.title'), body, actions })

  /**
   * Writes `content` over `base`, the registry as read; false, with a toast, when refused. With
   * `retry`, a conflict is handed back as `conflict` instead, for the caller to try again.
   */
  const write = async (
    base: Base,
    content: string,
    retry = false,
  ): Promise<boolean | 'conflict'> => {
    if (busy.current) return false
    busy.current = true
    rerender()
    try {
      const written = await campaignRegistryWrite(base.path, base.text, content)
      // Shown at once: the reload re-reads the worktrees with git (0.2 to 0.4 s on Windows), and
      // runs behind it to catch a write made meanwhile.
      latest.current.publish(base.path, written)
      void latest.current.reload()
      return true
    } catch (error) {
      if (retry && error === 'conflict') return 'conflict'
      notify(
        error === 'conflict'
          ? t('todo.campaignWrite.conflict')
          : t('todo.campaignWrite.failed', { message: String(error) }),
      )
      await latest.current.reload()
      return false
    } finally {
      busy.current = false
      rerender()
    }
  }

  /** Changes a task's state in `base`; returns the state it had, or null when nothing was written. */
  const setState = async (
    base: Base,
    taskId: string,
    state: TaskState,
    result: string | null | undefined,
    evidence?: string | null,
  ) => {
    const edit = setCampaignTaskState(
      base.text,
      taskId,
      state,
      result,
      isoDay(new Date()),
      evidence,
    )
    if (!edit.ok) {
      // A task that vanished means the registry changed under the list.
      notify(
        t(edit.error === 'missing' ? 'todo.campaignWrite.conflict' : 'todo.campaignWrite.invalid'),
      )
      return null
    }
    return (await write(base, edit.content)) ? edit.previous : null
  }

  // Undo entries belong to the registry a check was made in, captured when it started: the list
  // may show another project by the time the write ends or the undo runs.
  const entry = (path: string, taskId: string) => `${path}\n${taskId}`

  /**
   * Puts back the state a task of `path` had before it was checked here, while it is still done.
   * `resultado` and `evidencia` go back only while they hold what the check wrote: one written
   * since (an agent's evidence, say) stays.
   */
  const restore = async (path: string, taskId: string) => {
    const made = undo.current.get(entry(path, taskId))
    if (!made) return
    const { previous } = made
    const shown = latest.current.registry
    const text = shown?.path === path ? shown.text : await readTextFile(path).catch(() => null)
    const parsed = text === null ? null : parseCampaigns(text)
    const task = parsed?.campaigns
      .flatMap((campaign) => campaign.tasks)
      .find((item) => item.id === taskId)
    if (
      parsed &&
      text !== null &&
      task?.state === DONE &&
      !(await setState(
        { path, text },
        taskId,
        previous.state,
        task.result === made.result ? previous.result : undefined,
        made.evidence !== undefined && task.evidence === made.evidence
          ? previous.evidence
          : undefined,
      ))
    ) {
      return
    }
    undo.current.delete(entry(path, taskId))
    rerender()
  }

  /** Checks a task done for the user, with `evidence` when given, and offers an undo. */
  const check = async (taskId: string, evidence?: string) => {
    const registry = latest.current.registry
    if (!registry) return
    const { path } = registry
    const task = registry.campaigns
      .flatMap((campaign) => campaign.tasks)
      .find((item) => item.id === taskId)
    const result = checkedResult(task?.result ?? null, isoDay(new Date()))
    const previous = await setState(registry, taskId, DONE, result, evidence)
    if (!previous) return
    undo.current.set(entry(path, taskId), { previous, result, evidence })
    rerender()
    notify(t('todo.campaignWrite.done', { id: taskId }), [
      { label: t('todo.campaignWrite.undo'), run: () => void restore(path, taskId) },
    ])
  }

  return {
    busy: busy.current,
    undoable: (taskId: string) => {
      const path = latest.current.registry?.path
      return path !== undefined && undo.current.has(entry(path, taskId))
    },

    /** Adds a task to `campaign`; false, with a toast saying why, when nothing was written. */
    add: async (campaign: Campaign, title: string): Promise<boolean> => {
      const registry = latest.current.registry
      if (!registry) return false
      const result = addCampaignTask(registry.text, campaign.id, title, isoDay(new Date()))
      if (result.ok) return (await write(registry, result.content)) === true
      if (result.error === 'duplicate') {
        notify(t('todo.campaignWrite.duplicate', { campaign: campaign.id, id: result.id }))
      } else if (result.error === 'title') notify(t('todo.campaignWrite.badTitle'))
      else if (result.error === 'missing') notify(t('todo.campaignWrite.conflict'))
      else notify(t('todo.campaignWrite.invalid'))
      return false
    },

    dependencies: async (campaign: Campaign, ids: string[], source?: string): Promise<boolean> => {
      const registry = latest.current.registry
      if (!registry) return false
      const result = setCampaignDependencies(
        source ?? registry.text,
        campaign.id,
        ids,
        isoDay(new Date()),
      )
      if (result.ok)
        return (
          (await write({ ...registry, text: source ?? registry.text }, result.content)) === true
        )
      notify(t('todo.campaignWrite.invalid'))
      return false
    },

    /** Checks an open task done, with an undo; on a task checked here, undoes the check. */
    toggle: async (task: CampaignTask) => {
      const path = latest.current.registry?.path
      if (task.state !== DONE) await check(task.id)
      else if (path !== undefined) await restore(path, task.id)
    },

    /** The user's Gate 2 on a task waiting for it: done, with `evidence` when given, and an undo. */
    conclude: (taskId: string, evidence?: string) => check(taskId, evidence),

    /**
     * Puts every task in progress of `campaignId` back as ready, but those in `keep`, in one write
     * over the registry at `path`; only their states change. It starts from the file as it is now,
     * not as the list last read it, so a change the list has not read yet does not refuse it; a
     * conflict is tried once more from the file as it is then. Returns how many, or null when
     * nothing was written.
     */
    release: async (
      path: string,
      campaignId: string,
      keep: readonly string[] = [],
    ): Promise<number | null> => {
      for (const retry of [true, false]) {
        let text: string
        try {
          text = await readTextFile(path)
        } catch (error) {
          notify(t('todo.campaignWrite.failed', { message: String(error) }))
          return null
        }
        const campaign = parseCampaigns(text)?.campaigns.find((item) => item.id === campaignId)
        const running = (campaign?.tasks ?? [])
          .filter((task) => task.state === 'em execução' && !keep.includes(task.id))
          .map((task) => task.id)
        if (running.length === 0) return 0
        let content = text
        for (const taskId of running) {
          const edit = setCampaignTaskState(
            content,
            taskId,
            'pronta',
            undefined,
            isoDay(new Date()),
          )
          if (!edit.ok) {
            notify(
              t(
                edit.error === 'missing'
                  ? 'todo.campaignWrite.conflict'
                  : 'todo.campaignWrite.invalid',
              ),
            )
            return null
          }
          content = edit.content
        }
        const written = await write({ path, text }, content, retry)
        if (written !== 'conflict') return written ? running.length : null
      }
      return null
    },

    /** Puts a task back as ready, for the next night to retry it; only its state changes. */
    requeue: async (taskId: string) => {
      const registry = latest.current.registry
      if (registry && (await setState(registry, taskId, 'pronta', undefined))) {
        notify(t('todo.campaignWrite.requeued', { id: taskId }))
      }
    },
  }
}

/**
 * A campaign's window, worktree (with how many more it lists) and last update, as its map row and
 * its Active header read them.
 */
export function useCampaignFacts(campaign: Campaign, checkouts: GitCheckouts) {
  const t = useT()
  const locale = useProjectsStore((state) => state.preferences.language)
  const activity = campaignActivity(campaign, checkouts)
  const updated =
    activity.updatedAt === null
      ? null
      : new Intl.DateTimeFormat(intlLocale(locale), {
          day: '2-digit',
          month: '2-digit',
          ...(activity.fromGit ? { hour: '2-digit', minute: '2-digit' } : {}),
        }).format(activity.updatedAt)
  return {
    window: t(WINDOW_KEYS[campaign.window]),
    worktree: activity.worktree
      ? `${activity.worktree}${activity.extra > 0 ? ` (+${activity.extra})` : ''}`
      : '—',
    updated: updated === null ? null : t('todo.campaigns.updated', { when: updated }),
  }
}

/** What a campaign's agent last said: its last answer, and a question it still waits on. */
export type AgentTail = { message: string | null; question: string | null }

/** The roles that come after a question once it is answered, as the Remote Control chat reads it. */
const ANSWERED: ReadonlySet<SessionEvent['role']> = new Set([
  'user',
  'assistant',
  'tool-result',
  'question',
])

/** A session tail's last answer, and its last question when nothing has come after it. */
export function agentTail(messages: readonly SessionEvent[]): AgentTail {
  const answer = [...messages]
    .reverse()
    .find((item) => item.role === 'assistant' && item.text.trim())
  const last = messages.map((item) => item.role).lastIndexOf('question')
  const question =
    last >= 0 &&
    (messages[last].questions?.length ?? 0) > 0 &&
    !messages.slice(last + 1).some((item) => ANSWERED.has(item.role))
      ? messages[last].text
      : null
  return { message: answer?.text ?? null, question }
}

type AgentTab = {
  campaignId: string
  provider: 'claude' | 'codex'
  cwd: string
  sessionId: string
  ptyId: string
}

/**
 * What each campaign's agent tab (the one Go to tab focuses) last said, from its session in the
 * session store: read once it shows up, then whenever its transcript changes, and again each time
 * its agent goes from working to waiting or stopped. What was read belongs to the session, so tabs
 * on one session share it, and an older reply never replaces a newer one. Only Claude and Codex
 * tabs with a session are read.
 */
export function useAgentTails(
  projectId: string | null,
  campaignIds: readonly string[],
): ReadonlyMap<string, AgentTail> {
  const focused = useUiStore((state) => state.activeTerminal?.terminalId)
  // One line per readable tab, as a string, so that nothing else in the projects re-renders.
  const key = useProjectsStore((state) => {
    const terminals = state.projects.find((project) => project.id === projectId)?.terminals ?? []
    return campaignIds
      .flatMap((id) => {
        const found = findTab(terminals, focused, (tab) => tab.campaignId === id)
        const tab = found?.tab
        if (!found || !tab?.sessionId || (tab.type !== 'claude' && tab.type !== 'codex')) return []
        return [
          [id, tab.type, tab.cwd || found.terminal.cwd, tab.sessionId, tab.ptyId ?? ''].join('\t'),
        ]
      })
      .join('\n')
  })
  const tabs = useMemo(
    () =>
      key
        ? key.split('\n').map((line): AgentTab & { key: string; session: string } => {
            const [campaignId, provider, cwd, sessionId, ptyId] = line.split('\t')
            return {
              key: line,
              session: sessionKeyId({ provider: provider as AgentTab['provider'], cwd, sessionId }),
              campaignId,
              provider: provider as AgentTab['provider'],
              cwd,
              sessionId,
              ptyId,
            }
          })
        : [],
    [key],
  )
  // Their agents' statuses, a primitive per tab.
  const statusKey = useTerminalsStore((state) =>
    tabs.map((tab) => state.byPtyId[tab.ptyId]?.status ?? '').join('\n'),
  )
  useRetainSessions(tabs.map((tab) => tab.session))
  const statuses = useRef(new Map<string, string>())

  // The session store follows each transcript; a stop is when a new answer is most likely, so it
  // reads again then too.
  useEffect(() => {
    const now = statusKey.split('\n')
    tabs.forEach((tab, index) => {
      const status = now[index] ?? ''
      const before = statuses.current.get(tab.key)
      statuses.current.set(tab.key, status)
      if (before === 'working' && (status === 'waiting' || status === 'stopped')) {
        refreshSession({ provider: tab.provider, cwd: tab.cwd, sessionId: tab.sessionId })
      }
    })
  }, [statusKey, tabs])

  // Each tab's session as read: one stable reference per tab, which changes only with a new read.
  const sessions = useSessionStore(
    useShallow((state) => tabs.map((tab) => state.sessions[tab.session])),
  )
  return useMemo(() => {
    const byCampaign = new Map<string, AgentTail>()
    tabs.forEach((tab, index) => {
      const session = sessions[index]
      if (session?.revision) byCampaign.set(tab.campaignId, agentTail(session.events))
    })
    return byCampaign
  }, [tabs, sessions])
}
