import { ChevronDown } from 'lucide-react'
import { useEffect, useState } from 'react'

import {
  evidenceIsPath,
  inCheckouts,
  NIGHT_RESULTS,
  type NightDiary,
  nightDiaryFiles,
  type NightResult,
  parseNightDiary,
  workflowPath,
} from '../../lib/campaigns'
import { intlLocale, type MessageKey, useT } from '../../lib/i18n'
import {
  findRelativePath,
  type GitCheckouts,
  listDirectory,
  listenFileChanged,
  readTextFile,
} from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './CampaignsSection.module.css'
import type { Registry } from './campaignView'
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
 * The file evidence names: as given when absolute, else where find_relative_path finds it, else
 * relative to the main checkout (a missing file still opens, so its pane says so). The diary is
 * written by agents, so a path outside the repository's checkouts is never a link.
 */
async function evidenceTarget(
  main: string,
  evidence: string,
  checkouts: GitCheckouts,
): Promise<string | null> {
  if (!evidenceIsPath(evidence)) return null
  const absolute = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(evidence)
  const separator = main.includes('\\') ? '\\' : '/'
  const target = absolute
    ? evidence
    : ((await findRelativePath(main, evidence).catch(() => null)) ??
      `${main.replace(/[\\/]+$/, '')}${separator}${evidence.replace(/[\\/]/g, separator)}`)
  return inCheckouts(target, checkouts) ? target : null
}

function openFile(projectId: string, filePath: string) {
  const store = useProjectsStore.getState()
  const pane = store.createFilePane(projectId, { filePath })
  store.openPane(projectId, pane.id)
  useUiStore.getState().requestPaneFocus(pane.id)
}

/** What the night agent did, from its latest diary; read-only, hidden when there is none. */
export function NightCard({ registry }: { registry: Registry | null }) {
  const t = useT()
  const locale = useProjectsStore((state) => state.preferences.language)
  const main = registry?.main ?? null
  const checkouts = registry?.checkouts ?? null
  const diary = useNightDiary(main)
  const [open, setOpen] = useState(false)
  const [links, setLinks] = useState<{ diary: NightDiary; targets: Map<string, string> } | null>(
    null,
  )

  useEffect(() => {
    if (!diary || !main || !checkouts) return
    let cancelled = false
    void Promise.all(
      diary.entries.map(async ({ evidence }) => {
        const target = await evidenceTarget(main, evidence, checkouts)
        return [evidence, target] as const
      }),
    ).then((pairs) => {
      if (cancelled) return
      const targets = new Map<string, string>()
      for (const [evidence, target] of pairs) if (target) targets.set(evidence, target)
      setLinks({ diary, targets })
    })
    return () => {
      cancelled = true
    }
  }, [diary, main, checkouts])

  if (!diary || !registry) return null
  const { projectId } = registry
  const targets = links?.diary === diary ? links.targets : null

  const [year, month, day] = diary.date.split('-').map(Number)
  const date = new Intl.DateTimeFormat(intlLocale(locale), {
    day: '2-digit',
    month: '2-digit',
  }).format(new Date(year, month - 1, day))

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
        <span className={sidebarStyles.sectionName}>{t('todo.night.title', { date })}</span>
        <span className={styles.meta}>
          {NIGHT_RESULTS.map((result) => {
            const count = diary.entries.filter((entry) => entry.result === result).length
            return count > 0 ? <span key={result}>{t(COUNT_KEYS[result], { count })}</span> : null
          })}
        </span>
      </button>
      {open ? (
        <ul className={styles.tasks}>
          {diary.entries.map((entry, index) => (
            <li
              key={`${entry.task}-${index}`}
              className={styles.nightEntry}
              data-lane={RESULT_LANES[entry.result]}
              title={[entry.time, t(RESULT_KEYS[entry.result])].filter(Boolean).join(' · ')}
            >
              <span className={styles.dot} role="img" aria-label={t(RESULT_KEYS[entry.result])} />
              <span className={styles.id}>{entry.task}</span>
              <span className={styles.taskTitle}>{entry.summary}</span>
              {targets?.has(entry.evidence) ? (
                <button
                  type="button"
                  className={styles.evidence}
                  title={t('todo.night.openEvidence', { path: entry.evidence })}
                  onClick={() => openFile(projectId, targets.get(entry.evidence)!)}
                >
                  {entry.evidence}
                </button>
              ) : entry.evidence ? (
                <span className={styles.evidence} title={entry.evidence}>
                  {entry.evidence}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
