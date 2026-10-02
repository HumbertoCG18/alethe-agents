/**
 * Campaign registry (`.workflow/campanhas.json` in the project's main checkout).
 *
 * Progress, situation and the edits (new task, state change) mirror
 * agent-workflow-lab/bin/campanhas.py; `campaigns.test.ts` checks this module against that
 * script's `listar --json` output. Field and state names stay in the registry's own language
 * (Portuguese), since they are the file format. The file itself is written by the
 * `campaign_registry_write` command, under the script's lock.
 */
import { normalizeCwd } from './platform'
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

/**
 * `<CAMPAIGN>-NN`, as campanhas.py `next_task_id`: the largest numeric suffix among the campaign's
 * task ids plus one, two digits at least, skipping any id `taken` anywhere in the registry.
 */
export function nextTaskId(
  campaignId: string,
  taskIds: readonly string[],
  taken: ReadonlySet<string>,
): string {
  const prefix = `${campaignId}-`
  const suffixes = taskIds
    .filter((id) => id.startsWith(prefix) && /^\d+$/.test(id.slice(prefix.length)))
    .map((id) => Number(id.slice(prefix.length)))
  const name = (n: number) => `${prefix}${String(n).padStart(2, '0')}`
  let n = Math.max(0, ...suffixes) + 1
  while (taken.has(name(n))) n += 1
  return name(n)
}

const CAMPAIGN_TITLE_MAX = 140

/**
 * campanhas.py `titulo_valido` on a trimmed title: 1 to 140 code points (not UTF-16 units), no
 * control character or line break.
 */
export const validCampaignTitle = (title: string) =>
  title.length > 0 &&
  [...title].length <= CAMPAIGN_TITLE_MAX &&
  !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(title)

/** The local calendar day, as Python's `date.today().isoformat()`. */
export function isoDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

type RawRegistry = { campanhas: Array<Raw & { id: string; tarefas: Raw[] }> }

/** The edited registry as campanhas.py writes it, or `invalid` when it would not validate. */
function edited<T extends object>(
  data: RawRegistry,
  done: T,
): ({ ok: true; content: string } & T) | { ok: false; error: 'invalid' } {
  const content = `${JSON.stringify(data, null, 2)}\n`
  const parsed = parseCampaigns(content)
  return parsed && parsed.errors.length === 0
    ? { ok: true, content, ...done }
    : { ok: false, error: 'invalid' }
}

export type AddTaskResult =
  | { ok: true; content: string; id: string }
  | { ok: false; error: 'title' | 'missing' | 'invalid' }
  | { ok: false; error: 'duplicate'; id: string }

/**
 * `campanhas.py tarefa`: appends a `proposta` task from `USER` with the next id to the campaign
 * and dates it `today`. `source` is the registry text as read; `content` is the text to write.
 */
export function addCampaignTask(
  source: string,
  campaignId: string,
  rawTitle: string,
  today: string,
): AddTaskResult {
  const title = rawTitle.trim()
  if (!validCampaignTitle(title)) return { ok: false, error: 'title' }
  const data = JSON.parse(source) as RawRegistry
  const campaign = data.campanhas.find((item) => item.id === campaignId)
  if (!campaign) return { ok: false, error: 'missing' }
  const same = campaign.tarefas.find(
    (task) => text(task.titulo).trim().toLowerCase() === title.toLowerCase(),
  )
  if (same) return { ok: false, error: 'duplicate', id: text(same.id) }
  const taken = new Set(
    data.campanhas.flatMap((item) => [item.id, ...item.tarefas.map((task) => text(task.id))]),
  )
  const id = nextTaskId(
    campaign.id,
    campaign.tarefas.map((task) => text(task.id)),
    taken,
  )
  campaign.tarefas.push({ id, titulo: title, estado: 'proposta', depende_de: [], origem: 'USER' })
  campaign.atualizado_em = today
  return edited(data, { id })
}

export type TaskStateResult =
  | { ok: true; content: string; previous: { state: TaskState; result: string | null } }
  | { ok: false; error: 'missing' | 'invalid' }

/**
 * `campanhas.py estado`: sets the task's state and `resultado` (removed when null) and dates its
 * campaign `today`. `previous` restores the task as it was.
 */
export function setCampaignTaskState(
  source: string,
  taskId: string,
  state: TaskState,
  result: string | null,
  today: string,
): TaskStateResult {
  const data = JSON.parse(source) as RawRegistry
  for (const campaign of data.campanhas) {
    const task = campaign.tarefas.find((item) => item.id === taskId)
    if (!task) continue
    const previous = {
      state: task.estado as TaskState,
      result: typeof task.resultado === 'string' ? task.resultado : null,
    }
    task.estado = state
    if (result === null) delete task.resultado
    else task.resultado = result
    campaign.atualizado_em = today
    return edited(data, { previous })
  }
  return { ok: false, error: 'missing' }
}

/** Order of the open states in the list: what is moving first, what waits on a decision last. */
const OPEN_ORDER: TaskState[] = ['em execução', 'pronta', 'reservada', 'proposta', 'bloqueada']

/** A campaign's tasks for a list tab: open ones by state then id, done ones by id after them. */
export function campaignTaskView(
  tasks: readonly CampaignTask[],
  filter: 'all' | 'active' | 'completed',
): CampaignTask[] {
  const rank = (task: CampaignTask) =>
    task.state === DONE ? OPEN_ORDER.length : OPEN_ORDER.indexOf(task.state)
  return tasks
    .filter((task) => filter === 'all' || (filter === 'completed') === (task.state === DONE))
    .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id, 'en', { numeric: true }))
}

const basename = (path: string) =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() ?? ''

/**
 * Whether a registry worktree entry names the checkout at `path`: the whole folder name, trailing
 * separators ignored, case-insensitive for Windows paths as the file system there is.
 */
function namesCheckout(name: string, path: string): boolean {
  const entry = name.replace(/[\\/]+$/, '')
  const folder = basename(path)
  return /^([a-z]:|\\\\)/i.test(path)
    ? entry.toLowerCase() === folder.toLowerCase()
    : entry === folder
}

function checkoutNamed(name: string, checkouts: GitCheckout[]): GitCheckout | undefined {
  return checkouts.find((checkout) => namesCheckout(name, checkout.path))
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

/** A terminal tab as the active-campaign rule sees it: its tag and its effective cwd. */
export type CampaignTab = { campaignId?: string; cwd: string }

/**
 * The campaign a tab works on: the one it was opened for, else one whose worktrees list the
 * checkout holding its cwd, resolved through git's list (so the main checkout counts only for
 * campaigns that list it). Among several, `prefer` wins when it is one of them.
 */
function tabCampaign(
  campaigns: Campaign[],
  checkouts: GitCheckouts,
  tab: CampaignTab,
  prefer: string | null,
): string | null {
  if (tab.campaignId && campaigns.some((campaign) => campaign.id === tab.campaignId)) {
    return tab.campaignId
  }
  const cwd = normalizeCwd(tab.cwd)
  // The deepest checkout holding the cwd: a worktree may sit inside the main checkout.
  let holder: { path: string; depth: number } | null = null
  for (const checkout of checkouts.worktrees) {
    const path = normalizeCwd(checkout.path)
    const holds = cwd === path || cwd.startsWith(`${path}\\`) || cwd.startsWith(`${path}/`)
    if (holds && (!holder || path.length > holder.depth)) {
      holder = { path: checkout.path, depth: path.length }
    }
  }
  if (!holder) return null
  const { path } = holder
  const matches = campaigns.filter((campaign) =>
    campaign.worktrees.some((name) => namesCheckout(name, path)),
  )
  return (matches.find((campaign) => campaign.id === prefer) ?? matches[0])?.id ?? null
}

/**
 * The campaign shown as active: the focused tab's, else the one last active in the project
 * (`remembered`), else none.
 */
export function activeCampaign(
  campaigns: Campaign[],
  checkouts: GitCheckouts,
  focused: CampaignTab | null,
  remembered: string | null,
): string | null {
  const fromTab = focused ? tabCampaign(campaigns, checkouts, focused, remembered) : null
  if (fromTab) return fromTab
  return campaigns.some((campaign) => campaign.id === remembered) ? remembered : null
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
