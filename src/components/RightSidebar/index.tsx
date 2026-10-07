import { getCurrentWebview } from '@tauri-apps/api/webview'
import {
  ArrowLeft,
  Blocks,
  ClipboardCopy,
  FileText,
  GitPullRequest,
  Maximize2,
  Mic,
  PanelRightClose,
  Plug,
  RefreshCw,
  Settings2,
  Sparkles,
  X,
} from 'lucide-react'
import { type DragEvent, Suspense, useCallback, useEffect, useRef, useState } from 'react'

import {
  type GsdSyncSession,
  useGsdSyncAvailable,
  useGsdSyncSessions,
} from '../../hooks/useGsdSyncSessions'
import { useMarkdownFile } from '../../hooks/useMarkdownFile'
import { pathInside } from '../../lib/campaigns'
import { hasFileDragPayload, readFileDragPayload } from '../../lib/fileDrag'
import { useT } from '../../lib/i18n'
import { isMarkdownPath } from '../../lib/markdownSidebarHistory'
import { basename } from '../../lib/paths'
import { sameCwd } from '../../lib/paths'
import {
  type SidebarTabContribution,
  sidebarTabLabel,
  sidebarTabPanelLabel,
} from '../../lib/plugins'
import { sidebarIconIds, useVisibleSidebarIcons } from '../../lib/sidebarIcons'
import {
  findRelativePath,
  type PlanningStatus,
  readPlanningStatus,
  writeClipboardText,
} from '../../lib/tauri'
import { useSidebarViews } from '../../lib/viewPlacement'
import { selectActiveProject, useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { ContributedView } from '../ContributedView'
import { MarkdownSummary } from '../MarkdownPane/MarkdownSummary'
import { McpPanel } from '../McpPanel'
import { PluginsSidebar } from '../PluginsSidebar'
import { PullRequestsSidebar } from '../PullRequestsSidebar'
import { DotmCircular2 } from '../ui/dotm-circular-2'
import { VoiceHistoryPanel } from '../VoiceHistoryPanel'
import { MarkdownCatalog } from './MarkdownCatalog'
import styles from './RightSidebar.module.css'
import { useMarkdownCatalog } from './useMarkdownCatalog'

const markdownScrollPositions = new Map<string, number>()

export function RightSidebar() {
  const t = useT()
  const mode = useUiStore((state) => state.rightSidebarMode)
  const openMarkdown = useUiStore((state) => state.showMarkdownSidebar)
  const setRightSidebarMode = useUiStore((state) => state.setRightSidebarMode)
  const showGsdSyncSidebar = useUiStore((state) => state.showGsdSyncSidebar)
  const showMcp = useUiStore((state) => state.showMcpSidebar)
  const showPrs = useUiStore((state) => state.showPrsSidebar)
  const openModal = useUiStore((state) => state.openModal_)
  const preferences = useProjectsStore((state) => state.preferences)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  const activeProjectId = useProjectsStore((state) => state.activeProjectId)
  const projects = useProjectsStore((state) => state.projects)
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? projects[0]
  const sidebarTerminal = activeProject
    ? [...activeProject.terminals]
        .filter((terminal) => !terminal.kind)
        .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))[0]
    : null
  const sidebarSubTab =
    sidebarTerminal?.tabs.find((tab) => tab.id === sidebarTerminal.activeTabId) ??
    sidebarTerminal?.tabs[0]

  const contributedTabs = useSidebarViews('right')
  const contributedTab = contributedTabs.find((tab) => tab.id === mode)
  const mcpEnabled = preferences.enabledFeatures.mcp
  const prsEnabled = preferences.enabledFeatures.prs
  const gsdSyncAvailable = useGsdSyncAvailable()
  // The panel now survives its features being turned off one by one, so a mode whose
  // feature was disabled has to fall back instead of rendering a hidden feature.
  useEffect(() => {
    const modeStillEnabled =
      mode === 'markdown' ||
      (mode === 'gsdSync' && gsdSyncAvailable) ||
      (mode === 'mcp' && mcpEnabled) ||
      (mode === 'prs' && prsEnabled) ||
      mode === 'jev' ||
      mode === 'plugins' ||
      contributedTabs.some((tab) => tab.id === mode)
    if (modeStillEnabled) return
    openMarkdown()
  }, [contributedTabs, gsdSyncAvailable, mcpEnabled, prsEnabled, mode, openMarkdown])

  type Tab = {
    label: string
    title?: string
    Icon: SidebarTabContribution['icon']
    open: () => void
  }
  const tabs: Record<string, Tab> = {
    markdown: { label: t('rightSidebar.markdownTab'), Icon: FileText, open: openMarkdown },
    gsdSync: { label: t('rightSidebar.gsdSyncTab'), Icon: Sparkles, open: showGsdSyncSidebar },
    mcp: { label: t('mcp.tab'), Icon: Plug, open: showMcp },
    jev: {
      label: 'Jev',
      title: t('voice.history.tabTitle'),
      Icon: Mic,
      open: () => setRightSidebarMode('jev'),
    },
    prs: { label: t('rightSidebar.prsTab'), Icon: GitPullRequest, open: showPrs },
    plugins: {
      label: t('pluginsTab.title'),
      Icon: Blocks,
      open: () => setRightSidebarMode('plugins'),
    },
  }
  for (const tab of contributedTabs) {
    tabs[tab.id] = {
      label: sidebarTabLabel(t, tab),
      Icon: tab.icon,
      open: () => setRightSidebarMode(tab.id),
    }
  }
  const tabIds = useVisibleSidebarIcons(
    'right',
    sidebarIconIds(
      'right',
      contributedTabs.map((tab) => tab.id),
      { gsdSync: gsdSyncAvailable, mcp: mcpEnabled, prs: prsEnabled },
    ),
  )

  return (
    <aside className={styles.sidebar} aria-label={t('rightSidebar.navigation')}>
      <div className={styles.sidebarTabs} role="tablist" aria-label={t('rightSidebar.navigation')}>
        {tabIds.map((id) => {
          const { label, title, Icon, open } = tabs[id]
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={mode === id}
              className={`${styles.sidebarTab} ${mode === id ? styles.sidebarTabActive : ''}`}
              onClick={open}
              title={title ?? label}
            >
              <Icon size={14} />
              <span>{label}</span>
            </button>
          )
        })}
        <span className={styles.toolbarSpacer} />
        <button
          type="button"
          className={styles.toolbarUtility}
          onClick={() => openModal('preferences', { category: 'sidebar' })}
          title={t('rightSidebar.configure')}
          aria-label={t('rightSidebar.configure')}
        >
          <Settings2 size={14} />
        </button>
        {mode === 'mcp' && mcpEnabled ? (
          <button
            type="button"
            className={styles.toolbarUtility}
            onClick={() => openModal('mcpManager')}
            title={t('mcp.expand')}
            aria-label={t('mcp.expand')}
          >
            <Maximize2 size={14} />
          </button>
        ) : null}
        <span className={styles.toolbarDivider} />
        <button
          type="button"
          className={styles.toolbarUtility}
          onClick={() => setPreferences({ rightSidebarVisible: false })}
          title={t('todo.closeSidebar')}
          aria-label={t('todo.closeSidebar')}
        >
          <PanelRightClose size={14} />
        </button>
      </div>
      <div className={styles.tabContent}>
        {mode === 'markdown' ? <MarkdownSidebarViewer /> : null}
        {mode === 'gsdSync' && gsdSyncAvailable ? <GsdSyncSidebarContent /> : null}
        {mode === 'mcp' && mcpEnabled ? <McpPanel /> : null}
        {mode === 'prs' && prsEnabled ? <PullRequestsSidebar /> : null}
        {mode === 'jev' ? <VoiceHistoryPanel /> : null}
        {mode === 'plugins' ? <PluginsSidebar /> : null}
        {contributedTab ? (
          <section className={styles.contributedPanel}>
            <header className={styles.panelHeader}>
              <contributedTab.icon size={15} />
              <span>{sidebarTabPanelLabel(t, contributedTab)}</span>
            </header>
            <ContributedView
              view={contributedTab}
              projectId={activeProject?.id ?? null}
              cwd={sidebarSubTab?.cwd || sidebarTerminal?.cwd || null}
              ptyId={sidebarSubTab?.ptyId ?? null}
              terminalName={sidebarTerminal?.name ?? null}
            />
          </section>
        ) : null}
      </div>
    </aside>
  )
}

function GsdSyncSidebarContent() {
  const t = useT()
  const activeProject = useProjectsStore(selectActiveProject)
  const setGsdSyncActivityView = useUiStore((state) => state.setGsdSyncActivityView)
  const sessions = useGsdSyncSessions()
  const projectSessions = activeProject
    ? sessions.filter((session) => session.projectId === activeProject.id)
    : []

  if (!activeProject || projectSessions.length === 0) {
    return (
      <div className={styles.empty}>
        <Sparkles size={20} />
        <strong>{t('rightSidebar.gsdSyncEmptyTitle')}</strong>
        <span>{t('rightSidebar.gsdSyncEmptyDesc')}</span>
      </div>
    )
  }

  return (
    <div className={styles.gsdPanel}>
      <div className={styles.gsdList}>
        {projectSessions.map((session) => (
          <GsdSyncRow
            key={session.id}
            session={session}
            onOpen={() => {
              const title = basename(session.worktreePath) || session.worktreePath
              setGsdSyncActivityView({
                worktreePath: session.worktreePath,
                sessionId: session.childId,
                title,
              })
            }}
          />
        ))}
      </div>
    </div>
  )
}

function GsdSyncRow({ session, onOpen }: { session: GsdSyncSession; onOpen: () => void }) {
  const t = useT()
  const [status, setStatus] = useState<PlanningStatus | null>(null)
  const name = basename(session.worktreePath) || session.worktreePath

  useEffect(() => {
    if (!session.worktreePath) return
    let cancelled = false
    readPlanningStatus(session.worktreePath)
      .then((result) => {
        if (!cancelled) setStatus(result)
      })
      .catch(() => {
        if (!cancelled) setStatus(null)
      })
    return () => {
      cancelled = true
    }
  }, [session.worktreePath, session.busy])

  const statusLabel = session.hasError
    ? t('todo.gsdError')
    : session.busy
      ? t('todo.gsdBusy')
      : t('todo.gsdIdle')
  const progressLabel =
    status?.roadmapTotalCount != null && status.roadmapPendingCount != null
      ? t('todo.gsdProgress', {
          done: status.roadmapTotalCount - status.roadmapPendingCount,
          total: status.roadmapTotalCount,
        })
      : null

  return (
    <button type="button" className={styles.gsdRow} onClick={onOpen} title={name}>
      <span className={styles.gsdRowState}>
        {session.hasError ? (
          <span className={styles.gsdErrorDot} />
        ) : session.busy ? (
          <DotmCircular2
            size={13}
            dotSize={2}
            cellPadding={1}
            speed={1.2}
            bloom
            ariaLabel={statusLabel}
          />
        ) : (
          <span className={styles.gsdIdleDot} />
        )}
      </span>
      <span className={styles.gsdRowBody}>
        <span className={styles.gsdRowName}>{name}</span>
        <span className={styles.gsdRowMeta}>{progressLabel ?? statusLabel}</span>
      </span>
    </button>
  )
}

function MarkdownSidebarViewer() {
  const t = useT()
  const markdown = useUiStore((state) => state.rightSidebarMarkdown)
  const openMarkdownSidebar = useUiStore((state) => state.openMarkdownSidebar)
  const closeMarkdownSidebarTab = useUiStore((state) => state.closeMarkdownSidebarTab)
  const showTodoSidebar = useUiStore((state) => state.showTodoSidebar)
  const pushToast = useUiStore((state) => state.pushToast)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  const dark = useProjectsStore(
    (state) => state.preferences.uiTheme !== 'light' && state.preferences.uiTheme !== 'min-light',
  )
  const [copied, setCopied] = useState(false)
  const [dropActive, setDropActive] = useState(false)
  const panelRef = useRef<HTMLElement | null>(null)
  const nativeDragHasMarkdownRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const markdownRef = useRef<HTMLDivElement | null>(null)
  const catalog = useMarkdownCatalog()
  const selected = markdown
  const root = catalog.roots[0] ?? ''
  const scope = catalog.roots.join('\n')
  useEffect(() => {
    const current = useUiStore.getState().rightSidebarMarkdown
    if (scope && current && !scope.split('\n').some((root) => pathInside(current.path, root))) {
      useUiStore.setState({ rightSidebarMarkdown: null })
    }
  }, [scope])

  const { content, error, reload: load } = useMarkdownFile(selected?.path ?? null)

  useEffect(() => {
    if (!selected?.path || content === null) return
    const frame = window.requestAnimationFrame(() => {
      if (scrollRef.current)
        scrollRef.current.scrollTop = markdownScrollPositions.get(selected.path) ?? 0
    })
    return () => window.cancelAnimationFrame(frame)
  }, [content, selected?.path])

  useEffect(() => {
    if (!error || !selected?.path || !root) return
    let cancelled = false
    const path = selected.path
    void findRelativePath(root, path)
      .then((found) => {
        if (
          !cancelled &&
          found &&
          !sameCwd(found, path) &&
          useUiStore.getState().rightSidebarMarkdown?.path === path
        ) {
          closeMarkdownSidebarTab(path)
          openMarkdownSidebar(found, basename(found))
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [error, selected?.path, root, closeMarkdownSidebarTab, openMarkdownSidebar])

  const openDroppedMarkdownPaths = useCallback(
    (paths: string[]) => {
      for (const path of paths.filter(isMarkdownPath)) {
        openMarkdownSidebar(path, basename(path) || path)
      }
    },
    [openMarkdownSidebar],
  )

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    const isOverViewer = (position: { x: number; y: number }) => {
      const dpr = window.devicePixelRatio || 1
      const element = document.elementFromPoint(position.x / dpr, position.y / dpr)
      return Boolean(element && panelRef.current?.contains(element))
    }
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload
        if (payload.type === 'enter') {
          nativeDragHasMarkdownRef.current = payload.paths.some(isMarkdownPath)
          setDropActive(nativeDragHasMarkdownRef.current && isOverViewer(payload.position))
        } else if (payload.type === 'over') {
          setDropActive(nativeDragHasMarkdownRef.current && isOverViewer(payload.position))
        } else if (payload.type === 'leave') {
          nativeDragHasMarkdownRef.current = false
          setDropActive(false)
        } else {
          const overViewer = isOverViewer(payload.position)
          nativeDragHasMarkdownRef.current = false
          setDropActive(false)
          if (overViewer) openDroppedMarkdownPaths(payload.paths)
        }
      })
      .then((dispose) => {
        if (disposed) dispose()
        else unlisten = dispose
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [openDroppedMarkdownPaths])

  const onInternalDragOver = (event: DragEvent<HTMLElement>) => {
    if (!hasFileDragPayload(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    setDropActive(true)
  }

  const onInternalDragLeave = (event: DragEvent<HTMLElement>) => {
    if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget as Node)) return
    setDropActive(false)
  }

  const onInternalDrop = (event: DragEvent<HTMLElement>) => {
    const payload = readFileDragPayload(event.dataTransfer)
    if (!payload) return
    event.preventDefault()
    event.stopPropagation()
    setDropActive(false)
    openDroppedMarkdownPaths([payload.path])
  }

  const copyMarkdown = async () => {
    if (content === null) return
    try {
      await writeClipboardText(content)
      setCopied(true)
      pushToast({ title: t('ui.markdown.copied'), body: '' })
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <section
      ref={panelRef}
      className={`${styles.markdownPanel} ${dropActive ? styles.markdownDropActive : ''}`}
      aria-label={t('rightSidebar.markdownViewer')}
      onDragEnter={onInternalDragOver}
      onDragOver={onInternalDragOver}
      onDragLeave={onInternalDragLeave}
      onDrop={onInternalDrop}
    >
      {dropActive ? (
        <div className={styles.markdownDropOverlay}>{t('rightSidebar.dropMarkdown')}</div>
      ) : null}
      <header className={styles.header}>
        <div className={styles.heading}>
          <FileText size={15} />
          <span title={selected?.title ?? t('rightSidebar.catalog.title')}>
            {selected?.title ?? t('rightSidebar.catalog.title')}
          </span>
        </div>
        <div className={styles.headerActions}>
          {selected ? (
            <button
              type="button"
              className={styles.headerAction}
              aria-label={t('rightSidebar.closeMarkdownTab')}
              title={t('rightSidebar.closeMarkdownTab')}
              onClick={() => {
                closeMarkdownSidebarTab(selected.path)
                useUiStore.setState({ rightSidebarMarkdown: null })
              }}
            >
              <X size={15} />
            </button>
          ) : null}

          <button
            type="button"
            className={styles.headerAction}
            onClick={() => {
              void load()
              catalog.reload()
            }}
            title={t('ui.markdown.refresh')}
            aria-label={t('ui.markdown.refresh')}
          >
            <RefreshCw size={15} />
          </button>
          <button
            type="button"
            className={styles.headerAction}
            onClick={() => void copyMarkdown()}
            disabled={content === null}
            title={copied ? t('ui.markdown.copied') : t('ui.markdown.copySource')}
            aria-label={copied ? t('ui.markdown.copied') : t('ui.markdown.copySource')}
          >
            <ClipboardCopy size={15} />
          </button>
          <button
            type="button"
            className={`${styles.headerAction} ${styles.cleanRedundantAction}`}
            onClick={showTodoSidebar}
            title={t('rightSidebar.backToTodo')}
            aria-label={t('rightSidebar.backToTodo')}
          >
            <ArrowLeft size={15} />
          </button>
          <button
            type="button"
            className={`${styles.headerAction} ${styles.cleanRedundantAction}`}
            onClick={() => setPreferences({ rightSidebarVisible: false })}
            title={t('todo.closeSidebar')}
            aria-label={t('todo.closeSidebar')}
          >
            <PanelRightClose size={15} />
          </button>
        </div>
      </header>
      <MarkdownCatalog catalog={catalog} />
      <div className={styles.path} title={selected?.path ?? markdown?.path ?? ''}>
        {selected?.path ?? markdown?.path ?? ''}
      </div>
      <div className={styles.contentLayout}>
        <div
          ref={scrollRef}
          className={styles.content}
          onScroll={(event) => {
            if (selected?.path)
              markdownScrollPositions.set(selected.path, event.currentTarget.scrollTop)
          }}
        >
          {!selected ? (
            <div className={styles.empty}>
              <FileText size={20} />
              <strong>{t('rightSidebar.markdownEmptyTitle')}</strong>
              <span>{t('rightSidebar.catalog.choose')}</span>
            </div>
          ) : error ? (
            <div className={styles.empty}>
              <FileText size={20} />
              <strong>{t('rightSidebar.markdownError')}</strong>
              <span>{error}</span>
            </div>
          ) : content === null ? (
            <div className={styles.empty}>
              <span>{t('ui.markdown.loading')}</span>
            </div>
          ) : (
            <div ref={markdownRef} className={styles.commentableMarkdown}>
              <Suspense fallback={<span>{t('ui.markdown.loading')}</span>}>
                <MarkdownSummary path={selected!.path} content={content} dark={dark} />
              </Suspense>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
