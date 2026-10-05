import { Play } from 'lucide-react'
import { useState } from 'react'

import {
  type Campaign,
  type CampaignSituation,
  campaignWorkers,
  type RegistryError,
  type TaskState,
  type TaskWorkers,
} from '../../lib/campaigns'
import { type MessageKey, useT } from '../../lib/i18n'
import { type GitCheckouts } from '../../lib/tauri'
import { AGENT_TYPE_LABELS } from '../../lib/types'
import styles from './CampaignsSection.module.css'
import {
  AGENTS,
  type CampaignAgent,
  type CampaignLive,
  type CampaignView,
  continueCampaign,
  openCampaign,
  STATE_KEYS,
  TASK_LANES,
  useCampaignFacts,
  useCampaignLive,
  workersLabel,
} from './campaignView'
import { situationLabel, WINDOW_KEYS } from './labels'
import { useMenuFocus } from './menuFocus'
import { SectionToggle } from './SectionToggle'
import sidebarStyles from './TodoSidebar.module.css'

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

/** Started: one of its tasks is done or in progress. Not started: none is. */
const GROUPS = ['started', 'notStarted'] as const
type Group = (typeof GROUPS)[number]

const GROUP_KEYS: Record<Group, MessageKey> = {
  started: 'todo.campaigns.groupStarted',
  notStarted: 'todo.campaigns.groupNotStarted',
}

const STARTED: ReadonlySet<TaskState> = new Set(['concluída', 'em execução'])

const LIVE_KEYS: Record<CampaignLive, MessageKey> = {
  working: 'todo.campaigns.liveRunning',
  stopped: 'todo.campaigns.liveStopped',
}

// Stable fallbacks, so the live status below is not recomputed while nothing changes.
const NO_WORKERS: ReadonlyMap<string, TaskWorkers> = new Map()
const NO_TASKS: ReadonlySet<string> = new Set()

/**
 * The campaigns map, collapsed at first: the campaigns neither live (those are Active) nor
 * finished. With `finished`, the Completed section instead: the finished ones, live or not.
 */
export function CampaignsSection({
  view: { projectId, registry, activeId },
  workers = NO_WORKERS,
  pending = NO_TASKS,
  finished = false,
}: {
  view: CampaignView
  /** Live orchestrator workers per task; the active campaign shows its own. */
  workers?: ReadonlyMap<string, TaskWorkers>
  /** The tasks Pending lists, left out of the rows' details. */
  pending?: ReadonlySet<string>
  finished?: boolean
}) {
  const t = useT()
  const [collapsed, setCollapsed] = useState(true)
  const [closed, setClosed] = useState<ReadonlySet<Group>>(() => new Set())
  const live = useCampaignLive(projectId, registry?.campaigns ?? [], workers)

  if (!registry || !projectId) return null
  const done = (campaign: Campaign) => campaign.situation.kind === 'done'
  // Stable sort: the active campaign first in its group, the rest in priority order.
  const campaigns = registry.campaigns
    .filter((campaign) => (finished ? done(campaign) : !done(campaign) && !live.has(campaign.id)))
    .sort((a, b) => Number(b.id === activeId) - Number(a.id === activeId))
  if (finished && campaigns.length === 0) return null
  const invalid = !finished && registry.errors.length > 0
  const groupOf = (campaign: Campaign): Group =>
    campaign.tasks.some((task) => STARTED.has(task.state)) ? 'started' : 'notStarted'
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
      pending={pending}
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
      onOpen={(agent) => openCampaign(projectId, campaign, agent, registry)}
      onContinue={() => continueCampaign(projectId, campaign)}
    />
  )

  return (
    <section className={sidebarStyles.section}>
      <SectionToggle
        name={t(finished ? 'todo.campaigns.completed' : 'todo.campaigns.title')}
        count={invalid ? '!' : campaigns.length}
        open={!collapsed}
        onToggle={() => setCollapsed((current) => !current)}
      />
      {collapsed ? null : invalid ? (
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
      ) : finished ? (
        <div className={sidebarStyles.list}>
          {campaigns.map((campaign) => row(campaign, live.get(campaign.id)))}
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
  pending,
  active,
  live,
  workers,
  onOpen,
  onContinue,
}: {
  campaign: Campaign
  checkouts: GitCheckouts
  pending: ReadonlySet<string>
  active: boolean
  /** Its live state, when a tab or worker is live for it; the dot then follows it. */
  live?: CampaignLive
  /** Its live workers, as "2 running · 1 queued"; null when none or not the active campaign. */
  workers: string | null
  onOpen: (agent: CampaignAgent) => unknown
  /** Focuses the campaign's open tab; false when it has none. */
  onContinue: () => boolean
}) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const { trigger, onKeyDown, choose } = useMenuFocus(menuOpen, () => setMenuOpen(false))
  const inPending = campaign.tasks.filter((task) => pending.has(task.id)).length

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
        onClick={() => setExpanded((current) => !current)}
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
          <CampaignFacts campaign={campaign} checkouts={checkouts} />
          <ul className={styles.tasks}>
            {campaign.tasks
              .filter((task) => !pending.has(task.id))
              .map((task) => (
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
          {inPending > 0 ? (
            <span className={styles.meta}>
              {t('todo.campaigns.inPending', { count: inPending })}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** A campaign's window, worktree and last update, as its row's details show them. */
function CampaignFacts({ campaign, checkouts }: { campaign: Campaign; checkouts: GitCheckouts }) {
  const facts = useCampaignFacts(campaign, checkouts)
  return (
    <span className={styles.meta}>
      <span>{facts.window}</span>
      <span className={styles.worktree} title={facts.worktree}>
        {facts.worktree}
      </span>
      {facts.updated ? <span>{facts.updated}</span> : null}
    </span>
  )
}
