import { listen } from '@tauri-apps/api/event'
import { useEffect } from 'react'

import { InAppNotifications } from './components/InAppNotifications'
import { OrchestratorPane } from './components/OrchestratorPane'
import { useAgentCanvasMirror } from './lib/agentCanvasMirror'
import { useT } from './lib/i18n'
import { useAppliedTheme } from './lib/themes'
import styles from './OrchestrationWindow.module.css'
import { useProjectsStore } from './stores/projectsStore'

/** The main window saves in bursts while it is busy; one reload per burst is enough here. */
const RELOAD_THROTTLE_MS = 1_000

/**
 * A detached orchestration board (#247): one orchestration pane's board, alone in its own window.
 * It reads the state the main window saves and never writes it (see `setProjectsReadOnly`).
 */
export function OrchestrationWindow({ terminalId }: { terminalId: string }) {
  const t = useT()
  const hydrate = useProjectsStore((s) => s.hydrate)
  const hydrated = useProjectsStore((s) => s.hydrated)
  const projectId = useProjectsStore(
    (s) =>
      s.projects.find((project) => project.terminals.some((entry) => entry.id === terminalId))
        ?.id ?? null,
  )
  const terminal = useProjectsStore(
    (s) =>
      s.projects
        .find((project) => project.id === projectId)
        ?.terminals.find((entry) => entry.id === terminalId) ?? null,
  )
  const uiTheme = useProjectsStore((s) => s.preferences.uiTheme)
  const appliedTheme = useAppliedTheme(uiTheme)
  const visualStyle = useProjectsStore((s) => s.preferences.visualStyle ?? 'normal')

  // The main window owns the subagent canvas; this one shows what it publishes.
  useAgentCanvasMirror()

  // Read once, then again after the main window saves, so new planners, restarts and deleted panes
  // reach this window too. A reload reads the whole file, so saves close together share one.
  useEffect(() => {
    void hydrate()
    let cancelled = false
    let unlisten: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | null = null
    const reload = () => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        if (!cancelled) void hydrate()
      }, RELOAD_THROTTLE_MS)
    }
    void listen('projects://saved', reload).then((off) => {
      if (cancelled) off()
      else unlisten = off
    })
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      unlisten?.()
    }
  }, [hydrate])

  useEffect(() => {
    if (!hydrated) return
    document.documentElement.dataset.theme = appliedTheme
    document.documentElement.dataset.visualStyle = visualStyle
  }, [appliedTheme, hydrated, visualStyle])

  if (!hydrated) return null
  return (
    <div className={styles.root}>
      {projectId && terminal ? (
        <OrchestratorPane projectId={projectId} terminal={terminal} detached />
      ) : (
        <p className={styles.gone}>{t('orchestrator.windowPaneGone')}</p>
      )}
      <InAppNotifications />
    </div>
  )
}
