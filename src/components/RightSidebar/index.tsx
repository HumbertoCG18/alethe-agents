import { getCurrentWebview } from '@tauri-apps/api/webview'
import {
  ArrowLeft,
  Blocks,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  FileText,
  Folder,
  FolderOpen,
  GitPullRequest,
  ListTree,
  Maximize2,
  Mic,
  PanelRightClose,
  Plug,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react'
import {
  type DragEvent,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import {
  type GsdSyncSession,
  useGsdSyncAvailable,
  useGsdSyncSessions,
} from '../../hooks/useGsdSyncSessions'
import { hasFileDragPayload, readFileDragPayload } from '../../lib/fileDrag'
import { useT } from '../../lib/i18n'
import { isMarkdownPath } from '../../lib/markdownSidebarHistory'
import { basename } from '../../lib/paths'
import {
  type SidebarTabContribution,
  sidebarTabLabel,
  sidebarTabPanelLabel,
} from '../../lib/plugins'
import { resolveProjectCheckout } from '../../lib/projectCheckout'
import { sidebarIconIds, useVisibleSidebarIcons } from '../../lib/sidebarIcons'
import {
  listProjectPlans,
  type PlanningStatus,
  readPlanningStatus,
  readTextFile,
  writeClipboardText,
} from '../../lib/tauri'
import { useSidebarViews } from '../../lib/viewPlacement'
import { useCampaignView } from '../../plugins/todos/campaignView'
import { campaignMarkdown, type CampaignMarkdownFile } from '../../plugins/todos/taskActions'
import { selectActiveProject, useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'

const MarkdownRenderer = lazy(() =>
  import('../MarkdownPane/MarkdownRenderer').then((m) => ({ default: m.MarkdownRenderer })),
)
import { ContributedView } from '../ContributedView'
import { McpPanel } from '../McpPanel'
import { PluginsSidebar } from '../PluginsSidebar'
import { FileIcon } from '../ProjectSidebar/FileIcon'
import { PullRequestsSidebar } from '../PullRequestsSidebar'
import { DotmCircular2 } from '../ui/dotm-circular-2'
import { VoiceHistoryPanel } from '../VoiceHistoryPanel'
import styles from './RightSidebar.module.css'

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
  const markdownTabs = useUiStore((state) => state.rightSidebarMarkdownTabs)
  const openMarkdownSidebar = useUiStore((state) => state.openMarkdownSidebar)
  const closeMarkdownSidebarTab = useUiStore((state) => state.closeMarkdownSidebarTab)
  const showTodoSidebar = useUiStore((state) => state.showTodoSidebar)
  const pushToast = useUiStore((state) => state.pushToast)
  const activeProjectId = useProjectsStore((state) => state.activeProjectId)
  const projects = useProjectsStore((state) => state.projects)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  const dark = useProjectsStore(
    (state) => state.preferences.uiTheme !== 'light' && state.preferences.uiTheme !== 'min-light',
  )
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [dropActive, setDropActive] = useState(false)
  const [selectedPath, setSelectedPath] = useState(markdown?.path ?? '')
  const panelRef = useRef<HTMLElement | null>(null)
  const nativeDragHasMarkdownRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const markdownRef = useRef<HTMLDivElement | null>(null)
  const [plans, setPlans] = useState<Array<{ path: string; title: string }>>([])
  const checkoutKey = useProjectsStore((state) => {
    const project = state.projects.find((item) => item.id === state.activeProjectId)
    return `${project?.checkoutPath ?? ''}\n${project?.defaultCwd ?? ''}`
  })
  // Plans come from the checkout the project uses: the picked worktree, the main one by default.
  const [planRoot, setPlanRoot] = useState<{ projectId: string; root: string } | null>(null)
  const campaignView = useCampaignView()
  const campaign = campaignView.registry?.campaigns.find(
    (item) => item.id === campaignView.activeId,
  )
  const campaignKey =
    campaign && campaignView.registry ? `${campaignView.registry.projectId}\n${campaign.id}` : null
  const [campaignFound, setCampaignFound] = useState<{
    key: string
    files: CampaignMarkdownFile[]
  } | null>(null)
  // Only the active campaign's own lookup shows: another's stays hidden while this one runs.
  const campaignFiles = campaignFound?.key === campaignKey ? campaignFound.files : []
  const [browsing, setBrowsing] = useState(false)

  useEffect(() => {
    const registry = campaignView.registry
    if (!campaign || !registry) return
    const key = `${registry.projectId}\n${campaign.id}`
    let cancelled = false
    void campaignMarkdown(campaign, registry).then((files) => {
      if (!cancelled) setCampaignFound({ key, files })
    })
    return () => {
      cancelled = true
    }
  }, [campaign, campaignView.registry])

  useEffect(() => {
    if (!activeProjectId) return
    let cancelled = false
    void resolveProjectCheckout(activeProjectId).then(({ root }) => {
      if (!cancelled) setPlanRoot({ projectId: activeProjectId, root })
    })
    return () => {
      cancelled = true
    }
  }, [activeProjectId, checkoutKey])

  useEffect(() => {
    const project = projects.find((item) => item.id === activeProjectId)
    const projectPath = planRoot?.projectId === project?.id ? planRoot?.root : undefined
    if (!projectPath || !project?.id) {
      setPlans([])
      return
    }
    let cancelled = false
    listProjectPlans(projectPath, project.id)
      .then((items) => {
        if (!cancelled) {
          setPlans(items.map((p) => ({ path: p.filePath, title: p.title })))
        }
      })
      .catch(() => {
        if (!cancelled) setPlans([])
      })
    return () => {
      cancelled = true
    }
  }, [activeProjectId, planRoot, projects])

  const readmeTabs = useMemo(() => {
    const project = projects.find((item) => item.id === activeProjectId)
    const projectTabs = (project?.terminals ?? [])
      .filter((terminal) => terminal.kind === 'markdown' && terminal.filePath)
      .map((terminal) => ({ path: terminal.filePath!, title: terminal.name }))
    const merged = new Map<string, { path: string; title: string; closable: boolean }>()
    for (const plan of plans) merged.set(plan.path, { ...plan, closable: false })
    for (const tab of projectTabs) merged.set(tab.path, { ...tab, closable: false })
    for (const tab of markdownTabs) merged.set(tab.path, { ...tab, closable: true })
    return [...merged.values()]
  }, [activeProjectId, markdownTabs, plans, projects])
  const selected =
    readmeTabs.find((tab) => tab.path === selectedPath) ??
    (markdown ? { path: markdown.path, title: markdown.title } : null)

  const load = async () => {
    if (!selected?.path) return
    try {
      setContent(await readTextFile(selected.path))
      setError(null)
    } catch (err) {
      setError(String(err))
      setContent(null)
    }
  }

  useEffect(() => {
    setContent(null)
    setError(null)
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markdown?.path, selectedPath])

  useEffect(() => {
    if (!selected?.path || content === null) return
    const frame = window.requestAnimationFrame(() => {
      if (scrollRef.current)
        scrollRef.current.scrollTop = markdownScrollPositions.get(selected.path) ?? 0
    })
    return () => window.cancelAnimationFrame(frame)
  }, [content, selected?.path])

  useEffect(() => {
    if (markdown?.path) setSelectedPath(markdown.path)
  }, [markdown?.path])

  // Every request to open a file shows it, from the list or anywhere else, the same file included:
  // each request is a new entry.
  useEffect(() => setBrowsing(false), [markdown])

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

  const openListed = (path: string, title: string) => {
    setSelectedPath(path)
    openMarkdownSidebar(path, title)
  }
  const listed = campaignFiles.length > 0 || plans.length > 0
  const showingList = browsing && listed
  const list = (
    <MarkdownList
      campaignId={campaign?.id ?? null}
      files={campaignFiles}
      plans={plans}
      onOpen={openListed}
    />
  )

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

  if (!markdown && !selected) {
    if (listed) {
      return (
        <section
          ref={panelRef}
          className={`${styles.markdownPanel} ${dropActive ? styles.markdownDropActive : ''}`}
          onDragEnter={onInternalDragOver}
          onDragOver={onInternalDragOver}
          onDragLeave={onInternalDragLeave}
          onDrop={onInternalDrop}
        >
          {list}
          {dropActive ? (
            <div className={styles.markdownDropOverlay}>{t('rightSidebar.dropMarkdown')}</div>
          ) : null}
        </section>
      )
    }

    return (
      <section
        ref={panelRef}
        className={`${styles.emptyMarkdown} ${dropActive ? styles.markdownDropActive : ''}`}
        onDragEnter={onInternalDragOver}
        onDragOver={onInternalDragOver}
        onDragLeave={onInternalDragLeave}
        onDrop={onInternalDrop}
      >
        <FileText size={20} />
        <strong>{t('rightSidebar.markdownEmptyTitle')}</strong>
        <span>{t('rightSidebar.markdownEmptyDesc')}</span>
        {dropActive ? (
          <div className={styles.markdownDropOverlay}>{t('rightSidebar.dropMarkdown')}</div>
        ) : null}
      </section>
    )
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
          {showingList ? <ListTree size={15} /> : <FileText size={15} />}
          <span title={showingList ? undefined : (selected?.title ?? markdown?.title ?? '')}>
            {showingList
              ? t('rightSidebar.markdownList')
              : (selected?.title ?? markdown?.title ?? '')}
          </span>
        </div>
        <div className={styles.headerActions}>
          {listed ? (
            <button
              type="button"
              className={`${styles.headerAction} ${showingList ? styles.headerActionActive : ''}`}
              onClick={() => setBrowsing((current) => !current)}
              aria-pressed={showingList}
              title={t('rightSidebar.markdownList')}
              aria-label={t('rightSidebar.markdownList')}
            >
              <ListTree size={15} />
            </button>
          ) : null}
          {showingList ? null : (
            <>
              <button
                type="button"
                className={styles.headerAction}
                onClick={() => void load()}
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
            </>
          )}
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
      {showingList ? list : null}
      {!showingList && readmeTabs.length > 1 ? (
        <div
          className={styles.readmeTabs}
          role="tablist"
          aria-label={t('rightSidebar.markdownTabs')}
        >
          {readmeTabs.map((tab) => (
            <div
              key={tab.path}
              role="tab"
              aria-selected={selected?.path === tab.path}
              className={`${styles.readmeTab} ${selected?.path === tab.path ? styles.readmeTabActive : ''}`}
              title={tab.path}
            >
              <button
                type="button"
                className={styles.readmeTabSelect}
                onClick={() => {
                  setSelectedPath(tab.path)
                  openMarkdownSidebar(tab.path, tab.title)
                }}
              >
                <FileText size={11} />
                <span>{tab.title}</span>
              </button>
              {tab.closable ? (
                <button
                  type="button"
                  className={styles.readmeTabClose}
                  onClick={() => closeMarkdownSidebarTab(tab.path)}
                  title={t('rightSidebar.closeMarkdownTab')}
                  aria-label={t('rightSidebar.closeMarkdownTab')}
                >
                  <X size={10} />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {showingList ? null : (
        <>
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
              {error ? (
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
                    <MarkdownRenderer content={content} dark={dark} />
                  </Suspense>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  )
}

/**
 * The Markdown worth opening here: the active campaign's, grouped by the folder the registry names,
 * then the project plans, in the file explorer's rows.
 */
function MarkdownList({
  campaignId,
  files,
  plans,
  onOpen,
}: {
  campaignId: string | null
  files: CampaignMarkdownFile[]
  plans: Array<{ path: string; title: string }>
  onOpen: (path: string, title: string) => void
}) {
  const t = useT()
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set())
  const folders = new Map<string, CampaignMarkdownFile[]>()
  for (const file of files) {
    const written = file.written.replace(/\\/g, '/')
    const folder = written.includes('/') ? written.slice(0, written.lastIndexOf('/')) : '.'
    folders.set(folder, [...(folders.get(folder) ?? []), file])
  }
  const toggle = (folder: string) =>
    setClosed((current) => {
      const next = new Set(current)
      if (!next.delete(folder)) next.add(folder)
      return next
    })
  const fileRow = (path: string, title: string, chip: string | null, nested: boolean) => (
    <button
      key={path}
      type="button"
      className={`${styles.listRow} ${nested ? styles.listNested : ''}`}
      title={path}
      onClick={() => onOpen(path, title)}
    >
      <FileIcon fileName={basename(path) || path} size={13} className={styles.listIcon} />
      <span className={styles.listName}>{title}</span>
      {chip ? <span className={styles.listChip}>{chip}</span> : null}
    </button>
  )

  return (
    <div className={styles.list}>
      {campaignId && files.length > 0 ? (
        <>
          <div className={styles.listHeading}>
            {t('rightSidebar.campaignMarkdown', { id: campaignId })}
          </div>
          {[...folders].map(([folder, items]) => {
            const open = !closed.has(folder)
            return (
              <div key={folder}>
                <button
                  type="button"
                  className={styles.listRow}
                  onClick={() => toggle(folder)}
                  aria-expanded={open}
                  title={folder}
                >
                  {open ? (
                    <ChevronDown size={13} className={styles.listChevron} />
                  ) : (
                    <ChevronRight size={13} className={styles.listChevron} />
                  )}
                  {open ? (
                    <FolderOpen size={14} className={styles.listIcon} />
                  ) : (
                    <Folder size={14} className={styles.listIcon} />
                  )}
                  <span className={styles.listName}>{folder}</span>
                </button>
                {open
                  ? items.map((file) =>
                      fileRow(
                        file.path,
                        basename(file.path) || file.path,
                        file.task ?? t('rightSidebar.handoffChip'),
                        true,
                      ),
                    )
                  : null}
              </div>
            )
          })}
        </>
      ) : null}
      {plans.length > 0 ? (
        <>
          <div className={styles.listHeading}>{t('plans.title')}</div>
          {plans.map((plan) => fileRow(plan.path, plan.title, null, false))}
        </>
      ) : null}
    </div>
  )
}
