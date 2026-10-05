import { Fragment, type ReactNode } from 'react'

import {
  type CampaignTask,
  evidenceIsPath,
  type Finding,
  inCheckouts,
  type NightDiary,
} from '../../lib/campaigns'
import { type MessageKey, useT } from '../../lib/i18n'
import { LANE_OF, RUN_LANE_ORDER } from '../../lib/orchestratorRuns'
import { useProjectsStore } from '../../stores/projectsStore'
import styles from './CampaignsSection.module.css'
import type { Registry, TaskJob } from './campaignView'
import { nightDay, RESULT_KEYS, TYPE_KEYS, WINDOW_KEYS } from './labels'
import { openEvidence } from './taskActions'
import sidebarStyles from './TodoSidebar.module.css'

/** What a task's detail reads: the registry, and the jobs, diary and findings the tab loads. */
export type DetailSources = {
  registry: Registry
  jobs: readonly TaskJob[]
  diary: NightDiary | null
  findings: readonly Finding[]
}

/**
 * A campaign task's detail, read-only: its level and window, then its result, evidence, unmet
 * prerequisites, orchestration workers by the board's lanes, night entries and findings, each row
 * left out when empty. Agents write all of it, so it is shown as plain text.
 */
export function TaskDetail({
  id,
  task,
  sources,
}: {
  id: string
  task: CampaignTask
  sources: DetailSources
}) {
  const t = useT()
  const locale = useProjectsStore((state) => state.preferences.language)
  const { registry, jobs, diary, findings } = sources
  // The same repository filter as the live worker counts: another registry may reuse the ids.
  const own = jobs.filter((job) => job.task === task.id && inCheckouts(job.cwd, registry.checkouts))
  const job = (item: TaskJob) =>
    [
      item.agent,
      item.model,
      item.minutes === null ? null : t('todo.taskDetail.minutes', { count: item.minutes }),
    ]
      .filter(Boolean)
      .join(' ')
  const workers = RUN_LANE_ORDER.flatMap((lane) => {
    const listed = own.filter((item) => LANE_OF[item.status] === lane)
    return listed.length > 0
      ? [`${t(`orchestrator.lane.${lane}`)}: ${listed.map(job).join(', ')}`]
      : []
  })
  const night = diary
    ? diary.entries
        .filter((entry) => entry.task === task.id)
        .map((entry) =>
          [nightDay(diary.date, locale), t(RESULT_KEYS[entry.result]), entry.summary].join(' · '),
        )
    : []
  const found = findings
    .filter((finding) => finding.origin === task.id)
    .map((finding) => [finding.id, t(TYPE_KEYS[finding.type]), finding.title].join(' · '))
  const lines = (items: string[]) =>
    items.length > 0
      ? items.map((line, index) => (
          <span key={index} className={sidebarStyles.detailLine} data-line>
            {line}
          </span>
        ))
      : null
  const { evidence } = task
  const rows: Array<[MessageKey, ReactNode]> = [
    ['todo.taskDetail.result', task.result],
    [
      'todo.taskDetail.evidence',
      evidence ? (
        <>
          {evidence}
          {evidenceIsPath(evidence) ? (
            <button
              type="button"
              className={styles.evidence}
              aria-label={t('todo.night.openEvidence', { path: evidence })}
              title={t('todo.night.openEvidence', { path: evidence })}
              onClick={() => void openEvidence(registry, task.id, evidence, t)}
            >
              {t('todo.campaigns.open')}
            </button>
          ) : null}
        </>
      ) : null,
    ],
    ['todo.taskDetail.waiting', task.unmet.join(', ')],
    ['todo.taskDetail.workers', lines(workers)],
    ['todo.taskDetail.night', lines(night)],
    ['todo.taskDetail.findings', lines(found)],
  ]
  const shown = rows.filter(([, value]) => value)

  return (
    <div
      id={id}
      role="group"
      aria-label={t('todo.taskDetail.toggle', { id: task.id })}
      className={styles.details}
    >
      <span className={sidebarStyles.detailMeta}>
        {[task.level, t(WINDOW_KEYS[task.window])].filter(Boolean).join(' · ')}
      </span>
      {shown.length > 0 ? (
        <dl className={sidebarStyles.taskDetail}>
          {shown.map(([label, value]) => (
            <Fragment key={label}>
              <dt>{t(label)}</dt>
              <dd>{value}</dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
    </div>
  )
}
