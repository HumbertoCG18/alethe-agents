/**
 * Campaign registry (`.workflow/campanhas.json` in the project's main checkout), read-only.
 *
 * Progress and situation mirror agent-workflow-lab/bin/campanhas.py; `campaigns.test.ts` checks
 * this module against that script's `listar --json` output. Field and state names stay in the
 * registry's own language (Portuguese), since they are the file format.
 */
import type { GitCheckout, GitCheckouts } from './tauri/git'

const DONE = 'concluída'
export const TASK_STATES = [
  'proposta',
  'pronta',
  'em execução',
  'bloqueada',
  'reservada',
  DONE,
] as const
export const CAMPAIGN_WINDOWS = ['assistida', 'noite', 'qualquer'] as const

export type TaskState = (typeof TASK_STATES)[number]
export type CampaignWindow = (typeof CAMPAIGN_WINDOWS)[number]

export type CampaignTask = {
  id: string
  title: string
  level: string
  state: TaskState
  /** Effective window: the task's own, else its campaign's. */
  window: CampaignWindow
  dependsOn: string[]
  /** Unmet prerequisites: the campaign's `depende_de`, then the task's own. */
  unmet: string[]
}

export type CampaignSituation = {
  kind: 'done' | 'waits' | 'running' | 'ready' | 'blocked'
  /** Ready tasks, counted for `running` and `ready`. */
  ready: number
  /** Unfinished prerequisites, for `waits`. */
  waits: string[]
}

export type Campaign = {
  id: string
  title: string
  priority: number
  window: CampaignWindow
  dependsOn: string[]
  /** Worktree folder names, matched against the basenames git lists. */
  worktrees: string[]
  handoff: string | null
  updatedOn: string | null
  /** `decomposta: false` means more tasks are still to be found: shown as `+?`, never done. */
  decomposed: boolean
  done: number
  total: number
  percent: number
  situation: CampaignSituation
  /** Has at least one task whose effective window is the night. */
  night: boolean
  tasks: CampaignTask[]
}

/** `id` names the entry (or its position when it has no id); `detail` is the offending value. */
export type RegistryError = {
  kind: 'malformed' | 'duplicate' | 'state' | 'window' | 'dependency' | 'cycle'
  id: string
  detail: string
}

/** With any error the registry is refused whole, as `campanhas.py listar` does: no campaigns. */
export type CampaignRegistry = { campaigns: Campaign[]; errors: RegistryError[] }

type Raw = Record<string, unknown>

const isRecord = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isId = (value: unknown): value is string => typeof value === 'string' && value !== ''
const isState = (value: unknown): value is TaskState => TASK_STATES.includes(value as TaskState)
const isWindow = (value: unknown): value is CampaignWindow =>
  CAMPAIGN_WINDOWS.includes(value as CampaignWindow)
const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const shown = (value: unknown): string => JSON.stringify(value) ?? 'null'

/** A list of ids; absent means empty, anything else that is not all strings is malformed. */
function ids(value: unknown): string[] | null {
  if (value === undefined || value === null) return []
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null
}

/**
 * Parses and validates the registry text with the checks of `campanhas.py validar` (window,
 * state, repeated id, unknown dependency, cycle) plus malformed entries. `null` means the text is
 * not a registry at all.
 */
export function parseCampaigns(source: string): CampaignRegistry | null {
  let data: unknown
  try {
    data = JSON.parse(source)
  } catch {
    return null
  }
  if (!isRecord(data) || !Array.isArray(data.campanhas)) return null

  const errors: RegistryError[] = []
  const fail = (kind: RegistryError['kind'], id: string, detail = '') => {
    errors.push({ kind, id, detail })
  }
  // Every campaign and task id with its `depende_de`, the graph campanhas.py validates.
  const graph = new Map<string, string[]>()
  const index = (id: string, dependsOn: string[]) => {
    if (graph.has(id)) fail('duplicate', id)
    graph.set(id, dependsOn)
  }
  const parsed: Array<Omit<Campaign, 'done' | 'total' | 'percent' | 'situation' | 'night'>> = []
  data.campanhas.forEach((raw: unknown, position: number) => {
    const dependsOn = isRecord(raw) ? ids(raw.depende_de) : null
    const worktrees = isRecord(raw) ? ids(raw.worktrees) : null
    if (
      !isRecord(raw) ||
      !isId(raw.id) ||
      typeof raw.prioridade !== 'number' ||
      !Array.isArray(raw.tarefas) ||
      !dependsOn ||
      !worktrees
    ) {
      fail('malformed', isRecord(raw) && isId(raw.id) ? raw.id : `campanhas[${position}]`)
      return
    }
    const campaignId = raw.id
    index(campaignId, dependsOn)
    const window = raw.janela
    if (!isWindow(window)) fail('window', campaignId, shown(window))
    const tasks: CampaignTask[] = []
    raw.tarefas.forEach((task: unknown, taskPosition: number) => {
      const taskDeps = isRecord(task) ? ids(task.depende_de) : null
      if (!isRecord(task) || !isId(task.id) || !taskDeps) {
        const named = isRecord(task) && isId(task.id)
        fail('malformed', named ? String(task.id) : `${campaignId}.tarefas[${taskPosition}]`)
        return
      }
      index(task.id, taskDeps)
      const own = task.janela ?? null
      if (!isState(task.estado)) fail('state', task.id, shown(task.estado))
      if (own !== null && !isWindow(own)) fail('window', task.id, shown(own))
      if (!isState(task.estado) || !isWindow(window) || (own !== null && !isWindow(own))) return
      tasks.push({
        id: task.id,
        title: text(task.titulo),
        level: text(task.nivel),
        state: task.estado,
        window: own ?? window,
        dependsOn: taskDeps,
        unmet: [],
      })
    })
    if (!isWindow(window)) return
    parsed.push({
      id: campaignId,
      title: text(raw.titulo),
      priority: raw.prioridade,
      window,
      dependsOn,
      worktrees,
      handoff: text(raw.handoff) || null,
      updatedOn: text(raw.atualizado_em) || null,
      decomposed: raw.decomposta !== false,
      tasks,
    })
  })
  for (const [id, dependsOn] of graph) {
    for (const dependency of dependsOn)
      if (!graph.has(dependency)) fail('dependency', id, dependency)
  }
  const visits = new Map<string, 'open' | 'closed'>()
  const visit = (node: string, trail: string[]) => {
    if (visits.get(node) === 'closed') return
    if (visits.get(node) === 'open') {
      fail('cycle', trail[0] ?? node, [...trail, node].join(' → '))
      return
    }
    visits.set(node, 'open')
    for (const dependency of graph.get(node) ?? []) {
      if (graph.has(dependency)) visit(dependency, [...trail, node])
    }
    visits.set(node, 'closed')
  }
  for (const node of graph.keys()) visit(node, [])
  if (errors.length > 0) return { campaigns: [], errors }
  parsed.sort((a, b) => a.priority - b.priority)

  const campaignsById = new Map(parsed.map((campaign) => [campaign.id, campaign]))
  const tasksById = new Map(parsed.flatMap((campaign) => campaign.tasks.map((t) => [t.id, t])))
  const campaignDone = (campaign: (typeof parsed)[number]) =>
    campaign.decomposed && campaign.tasks.every((task) => task.state === DONE)
  const finished = (id: string): boolean => {
    const campaign = campaignsById.get(id)
    return campaign ? campaignDone(campaign) : tasksById.get(id)?.state === DONE
  }

  const campaigns = parsed.map((campaign) => {
    const { tasks } = campaign
    const done = tasks.filter((task) => task.state === DONE).length
    for (const task of tasks) {
      task.unmet = [...campaign.dependsOn, ...task.dependsOn].filter((id) => !finished(id))
    }
    const ready = tasks.filter(
      (task) => task.state === 'pronta' && task.dependsOn.every(finished),
    ).length
    const waiting = campaign.dependsOn.filter((id) => !finished(id))
    const taskWaits = [
      ...new Set(
        tasks
          .filter((task) => task.state !== DONE)
          .flatMap((task) => task.dependsOn.filter((id) => !finished(id))),
      ),
    ].sort()
    let situation: CampaignSituation
    if (campaignDone(campaign)) situation = { kind: 'done', ready: 0, waits: [] }
    else if (waiting.length > 0) situation = { kind: 'waits', ready: 0, waits: waiting }
    else if (tasks.some((task) => task.state === 'em execução'))
      situation = { kind: 'running', ready, waits: [] }
    else if (ready > 0) situation = { kind: 'ready', ready, waits: [] }
    else if (taskWaits.length > 0) situation = { kind: 'waits', ready: 0, waits: taskWaits }
    else situation = { kind: 'blocked', ready: 0, waits: [] }
    return {
      ...campaign,
      done,
      total: tasks.length,
      percent: tasks.length > 0 ? Math.round((100 * done) / tasks.length) : 0,
      situation,
      night: tasks.some((task) => task.window === 'noite'),
    }
  })
  return { campaigns, errors: [] }
}

const basename = (path: string) =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() ?? ''

function checkoutNamed(name: string, checkouts: GitCheckout[]): GitCheckout | undefined {
  return checkouts.find((checkout) => basename(checkout.path) === name)
}

/**
 * Where to resume a campaign: its first listed worktree that git knows, else the main checkout.
 * The path always comes from `git worktree list`, never from the registry text.
 */
export function campaignCwd(campaign: Campaign, checkouts: GitCheckouts): string | null {
  for (const name of campaign.worktrees) {
    const checkout = checkoutNamed(name, checkouts.worktrees)
    if (checkout) return checkout.path
  }
  return checkouts.main
}

/** `atualizado_em` is a calendar date; read it as local midnight, like Python's fromisoformat. */
function localDate(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime() : null
}

/**
 * The most recently committed of the campaign's worktrees (`extra` more are listed) and its last
 * update: that commit or `atualizado_em`, whichever is later.
 */
export function campaignActivity(
  campaign: Campaign,
  checkouts: GitCheckouts,
): { worktree: string | null; extra: number; updatedAt: number | null; fromGit: boolean } {
  let latest: { name: string; ms: number } | null = null
  for (const name of campaign.worktrees) {
    const ms = checkoutNamed(name, checkouts.worktrees)?.lastCommitMs
    if (ms != null && (!latest || ms > latest.ms)) latest = { name, ms }
  }
  const declared = campaign.updatedOn ? localDate(campaign.updatedOn) : null
  const fromGit = latest !== null && (declared === null || latest.ms >= declared)
  return {
    worktree: latest?.name ?? campaign.worktrees[0] ?? null,
    extra: Math.max(0, campaign.worktrees.length - 1),
    updatedAt: fromGit && latest ? latest.ms : declared,
    fromGit,
  }
}

/** The registry file inside a main checkout, with the checkout's own separator. */
export function registryPath(main: string): string {
  const separator = main.includes('\\') ? '\\' : '/'
  return [main.replace(/[\\/]+$/, ''), '.workflow', 'campanhas.json'].join(separator)
}

/**
 * The prompt typed into the agent. It is agent-facing protocol text, in the registry's language.
 * The agent starts in a worktree, so the registry is named by its absolute path, and so is the
 * handoff when it was found (`handoffPath`); otherwise the handoff goes as written, relative to the
 * main checkout. Control characters are flattened so file text cannot submit early or end a
 * bracketed paste.
 */
export function resumePrompt(
  campaign: Campaign,
  registry: string,
  handoffPath: string | null,
): string {
  const title = campaign.title ? ` (${campaign.title})` : ''
  const handoff = campaign.handoff
    ? ` e pelo handoff ${handoffPath ?? `${campaign.handoff} (relativo ao checkout principal)`}`
    : ''
  return `Retome a campanha ${campaign.id}${title} pelo registro ${registry}${handoff}.`
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/ {2,}/g, ' ')
}
