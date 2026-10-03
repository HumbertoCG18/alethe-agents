import { ChevronDown } from 'lucide-react'
import { useEffect, useState } from 'react'

import { type Finding, type FindingType, parseFindings, workflowPath } from '../../lib/campaigns'
import { intlLocale, type MessageKey, useT } from '../../lib/i18n'
import { listenFileChanged, readTextFile } from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import styles from './CampaignsSection.module.css'
import type { Registry } from './campaignView'
import sidebarStyles from './TodoSidebar.module.css'
import { createWatchSet } from './watchSet'

const TYPE_KEYS: Record<FindingType, MessageKey> = {
  bug: 'todo.findings.bug',
  risco: 'todo.findings.risk',
  ideia: 'todo.findings.idea',
  divida: 'todo.findings.debt',
}

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
 * The new findings in `<main>/.workflow/achados.json`. The file is watched; while it is absent
 * so is its folder, whose events name the file once it is written. Coming back to the window
 * re-reads it too, which also retries a watch that failed.
 */
function useFindings(main: string | null): Finding[] {
  const [state, setState] = useState<{ main: string; findings: Finding[] } | null>(null)

  useEffect(() => {
    if (!main) return
    const file = workflowPath(main, 'achados.json')
    const folder = workflowPath(main)
    let cancelled = false
    let latest = 0
    const watches = createWatchSet()
    const reload = async () => {
      const request = ++latest
      watches.watch(file)
      const source = await readTextFile(file).catch(() => null)
      if (cancelled || request !== latest) return
      if (source === null) watches.watch(folder)
      else watches.unwatch(folder)
      setState({ main, findings: source === null ? [] : parseFindings(source) })
    }
    void reload()
    const unlisten = listenFileChanged((path) => {
      if (path === file || path === folder) void reload()
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

  return state && state.main === main ? state.findings : []
}

/**
 * What agents noticed outside their task; read-only, collapsed, hidden when there is nothing new.
 * The file is written by agents, so everything is shown as text and the detail only as a tooltip.
 */
export function FindingsCard({ registry }: { registry: Registry | null }) {
  const t = useT()
  const locale = useProjectsStore((state) => state.preferences.language)
  const findings = useFindings(registry?.main ?? null)
  const [open, setOpen] = useState(false)

  if (findings.length === 0) return null

  const format = new Intl.DateTimeFormat(intlLocale(locale), { day: '2-digit', month: '2-digit' })
  const dateOf = (iso: string) => {
    const [year, month, day] = iso.split('-').map(Number)
    return format.format(new Date(year, month - 1, day))
  }

  return (
    <section className={styles.night}>
      <button
        type="button"
        className={sidebarStyles.sectionToggle}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <ChevronDown
          size={13}
          className={`${sidebarStyles.sectionChevron} ${open ? '' : sidebarStyles.sectionChevronClosed}`}
        />
        <span className={sidebarStyles.sectionName}>
          {t('todo.findings.title', { count: findings.length })}
        </span>
      </button>
      {open ? (
        <ul className={styles.tasks}>
          {findings.slice(0, MAX_ROWS).map((finding) => (
            <li
              key={finding.id}
              className={styles.nightEntry}
              data-finding={finding.id}
              data-lane={TYPE_LANES[finding.type]}
              title={finding.detail || undefined}
            >
              <span className={styles.dot} role="img" aria-label={t(TYPE_KEYS[finding.type])} />
              <span className={styles.id}>{finding.origin}</span>
              <span className={styles.taskTitle}>{finding.title}</span>
              <span className={styles.meta}>{dateOf(finding.date)}</span>
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
