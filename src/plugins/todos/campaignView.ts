/**
 * The campaign registry as the Todo tab uses it: read and watched once, shared by the list and the
 * Campaigns map, and edited from the list through the registry write command.
 */
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'

import {
  activeCampaign,
  addCampaignTask,
  type Campaign,
  campaignCwd,
  type CampaignRegistry,
  type CampaignTab,
  type CampaignTask,
  campaignWorkers,
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
  setCampaignTaskState,
  type TaskState,
  type TaskWorkers,
  workflowPath,
} from '../../lib/campaigns'
import { type MessageKey, type TFunction, useT } from '../../lib/i18n'
import { createOrchestratedTerminal } from '../../lib/orchestrationOnTerminal'
import {
  campaignRegistryWrite,
  findRelativePath,
  type GitCheckouts,
  listDirectory,
  listenFileChanged,
  listenOrchestratorJobs,
  type OrchestratorJob,
  orchestratorJobs,
  type OrchestratorSnapshot,
  readTextFile,
  unwatchFile,
  watchFile,
  worktreeCheckouts,
} from '../../lib/tauri'
import { getProjectDefaultCwd } from '../../lib/terminalFactory'
import type { PtyStatus, SubTab, Terminal } from '../../lib/types'
import { selectActiveProject, useProjectsStore } from '../../stores/projectsStore'
import { anyTabWorking, type PtyRuntime } from '../../stores/terminalsStore'
import { useUiStore } from '../../stores/uiStore'
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
 * Reads the registry in the main checkout of `projectPath` and re-reads it when the file changes;
 * `reload` re-reads it now, and `publish` shows text just written to it.
 */
export function useCampaignRegistry(
  projectId: string | null,
  projectPath: string,
): Pick<CampaignView, 'registry' | 'reload' | 'publish'> {
  const [registry, setRegistry] = useState<Registry | null>(null)
  const reloadRef = useRef<() => Promise<void>>(async () => {})
  const publishRef = useRef<(path: string, text: string) => void>(() => {})

  useEffect(() => {
    if (!projectId || !projectPath) return
    let cancelled = false
    let latest = 0
    let target: string | null = null
    let watched: string | null = null
    let watching: string | null = null
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
    const reload = async () => {
      // Reloads overlap (file events, focus); only the newest one may publish.
      const request = ++latest
      const stale = () => cancelled || request !== latest
      const checkouts = await worktreeCheckouts(projectPath).catch(() => null)
      if (stale()) return
      const main = checkouts?.main
      if (!checkouts || !main) {
        setRegistry(null)
        return
      }
      const path = registryPath(main)
      target = path
      await watch(path)
      const text = await readTextFile(path).catch(() => null)
      if (stale()) return
      const parsed = text === null ? null : parseCampaigns(text)
      setRegistry(
        parsed && text !== null ? { ...parsed, projectId, path, main, checkouts, text } : null,
      )
    }
    reloadRef.current = reload
    publishRef.current = (path, text) => {
      const parsed = cancelled || path !== target ? null : parseCampaigns(text)
      if (parsed)
        setRegistry((shown) => (shown?.path === path ? { ...shown, ...parsed, text } : shown))
    }
    const retry = () => {
      if (target && watched !== target && document.visibilityState !== 'hidden') void reload()
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
  const { registry, reload, publish } = useCampaignRegistry(projectId, projectPath)
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

  return { projectId, registry, activeId, reload, publish }
}

/**
 * Makes the first open terminal tab that `matches` the active one, looking in the focused
 * terminal first, then in enabled ones; returns its terminal id, or null when none matches. A
 * disabled terminal is enabled again: its tab still counts the campaign as Active.
 */
function activateTab(projectId: string, matches: (tab: SubTab) => boolean): string | null {
  const store = useProjectsStore.getState()
  const focused = useUiStore.getState().activeTerminal?.terminalId
  const terminals = [...(store.projects.find((item) => item.id === projectId)?.terminals ?? [])]
  terminals.sort(
    (a, b) =>
      Number(b.id === focused) - Number(a.id === focused) ||
      Number(Boolean(a.disabled)) - Number(Boolean(b.disabled)),
  )
  for (const terminal of terminals) {
    if ((terminal.kind ?? 'terminal') !== 'terminal') continue
    const tab = terminal.tabs.find(matches)
    if (!tab) continue
    if (terminal.disabled) store.setTerminalDisabled(projectId, terminal.id, false)
    store.setActiveTab(projectId, terminal.id, tab.id)
    return terminal.id
  }
  return null
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
 * Focuses the `agent` tab opened for this campaign, or opens one with its resume prompt, as a
 * planner grouped with an orchestration board, and returns its terminal id. A tab opened by hand,
 * or for another campaign, is never reused even in the same checkout: it would not get this
 * campaign's prompt. A `nightTask` (the night scheduler) always gets a fresh plain tab, with the
 * night prompt for that task.
 */
export async function openCampaign(
  projectId: string,
  campaign: Campaign,
  agent: CampaignAgent,
  registry: Registry,
  nightTask?: CampaignTask,
): Promise<string | null> {
  const cwd = campaignCwd(campaign, registry.checkouts)
  if (!cwd || !useProjectsStore.getState().projects.some((item) => item.id === projectId)) {
    return null
  }
  const running = (tab: SubTab) =>
    !nightTask && tab.type === agent && tab.campaignId === campaign.id
  let terminalId = activateTab(projectId, running)
  if (!terminalId) {
    // Handoff paths are relative to the main checkout; find_relative_path also looks in the
    // sibling worktree named by the first segment.
    const handoff = campaign.handoff
      ? await findRelativePath(registry.main, campaign.handoff).catch(() => null)
      : null
    // Checked again: the tab may have been opened while the handoff was looked up.
    terminalId = activateTab(projectId, running)
    if (!terminalId) {
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
            extraArgs: nightTask ? ['--permission-mode', 'auto'] : undefined,
            initialInput: nightTask
              ? nightPrompt(campaign, nightTask, registry.path, handoff)
              : resumePrompt(campaign, registry.path, handoff),
          },
        })
      // The user's tab is a planner with its own board; the night's stays a plain tab.
      terminalId = (nightTask ? create() : await createOrchestratedTerminal(projectId, cwd, create))
        .id
    }
  }
  focusTerminal(projectId, terminalId, !nightTask)
  return terminalId
}

/** Focuses a tab opened for `campaign`, by the same rule as Open; false when there is none. */
export function continueCampaign(projectId: string, campaign: Campaign): boolean {
  const terminalId = activateTab(projectId, (tab) => tab.campaignId === campaign.id)
  if (terminalId) focusTerminal(projectId, terminalId, true)
  return terminalId !== null
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

type TaskJob = Pick<OrchestratorJob, 'task' | 'status' | 'cwd'>

/**
 * The orchestrator jobs that name a registry task, from the same snapshot and event the board
 * reads. Only that projection is kept, so a worker streaming its reply does not re-render the tab.
 */
function useTaskJobs(): TaskJob[] {
  const [key, setKey] = useState('[]')
  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined
    const apply = (snapshot: OrchestratorSnapshot) => {
      if (cancelled) return
      const jobs = snapshot.jobs
        .filter((job) => job.task)
        .map(({ task, status, cwd }) => ({ task, status, cwd }))
      setKey(JSON.stringify(jobs))
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
    }
  }, [])
  return useMemo(() => JSON.parse(key) as TaskJob[], [key])
}

/** Live orchestrator workers per task of the registry's repository. */
export function useTaskWorkers(registry: Registry | null): ReadonlyMap<string, TaskWorkers> {
  const jobs = useTaskJobs()
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
/** The `resultado` of a task checked in the list: the user is its Gate 2. */
const CHECKED_RESULT = 'marcada no Alethe'

type Previous = { state: TaskState; result: string | null; evidence: string | null }
/** A check made here: the task as it was, and the evidence the check wrote, if any. */
type Check = { previous: Previous; evidence?: string }
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

  /** Writes `content` over `base`, the registry as read; false, with a toast, when refused. */
  const write = async (base: Base, content: string): Promise<boolean> => {
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
        task.result === CHECKED_RESULT ? previous.result : undefined,
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
    const previous = await setState(registry, taskId, DONE, CHECKED_RESULT, evidence)
    if (!previous) return
    undo.current.set(entry(path, taskId), { previous, evidence })
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
      if (result.ok) return write(registry, result.content)
      if (result.error === 'duplicate') {
        notify(t('todo.campaignWrite.duplicate', { campaign: campaign.id, id: result.id }))
      } else if (result.error === 'title') notify(t('todo.campaignWrite.badTitle'))
      else if (result.error === 'missing') notify(t('todo.campaignWrite.conflict'))
      else notify(t('todo.campaignWrite.invalid'))
      return false
    },

    /** Checks an open task done, with an undo; on a task checked here, undoes the check. */
    toggle: async (task: CampaignTask) => {
      const path = latest.current.registry?.path
      if (task.state !== DONE) await check(task.id)
      else if (path !== undefined) await restore(path, task.id)
    },

    /** The user's Gate 2 on a task the night left waiting: done with `evidence`, with an undo. */
    conclude: (taskId: string, evidence: string) => check(taskId, evidence),

    /** Puts a task back as ready, for the next night to retry it; only its state changes. */
    requeue: async (taskId: string) => {
      const registry = latest.current.registry
      if (registry && (await setState(registry, taskId, 'pronta', undefined))) {
        notify(t('todo.campaignWrite.requeued', { id: taskId }))
      }
    },
  }
}
