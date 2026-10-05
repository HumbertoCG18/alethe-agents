import { useEffect, useRef, useState } from 'react'

import {
  evidenceIsPath,
  NIGHT_RESULTS,
  type NightDiary,
  type NightEntry,
  type NightResult,
} from '../../lib/campaigns'
import { type MessageKey, useT } from '../../lib/i18n'
import { nightDate, type StopReason } from '../../lib/nightScheduler'
import { useProjectsStore } from '../../stores/projectsStore'
import styles from './CampaignsSection.module.css'
import {
  type CampaignEdits,
  nightUndecided,
  type Registry,
  STATE_KEYS,
  TASK_LANES,
} from './campaignView'
import { nightDay, RESULT_KEYS } from './labels'
import { SectionToggle } from './SectionToggle'
import { useTodosStore } from './store'
import { openEvidence, taskCampaign, useTaskActions } from './taskActions'
import sidebarStyles from './TodoSidebar.module.css'

const COUNT_KEYS: Record<NightResult, MessageKey> = {
  ok: 'todo.night.countOk',
  'aguarda-voce': 'todo.night.countWaiting',
  falhou: 'todo.night.countFailed',
  parou: 'todo.night.countStopped',
}

// Orchestration board lanes, so a result dot reads as the board's.
const RESULT_LANES: Record<NightResult, string> = {
  ok: 'finished',
  'aguarda-voce': 'queued',
  falhou: 'failed',
  parou: 'interrupted',
}

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
 * What the night agent did, from its latest diary. An entry waiting on the user opens its actions;
 * only the user's choice there changes the registry.
 */
export function NightCard({
  registry,
  diary,
  edits,
}: {
  registry: Registry
  diary: NightDiary
  edits: CampaignEdits
}) {
  const t = useT()
  const locale = useProjectsStore((state) => state.preferences.language)
  const { campaigns } = registry
  const [open, setOpen] = useState(false)
  const toggle = useRef<HTMLButtonElement>(null)

  return (
    <section className={`${sidebarStyles.section} ${styles.card}`}>
      <SectionToggle
        name={t('todo.night.title', { date: nightDay(diary.date, locale) })}
        count={diary.entries.length}
        open={open}
        onToggle={() => setOpen((current) => !current)}
        toggleRef={toggle}
        extra={
          <span className={styles.meta}>
            {NIGHT_RESULTS.map((result) => {
              // Waiting on you counts only the entries still undecided, as Pending does.
              const count = diary.entries.filter((entry) =>
                result === 'aguarda-voce'
                  ? nightUndecided(entry, campaigns)
                  : entry.result === result,
              ).length
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
              registry={registry}
              edits={edits}
              fallback={() => toggle.current}
            />
          ))}
        </ul>
      ) : null}
    </section>
  )
}

/** A night entry; Pending shows one with `night`, the date of its night. */
export function NightEntryRow({
  entry,
  registry,
  edits,
  night,
  fallback,
}: {
  entry: NightEntry
  registry: Registry
  edits: CampaignEdits
  night?: string
  /** Where the focus goes when an action took this entry's actions away. */
  fallback: () => HTMLElement | null
}) {
  const t = useT()
  // An entry waiting on the user has actions while the registry has its task.
  const campaign =
    entry.result === 'aguarda-voce' ? taskCampaign(registry.campaigns, entry.task) : undefined
  const state = campaign?.tasks.find((task) => task.id === entry.task)?.state
  const undecided = state !== undefined && state !== 'concluída'
  const { onKeyDown, toggle, menu } = useTaskActions({
    taskId: entry.task,
    campaign,
    registry,
    edits,
    // Without evidence, its summary stands for it.
    conclude: undecided ? () => edits.conclude(entry.task, entry.evidence || entry.summary) : null,
    evidence: entry.evidence,
    requeue: undecided && state !== 'pronta',
    fallback,
  })
  const label = night ? <span className={styles.chip}>{night}</span> : null
  // Once decided, an entry that waited on you reads as its task does now; one whose task left the
  // registry reads as stopped, the night's neutral end.
  const decided = entry.result === 'aguarda-voce' && !nightUndecided(entry, registry.campaigns)
  const reading = !decided
    ? { lane: RESULT_LANES[entry.result], name: t(RESULT_KEYS[entry.result]) }
    : state
      ? { lane: TASK_LANES[state], name: t(STATE_KEYS[state]) }
      : { lane: RESULT_LANES.parou, name: t(RESULT_KEYS.parou) }

  return (
    <li
      className={styles.nightEntry}
      data-lane={reading.lane}
      title={[entry.time, reading.name].filter(Boolean).join(' · ')}
      onKeyDown={onKeyDown}
    >
      <span className={styles.dot} role="img" aria-label={reading.name} />
      {campaign ? (
        <button type="button" className={styles.nightToggle} {...toggle}>
          <span className={styles.id}>{entry.task}</span>{' '}
          <span className={styles.taskTitle}>{entry.summary}</span>
          {label}
        </button>
      ) : (
        <>
          <span className={styles.id}>{entry.task}</span>
          <span className={styles.taskTitle}>{entry.summary}</span>
          {label}
        </>
      )}
      {evidenceIsPath(entry.evidence) ? (
        <button
          type="button"
          className={styles.evidence}
          title={t('todo.night.openEvidence', { path: entry.evidence })}
          onClick={() => void openEvidence(registry, entry.task, entry.evidence, t)}
        >
          {entry.evidence}
        </button>
      ) : entry.evidence ? (
        <span className={styles.evidence} title={entry.evidence}>
          {entry.evidence}
        </span>
      ) : null}
      {menu}
    </li>
  )
}
