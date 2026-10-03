/**
 * The campaign registry as the Todo tab uses it: read and watched once, shared by the list and the
 * Campaigns map, and edited from the list through the registry write command.
 */
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'

import {
  activeCampaign,
  addCampaignTask,
  type Campaign,
  type CampaignRegistry,
  type CampaignTab,
  type CampaignTask,
  isoDay,
  liveTaskWorkers,
  parseCampaigns,
  registryPath,
  setCampaignTaskState,
  type TaskState,
  type TaskWorkers,
} from '../../lib/campaigns'
import { type MessageKey, type TFunction, useT } from '../../lib/i18n'
import {
  campaignRegistryWrite,
  type GitCheckouts,
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
import { selectActiveProject, useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { useTodosStore } from './store'

export const STATE_KEYS: Record<TaskState, MessageKey> = {
  proposta: 'todo.campaigns.stateProposed',
  pronta: 'todo.campaigns.stateReady',
  'em execução': 'todo.campaigns.stateRunning',
  bloqueada: 'todo.campaigns.stateBlocked',
  reservada: 'todo.campaigns.stateReserved',
  concluída: 'todo.campaigns.stateDone',
}

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
 * `reload` re-reads it now, after a write.
 */
export function useCampaignRegistry(
  projectId: string | null,
  projectPath: string,
): { registry: Registry | null; reload: () => Promise<void> } {
  const [registry, setRegistry] = useState<Registry | null>(null)
  const reloadRef = useRef<() => Promise<void>>(async () => {})

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
}

/** The active project's registry and active campaign, shared by the Todo list and the map. */
export function useCampaignView(): CampaignView {
  const projectId = useProjectsStore((state) => state.activeProjectId)
  const projectPath = useProjectsStore((state) =>
    getProjectDefaultCwd(selectActiveProject(state), state.projects),
  )
  const { registry, reload } = useCampaignRegistry(projectId, projectPath)
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

  return { projectId, registry, activeId, reload }
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

type Previous = { state: TaskState; result: string | null }
/** The registry an edit starts from: where it is, and its text as read. */
type Base = Pick<Registry, 'path' | 'text'>

export type CampaignEdits = ReturnType<typeof useCampaignEdits>

/**
 * Edits of the registry from the list. Each starts from the registry as last read, so a change
 * the script made meanwhile is refused as a conflict; the list reloads after every attempt.
 */
export function useCampaignEdits(view: CampaignView) {
  const t = useT()
  const pushToast = useUiStore((state) => state.pushToast)
  const latest = useRef(view)
  latest.current = view
  const busy = useRef(false)
  // State before each check made here, by registry path and task id: what undo puts back.
  const undo = useRef(new Map<string, Previous>())
  const [, rerender] = useReducer((count: number) => count + 1, 0)

  const notify = (body: string, actions?: { label: string; run: () => void }[]) =>
    pushToast({ title: t('todo.campaignWrite.title'), body, actions })

  /** Writes `content` over `base`, the registry as read; false, with a toast, when refused. */
  const write = async (base: Base, content: string): Promise<boolean> => {
    if (busy.current) return false
    busy.current = true
    rerender()
    try {
      await campaignRegistryWrite(base.path, base.text, content)
      return true
    } catch (error) {
      notify(
        error === 'conflict'
          ? t('todo.campaignWrite.conflict')
          : t('todo.campaignWrite.failed', { message: String(error) }),
      )
      return false
    } finally {
      await latest.current.reload()
      busy.current = false
      rerender()
    }
  }

  /** Changes a task's state in `base`; returns the state it had, or null when nothing was written. */
  const setState = async (base: Base, taskId: string, state: TaskState, result: string | null) => {
    const edit = setCampaignTaskState(base.text, taskId, state, result, isoDay(new Date()))
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

  /** Puts back the state a task of `path` had before it was checked here, while it is still done. */
  const restore = async (path: string, taskId: string) => {
    const previous = undo.current.get(entry(path, taskId))
    if (!previous) return
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
      !(await setState({ path, text }, taskId, previous.state, previous.result))
    ) {
      return
    }
    undo.current.delete(entry(path, taskId))
    rerender()
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
      const registry = latest.current.registry
      if (!registry) return
      const { path } = registry
      if (task.state === DONE) {
        await restore(path, task.id)
        return
      }
      const previous = await setState(registry, task.id, DONE, CHECKED_RESULT)
      if (!previous) return
      undo.current.set(entry(path, task.id), previous)
      rerender()
      notify(t('todo.campaignWrite.done', { id: task.id }), [
        { label: t('todo.campaignWrite.undo'), run: () => void restore(path, task.id) },
      ])
    },
  }
}
