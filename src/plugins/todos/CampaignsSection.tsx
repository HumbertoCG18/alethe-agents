import { Play } from 'lucide-react'
import { useMemo, useState } from 'react'

import {
  type Campaign,
  campaignActivity,
  type CampaignSituation,
  type CampaignWindow,
  campaignWorkers,
  type RegistryError,
  type TaskState,
  type TaskWorkers,
} from '../../lib/campaigns'
import { intlLocale, type MessageKey, type TFunction, useT } from '../../lib/i18n'
import { type GitCheckouts } from '../../lib/tauri'
import { AGENT_TYPE_LABELS, type Terminal } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import styles from './CampaignsSection.module.css'
import {
  AGENTS,
  type CampaignAgent,
  type CampaignLive,
  campaignLiveStatus,
  type CampaignView,
  continueCampaign,
  openCampaign,
  STATE_KEYS,
  TASK_LANES,
  workersLabel,
} from './campaignView'
import { useMenuFocus } from './menuFocus'
import { SectionToggle } from './SectionToggle'
import sidebarStyles from './TodoSidebar.module.css'

const WINDOW_KEYS: Record<CampaignWindow, MessageKey> = {
  assistida: 'todo.campaigns.windowAssisted',
  noite: 'todo.campaigns.windowNight',
  qualquer: 'todo.campaigns.windowAny',
}

const ERROR_KEYS: Record<RegistryError['kind'], MessageKey> = {
  malformed: 'todo.campaigns.errorMalformed',
  duplicate: 'todo.campaigns.errorDuplicate',
  state: 'todo.campaigns.errorState',
  window: 'todo.campaigns.errorWindow',
  dependency: 'todo.campaigns.errorDependency',
  cycle: 'todo.campaigns.errorCycle',
}

// Orchestration board lanes, so dots and chips read the same as the board's. They show only while
// nothing is live for the campaign, so a task left in progress reads as interrupted, not running.
const SITUATION_LANES: Record<CampaignSituation['kind'], string> = {
  running: 'interrupted',
  ready: 'queued',
  waits: 'interrupted',
  blocked: 'blocked',
  done: 'finished',
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

/**
 * In progress: one of its tasks is done or in progress, a tab is open for it, or a worker is live
 * on one of its tasks. Not started: anything else not finished. Finished: done, even when live.
 */
const GROUPS = ['inProgress', 'notStarted', 'finished'] as const
type Group = (typeof GROUPS)[number]

const GROUP_KEYS: Record<Group, MessageKey> = {
  inProgress: 'todo.campaigns.groupInProgress',
  notStarted: 'todo.campaigns.groupNotStarted',
  finished: 'todo.campaigns.groupFinished',
}

const STARTED: ReadonlySet<TaskState> = new Set(['concluída', 'em execução'])

const LIVE_KEYS: Record<CampaignLive, MessageKey> = {
  working: 'todo.campaigns.liveRunning',
  stopped: 'todo.campaigns.liveStopped',
}

// Stable fallbacks, so the selectors below return the same value while nothing changes.
const NO_WORKERS: ReadonlyMap<string, TaskWorkers> = new Map()
const NO_TERMINALS: Terminal[] = []

/** The campaigns map below the list; choosing a campaign makes it the list's source. */
export function CampaignsSection({
  view: { projectId, registry, activeId },
  workers = NO_WORKERS,
  onSelect,
}: {
  view: CampaignView
  /** Live orchestrator workers per task; the active campaign shows its own. */
  workers?: ReadonlyMap<string, TaskWorkers>
  onSelect: (campaignId: string) => void
}) {
  const t = useT()
  const [collapsed, setCollapsed] = useState(true)
  const [closed, setClosed] = useState<ReadonlySet<Group>>(() => new Set(['finished']))
  const terminals = useProjectsStore(
    (state) =>
      state.projects.find((project) => project.id === projectId)?.terminals ?? NO_TERMINALS,
  )
  // Read as a string, so output on a pty (recorded every 250 ms) does not re-render the map.
  const liveKey = useTerminalsStore((state) =>
    JSON.stringify([
      ...campaignLiveStatus(registry?.campaigns ?? [], terminals, state.byPtyId, workers),
    ]),
  )
  const live = useMemo(() => new Map<string, CampaignLive>(JSON.parse(liveKey)), [liveKey])

  if (!registry || !projectId) return null
  // Stable sort: the active campaign first in its group, the rest in priority order.
  const campaigns = [...registry.campaigns].sort(
    (a, b) => Number(b.id === activeId) - Number(a.id === activeId),
  )
  const groupOf = (campaign: Campaign): Group =>
    campaign.situation.kind === 'done'
      ? 'finished'
      : live.has(campaign.id) || campaign.tasks.some((task) => STARTED.has(task.state))
        ? 'inProgress'
        : 'notStarted'
  const toggleGroup = (group: Group) =>
    setClosed((current) => {
      const next = new Set(current)
      if (!next.delete(group)) next.add(group)
      return next
    })

  const row = (campaign: Campaign, status?: CampaignLive) => (
    <CampaignRow
      key={campaign.id}
      campaign={campaign}
      checkouts={registry.checkouts}
      active={campaign.id === activeId}
      live={status}
      workers={
        campaign.id === activeId
          ? workersLabel(
              t,
              campaignWorkers(
                campaign.tasks.map((task) => task.id),
                workers,
              ),
            )
          : null
      }
      onSelect={() => onSelect(campaign.id)}
      onOpen={(agent) => openCampaign(projectId, campaign, agent, registry)}
      onContinue={() => continueCampaign(projectId, campaign)}
    />
  )

  return (
    <section className={sidebarStyles.section}>
      <SectionToggle
        name={t('todo.campaigns.title')}
        count={registry.errors.length > 0 ? '!' : registry.campaigns.length}
        open={!collapsed}
        onToggle={() => setCollapsed((current) => !current)}
      />
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
        <div className={styles.groups}>
          {GROUPS.map((group) => {
            const members = campaigns.filter((campaign) => groupOf(campaign) === group)
            if (members.length === 0) return null
            const open = !closed.has(group)
            return (
              <div
                key={group}
                role="group"
                aria-label={t(GROUP_KEYS[group])}
                className={`${sidebarStyles.list} ${styles.group}`}
              >
                <SectionToggle
                  name={t(GROUP_KEYS[group])}
                  count={members.length}
                  open={open}
                  onToggle={() => toggleGroup(group)}
                  variant="sub"
                />
                {open ? members.map((campaign) => row(campaign, live.get(campaign.id))) : null}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function CampaignRow({
  campaign,
  checkouts,
  active,
  live,
  workers,
  onSelect,
  onOpen,
  onContinue,
}: {
  campaign: Campaign
  checkouts: GitCheckouts
  active: boolean
  /** Its live state, when a tab or worker is live for it; the dot then follows it. */
  live?: CampaignLive
  /** Its live workers, as "2 running · 1 queued"; null when none or not the active campaign. */
  workers: string | null
  onSelect: () => void
  onOpen: (agent: CampaignAgent) => unknown
  /** Focuses the campaign's open tab; false when it has none. */
  onContinue: () => boolean
}) {
  const t = useT()
  const locale = useProjectsStore((state) => state.preferences.language)
  const [expanded, setExpanded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const { trigger, onKeyDown, choose } = useMenuFocus(menuOpen, () => setMenuOpen(false))
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
    <div
      className={styles.campaign}
      data-lane={live ? undefined : SITUATION_LANES[campaign.situation.kind]}
      data-status={live}
      data-active={active ? 'true' : undefined}
      aria-current={active ? 'true' : undefined}
      onKeyDown={onKeyDown}
    >
      <span className={styles.dot} aria-hidden />
      <button
        type="button"
        className={styles.toggle}
        onClick={() => {
          setExpanded((current) => !current)
          onSelect()
        }}
        aria-expanded={expanded}
        title={campaign.title || campaign.id}
      >
        <span className={styles.line}>
          <span className={styles.id}>{campaign.id}</span>
          {campaign.title ? <span className={styles.title}>{campaign.title}</span> : null}
        </span>
        <span className={styles.meta}>
          <span>
            {`${campaign.done}/${campaign.total}${campaign.decomposed ? '' : '+?'} · ${campaign.percent}%`}
          </span>
          {live ? <span>{t(LIVE_KEYS[live])}</span> : null}
          <span className={styles.situation}>{situationLabel(t, campaign.situation)}</span>
          {workers ? <span className={styles.workers}>{workers}</span> : null}
        </span>
      </button>
      {/* The active row continues where its tab is, and offers the agents only when none is open. */}
      <button
        ref={trigger}
        type="button"
        className={styles.openButton}
        onClick={() => {
          if (!active || !onContinue()) setMenuOpen((current) => !current)
        }}
        aria-label={t(active ? 'todo.campaigns.continueLabel' : 'todo.campaigns.openLabel', {
          id: campaign.id,
        })}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
      >
        <Play size={11} />
        <span>{t(active ? 'todo.campaigns.continue' : 'todo.campaigns.open')}</span>
      </button>
      {menuOpen ? (
        <div className={styles.menu} role="menu">
          {AGENTS.map((agent) => (
            <button
              key={agent}
              type="button"
              role="menuitem"
              className={styles.menuItem}
              onClick={choose(() => onOpen(agent))}
            >
              {AGENT_TYPE_LABELS[agent]}
            </button>
          ))}
        </div>
      ) : null}
      {expanded ? (
        <div className={styles.details}>
          <span className={styles.meta}>
            <span>{t(WINDOW_KEYS[campaign.window])}</span>
            <span className={styles.worktree} title={worktree}>
              {worktree}
            </span>
            {updated ? <span>{t('todo.campaigns.updated', { when: updated })}</span> : null}
          </span>
          <ul className={styles.tasks}>
            {campaign.tasks.map((task) => (
              <li key={task.id} className={styles.task}>
                <span className={styles.chip} data-lane={TASK_LANES[task.state]}>
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
        </div>
      ) : null}
    </div>
  )
}
