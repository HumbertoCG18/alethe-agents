import { type RefObject, useEffect, useRef, useState } from 'react'

import { isMarkdownFilePath } from '../../components/XTermView/terminalLinks'
import {
  type Campaign,
  campaignCwd,
  evidenceIsPath,
  inCheckouts,
  NIGHT_RESULTS,
  type NightDiary,
  nightDiaryFiles,
  type NightEntry,
  type NightResult,
  parseNightDiary,
  workflowPath,
} from '../../lib/campaigns'
import { intlLocale, type MessageKey, useT } from '../../lib/i18n'
import { nightDate, type StopReason } from '../../lib/nightScheduler'
import {
  findRelativePath,
  type GitCheckouts,
  listDirectory,
  listenFileChanged,
  readTextFile,
} from '../../lib/tauri'
import { AGENT_TYPE_LABELS } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './CampaignsSection.module.css'
import {
  AGENTS,
  type CampaignEdits,
  continueCampaign,
  openCampaign,
  type Registry,
} from './campaignView'
import { useMenuFocus } from './menuFocus'
import { SectionToggle } from './SectionToggle'
import { useTodosStore } from './store'
import sidebarStyles from './TodoSidebar.module.css'
import { createWatchSet } from './watchSet'

const COUNT_KEYS: Record<NightResult, MessageKey> = {
  ok: 'todo.night.countOk',
  'aguarda-voce': 'todo.night.countWaiting',
  falhou: 'todo.night.countFailed',
  parou: 'todo.night.countStopped',
}

const RESULT_KEYS: Record<NightResult, MessageKey> = {
  ok: 'todo.night.resultOk',
  'aguarda-voce': 'todo.night.resultWaiting',
  falhou: 'todo.night.resultFailed',
  parou: 'todo.night.resultStopped',
}

// Orchestration board lanes, so a result dot reads as the board's.
const RESULT_LANES: Record<NightResult, string> = {
  ok: 'finished',
  'aguarda-voce': 'queued',
  falhou: 'failed',
  parou: 'interrupted',
}

/**
 * The latest readable diary in `<main>/.workflow/local/noites`. Once the folder exists it is
 * watched (watch_file on a folder reports the files written in it), and so is every diary in it,
 * so an edit that fixes a malformed newest one is seen. Coming back to the window re-reads it too,
 * for the folder's creation.
 */
function useNightDiary(main: string | null): NightDiary | null {
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
 * The file evidence names: as given when absolute, else where find_relative_path finds it from
 * `base` (the task's campaign checkout, else the main one) or in another worktree, else relative to
 * `base` (a missing file still opens, so its pane says so). The diary is written by agents, so a
 * path outside the repository's checkouts is never a link.
 */
async function evidenceTarget(
  base: string,
  evidence: string,
  checkouts: GitCheckouts,
): Promise<string | null> {
  if (!evidenceIsPath(evidence)) return null
  const absolute = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(evidence)
  const separator = base.includes('\\') ? '\\' : '/'
  const target = absolute
    ? evidence
    : ((await findRelativePath(base, evidence).catch(() => null)) ??
      `${base.replace(/[\\/]+$/, '')}${separator}${evidence.replace(/[\\/]/g, separator)}`)
  return inCheckouts(target, checkouts) ? target : null
}

function openFile(projectId: string, filePath: string) {
  const store = useProjectsStore.getState()
  const pane = store.createFilePane(projectId, { filePath })
  store.openPane(projectId, pane.id)
  useUiStore.getState().requestPaneFocus(pane.id)
}

/** As the terminal's link menu opens a file: Markdown in the viewer, anything else in a pane. */
function openEvidence(projectId: string, filePath: string) {
  if (isMarkdownFilePath(filePath)) useUiStore.getState().openLinkViewer(filePath)
  else openFile(projectId, filePath)
}

const taskCampaign = (campaigns: readonly Campaign[], taskId: string) =>
  campaigns.find((campaign) => campaign.tasks.some((task) => task.id === taskId))

const STOP_KEYS: Record<StopReason, MessageKey> = {
  window: 'todo.nightMode.stopWindow',
  none: 'todo.nightMode.stopNone',
  max: 'todo.nightMode.stopMax',
  failures: 'todo.nightMode.stopFailures',
  quota: 'todo.nightMode.stopQuota',
  diary: 'todo.nightMode.stopDiary',
}

const hoursMinutes = (ms: number) => {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  return [Math.floor(minutes / 60), minutes % 60]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
}

/**
 * The night scheduler in this project: the task running and for how long, or why tonight's night
 * ended, shown until noon when the night's date changes. Hidden otherwise.
 */
export function NightStatus({ projectId }: { projectId: string | null }) {
  const t = useT()
  const current = useTodosStore((state) => state.nightRun.current)
  const night = useTodosStore((state) => (projectId ? state.nightRun.nights[projectId] : undefined))
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [current, night])

  if (!projectId) return null
  let text: string | null = null
  if (current?.projectId === projectId) {
    const running = t('todo.nightMode.running', {
      task: current.taskId,
      elapsed: hoursMinutes(now - current.startedAt),
    })
    // The night goes on when Claude's usage cannot be read; the line says it was not checked.
    text = current.quotaUnread ? `${running} · ${t('todo.nightMode.quotaUnread')}` : running
  } else if (night?.stopped && night.night === nightDate(new Date(now))) {
    text = t('todo.nightMode.ended', { reason: t(STOP_KEYS[night.stopped]) })
  }
  return text ? (
    <p className={styles.nightStatus} role="status">
      {text}
    </p>
  ) : null
}

/**
 * What the night agent did, from its latest diary, hidden when there is none. An entry waiting on
 * the user opens its actions; only the user's choice there changes the registry.
 */
export function NightCard({
  registry,
  edits,
}: {
  registry: Registry | null
  edits: CampaignEdits
}) {
  const t = useT()
  const locale = useProjectsStore((state) => state.preferences.language)
  const main = registry?.main ?? null
  const checkouts = registry?.checkouts ?? null
  const campaigns = registry?.campaigns ?? null
  const diary = useNightDiary(main)
  const [open, setOpen] = useState(false)
  const toggle = useRef<HTMLButtonElement>(null)
  const [links, setLinks] = useState<{ diary: NightDiary; targets: (string | null)[] } | null>(null)

  useEffect(() => {
    if (!diary || !main || !checkouts || !campaigns) return
    let cancelled = false
    void Promise.all(
      diary.entries.map(({ task, evidence }) => {
        const campaign = taskCampaign(campaigns, task)
        const base = (campaign && campaignCwd(campaign, checkouts)) ?? main
        return evidenceTarget(base, evidence, checkouts)
      }),
    ).then((targets) => {
      if (!cancelled) setLinks({ diary, targets })
    })
    return () => {
      cancelled = true
    }
  }, [diary, main, checkouts, campaigns])

  if (!diary || !registry) return null
  const targets = links?.diary === diary ? links.targets : null

  const [year, month, day] = diary.date.split('-').map(Number)
  const date = new Intl.DateTimeFormat(intlLocale(locale), {
    day: '2-digit',
    month: '2-digit',
  }).format(new Date(year, month - 1, day))

  return (
    <section className={`${sidebarStyles.section} ${styles.card}`}>
      <SectionToggle
        name={t('todo.night.title', { date })}
        count={diary.entries.length}
        open={open}
        onToggle={() => setOpen((current) => !current)}
        toggleRef={toggle}
        extra={
          <span className={styles.meta}>
            {NIGHT_RESULTS.map((result) => {
              const count = diary.entries.filter((entry) => entry.result === result).length
              return count > 0 ? <span key={result}>{t(COUNT_KEYS[result], { count })}</span> : null
            })}
          </span>
        }
      />
      {open ? (
        <ul className={styles.tasks}>
          {diary.entries.map((entry, index) => (
            <NightEntryRow
              key={`${entry.task}-${index}`}
              entry={entry}
              target={targets?.[index] ?? null}
              registry={registry}
              edits={edits}
              cardToggle={toggle}
            />
          ))}
        </ul>
      ) : null}
    </section>
  )
}

function NightEntryRow({
  entry,
  target,
  registry,
  edits,
  cardToggle,
}: {
  entry: NightEntry
  /** The file its evidence names, when it names one inside the checkouts. */
  target: string | null
  registry: Registry
  edits: CampaignEdits
  /** The card's toggle, where the focus goes when an action took this entry's actions away. */
  cardToggle: RefObject<HTMLButtonElement>
}) {
  const t = useT()
  const [menu, setMenu] = useState<'actions' | 'agents' | null>(null)
  const { projectId } = registry
  // An entry waiting on the user has actions while the registry has its task.
  const campaign =
    entry.result === 'aguarda-voce' ? taskCampaign(registry.campaigns, entry.task) : undefined
  const state = campaign?.tasks.find((task) => task.id === entry.task)?.state
  const undecided = state !== undefined && state !== 'concluída'
  const { trigger, refocus, onKeyDown, choose } = useMenuFocus(
    menu !== null,
    () => setMenu(null),
    () => cardToggle.current,
  )
  const item = (key: string, label: string, onClick: () => void, disabled = false) => (
    <button
      key={key}
      type="button"
      role="menuitem"
      className={styles.menuItem}
      onClick={onClick}
      disabled={disabled}
    >
      {label}
    </button>
  )

  return (
    <li
      className={styles.nightEntry}
      data-lane={RESULT_LANES[entry.result]}
      title={[entry.time, t(RESULT_KEYS[entry.result])].filter(Boolean).join(' · ')}
      onKeyDown={onKeyDown}
    >
      <span className={styles.dot} role="img" aria-label={t(RESULT_KEYS[entry.result])} />
      {campaign ? (
        <button
          ref={trigger}
          type="button"
          className={styles.nightToggle}
          onClick={() => setMenu((current) => (current ? null : 'actions'))}
          aria-expanded={menu !== null}
          aria-haspopup="menu"
        >
          <span className={styles.id}>{entry.task}</span>{' '}
          <span className={styles.taskTitle}>{entry.summary}</span>
        </button>
      ) : (
        <>
          <span className={styles.id}>{entry.task}</span>
          <span className={styles.taskTitle}>{entry.summary}</span>
        </>
      )}
      {target ? (
        <button
          type="button"
          className={styles.evidence}
          title={t('todo.night.openEvidence', { path: entry.evidence })}
          onClick={() => openFile(projectId, target)}
        >
          {entry.evidence}
        </button>
      ) : entry.evidence ? (
        <span className={styles.evidence} title={entry.evidence}>
          {entry.evidence}
        </span>
      ) : null}
      {campaign && menu ? (
        <div
          className={styles.menu}
          role="menu"
          aria-label={t('todo.night.actions', { id: entry.task })}
        >
          {menu === 'agents'
            ? AGENTS.map((agent) =>
                item(
                  agent,
                  AGENT_TYPE_LABELS[agent],
                  choose(() => openCampaign(projectId, campaign, agent, registry)),
                ),
              )
            : [
                undecided
                  ? item(
                      'conclude',
                      t('todo.night.conclude'),
                      choose(() => edits.conclude(entry.task, entry.evidence || entry.summary)),
                      edits.busy,
                    )
                  : null,
                target
                  ? item(
                      'evidence',
                      t('todo.night.openEvidenceItem'),
                      choose(() => openEvidence(projectId, target)),
                    )
                  : null,
                item('continue', t('todo.night.continue'), () => {
                  setMenu(continueCampaign(projectId, campaign) ? null : 'agents')
                  refocus()
                }),
                undecided && state !== 'pronta'
                  ? item(
                      'requeue',
                      t('todo.night.requeue'),
                      choose(() => edits.requeue(entry.task)),
                      edits.busy,
                    )
                  : null,
              ]}
        </div>
      ) : null}
    </li>
  )
}
