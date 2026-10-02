import { ChevronDown, Play } from 'lucide-react'
import { useState } from 'react'

import {
  type Campaign,
  campaignActivity,
  campaignCwd,
  type CampaignSituation,
  type CampaignWindow,
  type RegistryError,
  resumePrompt,
} from '../../lib/campaigns'
import { intlLocale, type MessageKey, type TFunction, useT } from '../../lib/i18n'
import { findRelativePath, type GitCheckouts } from '../../lib/tauri'
import { AGENT_TYPE_LABELS, type SubTab } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './CampaignsSection.module.css'
import { type CampaignView, type Registry, STATE_KEYS, TASK_LANES } from './campaignView'
import sidebarStyles from './TodoSidebar.module.css'

const AGENTS = ['claude', 'codex'] as const
type CampaignAgent = (typeof AGENTS)[number]

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

// Orchestration board lanes, so dots and chips read the same as the board's.
const SITUATION_LANES: Record<CampaignSituation['kind'], string> = {
  running: 'running',
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
 * Makes the first open terminal tab that `matches` the active one, looking in the focused
 * terminal first; returns its terminal id, or null when none matches.
 */
function activateTab(projectId: string, matches: (tab: SubTab) => boolean): string | null {
  const store = useProjectsStore.getState()
  const focused = useUiStore.getState().activeTerminal?.terminalId
  const terminals = [...(store.projects.find((item) => item.id === projectId)?.terminals ?? [])]
  terminals.sort((a, b) => Number(b.id === focused) - Number(a.id === focused))
  for (const terminal of terminals) {
    if ((terminal.kind ?? 'terminal') !== 'terminal' || terminal.disabled) continue
    const tab = terminal.tabs.find(matches)
    if (!tab) continue
    store.setActiveTab(projectId, terminal.id, tab.id)
    return terminal.id
  }
  return null
}

function focusTerminal(projectId: string, terminalId: string) {
  useProjectsStore.getState().focusWorkspaceTerminal(projectId, terminalId)
  const ui = useUiStore.getState()
  ui.setActiveTerminal(projectId, terminalId)
  ui.requestPaneFocus(terminalId)
}

/**
 * Focuses the `agent` tab opened for this campaign, or opens one with its resume prompt. A tab
 * opened by hand, or for another campaign, is never reused even in the same checkout: it would
 * not get this campaign's prompt.
 */
async function openCampaign(
  projectId: string,
  campaign: Campaign,
  agent: CampaignAgent,
  registry: Registry,
) {
  const cwd = campaignCwd(campaign, registry.checkouts)
  if (!cwd || !useProjectsStore.getState().projects.some((item) => item.id === projectId)) return
  const running = (tab: SubTab) => tab.type === agent && tab.campaignId === campaign.id
  let terminalId = activateTab(projectId, running)
  if (!terminalId) {
    // Handoff paths are relative to the main checkout; find_relative_path also looks in the
    // sibling worktree named by the first segment.
    const handoff = campaign.handoff
      ? await findRelativePath(registry.main, campaign.handoff).catch(() => null)
      : null
    // Checked again: the tab may have been opened while the handoff was looked up.
    terminalId =
      activateTab(projectId, running) ??
      useProjectsStore.getState().createTerminal(projectId, {
        name: campaign.id,
        cwd,
        firstTab: {
          type: agent,
          cwd,
          campaignId: campaign.id,
          initialInput: resumePrompt(campaign, registry.path, handoff),
        },
      }).id
  }
  focusTerminal(projectId, terminalId)
}

/** Focuses a tab opened for `campaign`, by the same rule as Open; false when there is none. */
function continueCampaign(projectId: string, campaign: Campaign): boolean {
  const terminalId = activateTab(projectId, (tab) => tab.campaignId === campaign.id)
  if (terminalId) focusTerminal(projectId, terminalId)
  return terminalId !== null
}

/** The campaigns map below the list; choosing a campaign makes it the list's source. */
export function CampaignsSection({
  view: { projectId, registry, activeId },
  onSelect,
}: {
  view: CampaignView
  onSelect: (campaignId: string) => void
}) {
  const t = useT()
  const [collapsed, setCollapsed] = useState(true)

  if (!registry || !projectId) return null
  // Stable sort: the active campaign first, the rest in priority order.
  const campaigns = [...registry.campaigns].sort(
    (a, b) => Number(b.id === activeId) - Number(a.id === activeId),
  )

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
          {campaigns.map((campaign) => (
            <CampaignRow
              key={campaign.id}
              campaign={campaign}
              checkouts={registry.checkouts}
              active={campaign.id === activeId}
              onSelect={() => onSelect(campaign.id)}
              onOpen={(agent) => void openCampaign(projectId, campaign, agent, registry)}
              onContinue={() => continueCampaign(projectId, campaign)}
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
  active,
  onSelect,
  onOpen,
  onContinue,
}: {
  campaign: Campaign
  checkouts: GitCheckouts
  active: boolean
  onSelect: () => void
  onOpen: (agent: CampaignAgent) => void
  /** Focuses the campaign's open tab; false when it has none. */
  onContinue: () => boolean
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
    <div
      className={styles.campaign}
      data-lane={SITUATION_LANES[campaign.situation.kind]}
      data-active={active ? 'true' : undefined}
      aria-current={active ? 'true' : undefined}
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
          <span className={styles.situation}>{situationLabel(t, campaign.situation)}</span>
        </span>
      </button>
      {/* The active row continues where its tab is, and offers the agents only when none is open. */}
      <button
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
