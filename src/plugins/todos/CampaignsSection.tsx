import { ChevronDown, Play } from 'lucide-react'
import { useEffect, useState } from 'react'

import {
  type Campaign,
  campaignActivity,
  campaignCwd,
  type CampaignRegistry,
  type CampaignSituation,
  type CampaignWindow,
  parseCampaigns,
  type RegistryError,
  registryPath,
  resumePrompt,
  type TaskState,
} from '../../lib/campaigns'
import { intlLocale, type MessageKey, type TFunction, useT } from '../../lib/i18n'
import { normalizeCwd } from '../../lib/platform'
import {
  findRelativePath,
  type GitCheckouts,
  listenFileChanged,
  readTextFile,
  unwatchFile,
  watchFile,
  worktreeCheckouts,
} from '../../lib/tauri'
import { getProjectDefaultCwd } from '../../lib/terminalFactory'
import { AGENT_TYPE_LABELS } from '../../lib/types'
import { selectActiveProject, useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './CampaignsSection.module.css'
import sidebarStyles from './TodoSidebar.module.css'

const AGENTS = ['claude', 'codex'] as const
type CampaignAgent = (typeof AGENTS)[number]

const WINDOW_KEYS: Record<CampaignWindow, MessageKey> = {
  assistida: 'todo.campaigns.windowAssisted',
  noite: 'todo.campaigns.windowNight',
  qualquer: 'todo.campaigns.windowAny',
}

const STATE_KEYS: Record<TaskState, MessageKey> = {
  proposta: 'todo.campaigns.stateProposed',
  pronta: 'todo.campaigns.stateReady',
  'em execução': 'todo.campaigns.stateRunning',
  bloqueada: 'todo.campaigns.stateBlocked',
  reservada: 'todo.campaigns.stateReserved',
  concluída: 'todo.campaigns.stateDone',
}

const ERROR_KEYS: Record<RegistryError['kind'], MessageKey> = {
  malformed: 'todo.campaigns.errorMalformed',
  duplicate: 'todo.campaigns.errorDuplicate',
  state: 'todo.campaigns.errorState',
  window: 'todo.campaigns.errorWindow',
  dependency: 'todo.campaigns.errorDependency',
  cycle: 'todo.campaigns.errorCycle',
}

const STATE_CLASSES: Record<TaskState, string> = {
  proposta: styles.chipIdle,
  pronta: styles.chipReady,
  'em execução': styles.chipRunning,
  bloqueada: styles.chipBlocked,
  reservada: styles.chipIdle,
  concluída: styles.chipDone,
}

function situationLabel(t: TFunction, situation: CampaignSituation): string {
  switch (situation.kind) {
    case 'done':
      return t('todo.campaigns.done')
    case 'waits':
      return t('todo.campaigns.waits', { ids: situation.waits.join(', ') })
    case 'running':
      return t('todo.campaigns.running', { count: situation.ready })
    case 'ready':
      return t('todo.campaigns.ready', { count: situation.ready })
    case 'blocked':
      return t('todo.campaigns.blocked')
  }
}

type Registry = CampaignRegistry & {
  projectId: string
  /** Absolute path of `.workflow/campanhas.json` in the main checkout. */
  path: string
  main: string
  checkouts: GitCheckouts
}

/** Reads the registry in the main checkout of `projectPath` and re-reads it when the file changes. */
function useCampaignRegistry(projectId: string | null, projectPath: string): Registry | null {
  const [registry, setRegistry] = useState<Registry | null>(null)

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
      setRegistry(parsed ? { ...parsed, projectId, path, main, checkouts } : null)
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
  return registry?.projectId === projectId ? registry : null
}

/** The open terminal whose tab runs `agent` in `cwd`, made the active tab; null when none. */
function activateOpenTab(projectId: string, agent: CampaignAgent, cwd: string): string | null {
  const store = useProjectsStore.getState()
  const project = store.projects.find((item) => item.id === projectId)
  const target = normalizeCwd(cwd)
  for (const terminal of project?.terminals ?? []) {
    if ((terminal.kind ?? 'terminal') !== 'terminal' || terminal.disabled) continue
    const tab = terminal.tabs.find(
      (item) => item.type === agent && normalizeCwd(item.cwd || terminal.cwd) === target,
    )
    if (!tab) continue
    store.setActiveTab(projectId, terminal.id, tab.id)
    return terminal.id
  }
  return null
}

/** Focuses an open tab running `agent` in `cwd`, or opens one with the campaign's resume prompt. */
async function openCampaign(
  projectId: string,
  campaign: Campaign,
  agent: CampaignAgent,
  registry: Registry,
) {
  const cwd = campaignCwd(campaign, registry.checkouts)
  const store = useProjectsStore.getState()
  if (!cwd || !store.projects.some((item) => item.id === projectId)) return
  let terminalId = activateOpenTab(projectId, agent, cwd)
  if (!terminalId) {
    // Handoff paths are relative to the main checkout; find_relative_path also looks in the
    // sibling worktree named by the first segment.
    const handoff = campaign.handoff
      ? await findRelativePath(registry.main, campaign.handoff).catch(() => null)
      : null
    // Checked again: the tab may have been opened while the handoff was looked up.
    terminalId =
      activateOpenTab(projectId, agent, cwd) ??
      useProjectsStore.getState().createTerminal(projectId, {
        name: campaign.id,
        cwd,
        firstTab: {
          type: agent,
          cwd,
          initialInput: resumePrompt(campaign, registry.path, handoff),
        },
      }).id
  }
  store.focusWorkspaceTerminal(projectId, terminalId)
  const ui = useUiStore.getState()
  ui.setActiveTerminal(projectId, terminalId)
  ui.requestPaneFocus(terminalId)
}

export function CampaignsSection() {
  const t = useT()
  const projectId = useProjectsStore((state) => state.activeProjectId)
  const projectPath = useProjectsStore((state) =>
    getProjectDefaultCwd(selectActiveProject(state), state.projects),
  )
  const registry = useCampaignRegistry(projectId, projectPath)
  const [collapsed, setCollapsed] = useState(true)

  if (!registry || !projectId) return null

  return (
    <section className={sidebarStyles.section}>
      <div className={sidebarStyles.sectionHeader}>
        <button
          type="button"
          className={sidebarStyles.sectionToggle}
          onClick={() => setCollapsed((current) => !current)}
          aria-expanded={!collapsed}
        >
          <ChevronDown
            size={13}
            className={`${sidebarStyles.sectionChevron} ${collapsed ? sidebarStyles.sectionChevronClosed : ''}`}
          />
          <span className={sidebarStyles.sectionName}>{t('todo.campaigns.title')}</span>
          <span className={sidebarStyles.sectionCount}>
            {registry.errors.length > 0 ? '!' : registry.campaigns.length}
          </span>
          <span className={sidebarStyles.sectionRule} />
        </button>
      </div>
      {collapsed ? null : registry.errors.length > 0 ? (
        <div className={styles.invalid} role="alert">
          <p className={styles.invalidTitle}>{t('todo.campaigns.invalid')}</p>
          <ul className={styles.invalidList}>
            {registry.errors.map((error, index) => (
              <li key={index}>
                {t(ERROR_KEYS[error.kind], { id: error.id, detail: error.detail })}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className={sidebarStyles.list}>
          {registry.campaigns.map((campaign) => (
            <CampaignRow
              key={campaign.id}
              campaign={campaign}
              checkouts={registry.checkouts}
              onOpen={(agent) => void openCampaign(projectId, campaign, agent, registry)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function CampaignRow({
  campaign,
  checkouts,
  onOpen,
}: {
  campaign: Campaign
  checkouts: GitCheckouts
  onOpen: (agent: CampaignAgent) => void
}) {
  const t = useT()
  const locale = useProjectsStore((state) => state.preferences.language)
  const [expanded, setExpanded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const activity = campaignActivity(campaign, checkouts)
  const worktree = activity.worktree
    ? `${activity.worktree}${activity.extra > 0 ? ` (+${activity.extra})` : ''}`
    : '—'
  const updated =
    activity.updatedAt === null
      ? null
      : new Intl.DateTimeFormat(intlLocale(locale), {
          day: '2-digit',
          month: '2-digit',
          ...(activity.fromGit ? { hour: '2-digit', minute: '2-digit' } : {}),
        }).format(activity.updatedAt)

  return (
    <div className={styles.campaign}>
      <div className={styles.campaignHead}>
        <button
          type="button"
          className={styles.campaignToggle}
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          title={campaign.title}
        >
          <ChevronDown
            size={12}
            className={`${sidebarStyles.sectionChevron} ${expanded ? '' : sidebarStyles.sectionChevronClosed}`}
          />
          <span className={styles.campaignTitle}>{campaign.title || campaign.id}</span>
        </button>
        <button
          type="button"
          className={styles.openButton}
          onClick={() => setMenuOpen((current) => !current)}
          aria-label={t('todo.campaigns.openLabel', { id: campaign.id })}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
        >
          <Play size={11} />
          <span>{t('todo.campaigns.open')}</span>
        </button>
      </div>
      {menuOpen ? (
        <div className={styles.menu} role="menu">
          {AGENTS.map((agent) => (
            <button
              key={agent}
              type="button"
              role="menuitem"
              className={styles.menuItem}
              onClick={() => {
                setMenuOpen(false)
                onOpen(agent)
              }}
            >
              {AGENT_TYPE_LABELS[agent]}
            </button>
          ))}
        </div>
      ) : null}
      <div className={styles.meta}>
        <span className={styles.id}>{campaign.id}</span>
        <span>
          {`${campaign.done}/${campaign.total}${campaign.decomposed ? '' : '+?'} · ${campaign.percent}%`}
        </span>
        <span className={styles.situation}>{situationLabel(t, campaign.situation)}</span>
      </div>
      <div className={styles.meta}>
        <span>{t(WINDOW_KEYS[campaign.window])}</span>
        <span className={styles.worktree} title={worktree}>
          {worktree}
        </span>
        {updated ? <span>{t('todo.campaigns.updated', { when: updated })}</span> : null}
      </div>
      {expanded ? (
        <ul className={styles.tasks}>
          {campaign.tasks.map((task) => (
            <li key={task.id} className={styles.task}>
              <span className={`${styles.chip} ${STATE_CLASSES[task.state]}`}>
                {t(STATE_KEYS[task.state])}
              </span>
              <span className={styles.taskBody}>
                <span className={styles.taskTitle} title={task.title}>
                  <span className={styles.id}>{task.id}</span> {task.title}
                </span>
                <span className={styles.meta}>
                  {task.level ? <span>{task.level}</span> : null}
                  {task.window !== campaign.window ? (
                    <span>{t(WINDOW_KEYS[task.window])}</span>
                  ) : null}
                  {task.state !== 'concluída' && task.unmet.length > 0 ? (
                    <span className={styles.situation} data-unmet>
                      {t('todo.campaigns.waits', { ids: task.unmet.join(', ') })}
                    </span>
                  ) : null}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
