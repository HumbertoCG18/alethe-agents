import { useState } from 'react'

import { type Finding, type FindingType } from '../../lib/campaigns'
import { intlLocale, useT } from '../../lib/i18n'
import { useProjectsStore } from '../../stores/projectsStore'
import styles from './CampaignsSection.module.css'
import { TYPE_KEYS } from './labels'
import { SectionToggle } from './SectionToggle'
import sidebarStyles from './TodoSidebar.module.css'

// Agents write the file: more rows than this are only counted.
const MAX_ROWS = 200

// Dots reuse the night card's lane colours: failed, waiting, working, stopped.
const TYPE_LANES: Record<FindingType, string> = {
  bug: 'failed',
  risco: 'queued',
  ideia: 'running',
  divida: 'finished',
}

/**
 * What agents noticed outside their task; read-only, collapsed, hidden when there is nothing new.
 * The file is written by agents, so everything is shown as text and the detail only as a tooltip.
 */
export function FindingsCard({ findings }: { findings: Finding[] }) {
  const t = useT()
  const locale = useProjectsStore((state) => state.preferences.language)
  const [open, setOpen] = useState(false)

  if (findings.length === 0) return null

  const format = new Intl.DateTimeFormat(intlLocale(locale), { day: '2-digit', month: '2-digit' })
  const dateOf = (iso: string) => {
    const [year, month, day] = iso.split('-').map(Number)
    return format.format(new Date(year, month - 1, day))
  }

  return (
    <section className={`${sidebarStyles.section} ${styles.card}`}>
      <SectionToggle
        name={t('todo.findings.title')}
        count={findings.length}
        open={open}
        onToggle={() => setOpen((current) => !current)}
      />
      {open ? (
        <ul className={styles.tasks}>
          {findings.slice(0, MAX_ROWS).map((finding) => (
            <li
              key={finding.id}
              className={`${styles.nightEntry} ${styles.finding}`}
              data-finding={finding.id}
              data-lane={TYPE_LANES[finding.type]}
              title={finding.detail || undefined}
            >
              <span className={styles.dot} role="img" aria-label={t(TYPE_KEYS[finding.type])} />
              <span className={styles.taskBody}>
                <span className={styles.taskTitle}>{finding.title}</span>
                <span className={styles.meta}>
                  {[
                    finding.id,
                    t(TYPE_KEYS[finding.type]),
                    finding.origin || '—',
                    dateOf(finding.date),
                  ].join(' · ')}
                </span>
              </span>
            </li>
          ))}
          {findings.length > MAX_ROWS ? (
            <li className={styles.meta}>
              {t('todo.findings.more', { count: findings.length - MAX_ROWS })}
            </li>
          ) : null}
        </ul>
      ) : null}
    </section>
  )
}
