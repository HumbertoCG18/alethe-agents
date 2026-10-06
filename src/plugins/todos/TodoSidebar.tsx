import {
  Check,
  ChevronDown,
  ExternalLink,
  FolderKanban,
  GripVertical,
  ListTodo,
  Pause,
  Pencil,
  Play,
  Plus,
  Settings,
  Square,
  SquareTerminal,
  Tag,
  Trash2,
  X,
} from 'lucide-react'
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import controlStyles from '../../components/modals/controls.module.css'
import { DotmCircular2 } from '../../components/ui/dotm-circular-2'
import {
  type GsdSyncSession,
  useGsdSyncAvailable,
  useGsdSyncSessions,
} from '../../hooks/useGsdSyncSessions'
import {
  type Campaign,
  type CampaignTask,
  campaignTaskView,
  campaignWorkers,
  type NightDiary,
  type NightEntry,
  resumeTask,
  stepProgress,
  type TaskWorkers,
} from '../../lib/campaigns'
import { askConfirm } from '../../lib/dialog'
import { type MessageKey, useT } from '../../lib/i18n'
import { formatShortcut } from '../../lib/platform'
import { type PlanningStatus, readPlanningStatus } from '../../lib/tauri'
import { TODO_TITLE_MAX_LENGTH } from '../../lib/todos'
import type { Terminal, TodoItem } from '../../lib/types'
import { selectActiveProject, useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { CampaignDependencies, CampaignsSection } from './CampaignsSection'
import campaignStyles from './CampaignsSection.module.css'
import {
  type AgentTail,
  type CampaignCancel,
  type CampaignEdits,
  type CampaignLive,
  cancelCampaign,
  continueCampaign,
  nightUndecided,
  pauseCampaign,
  type Registry,
  requestCampaignSession,
  resumeCampaign,
  STATE_KEYS,
  TASK_LANES,
  useAgentTails,
  useCampaignEdits,
  useCampaignFacts,
  useCampaignLive,
  useCampaignView,
  useNightDiary,
  useTaskJobs,
  useTaskWorkers,
  workersLabel,
} from './campaignView'
import { FindingsCard } from './FindingsCard'
import { nightDay, situationLabel } from './labels'
import { TODO_SETTINGS_MODAL_ID } from './manifest'
import { NightCard, NightEntryRow, NightStatus } from './NightCard'
import { SectionToggle, SortableSections } from './SectionToggle'
import { orderedSections, TODO_TABS, type TodoTab, useTodosStore } from './store'
import { type TaskActions, useTaskActions } from './taskActions'
import { type DetailSources, TaskDetail } from './TaskDetail'
import styles from './TodoSidebar.module.css'
import { useFindings } from './useFindings'

/** The keys of the Active section, and of each of its campaigns, among the collapsed ones. */
const ACTIVE_SECTION = 'active'
const campaignKey = (id: string) => `campaign:${id}`

const TAB_KEYS: Record<TodoTab, MessageKey> = {
  tasks: 'todo.tabs.tasks',
  night: 'todo.tabs.night',
  personal: 'todo.personalTitle',
}

/** How the lab's hooks and CLI start the `resultado` of a task left for the user's Gate 2. */
const GATE_2_RESULT = 'aguarda o Gate 2'

function GsdSyncSection() {
  const t = useT()
  const activeProject = useProjectsStore(selectActiveProject)
  const setFullscreenPane = useProjectsStore((state) => state.setFullscreenPane)
  const available = useGsdSyncAvailable()
  const sessions = useGsdSyncSessions()
  const projectSessions = activeProject
    ? sessions.filter((session) => session.projectId === activeProject.id)
    : []

  if (!available || !activeProject || projectSessions.length === 0) return null

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <span>{t('todo.gsdSectionTitle')}</span>
        <span className={styles.sectionCount}>{projectSessions.length}</span>
      </div>
      <div className={styles.list}>
        {projectSessions.map((session) => {
          const terminal = activeProject.terminals.find((term) => term.cwd === session.worktreePath)
          if (!terminal) return null
          return (
            <GsdSyncRow
              key={session.id}
              terminal={terminal}
              session={session}
              onOpen={() => setFullscreenPane(terminal.id)}
            />
          )
        })}
      </div>
    </section>
  )
}

function GsdSyncRow({
  terminal,
  session,
  onOpen,
}: {
  terminal: Terminal
  session: GsdSyncSession
  onOpen: () => void
}) {
  const t = useT()
  const [status, setStatus] = useState<PlanningStatus | null>(null)

  useEffect(() => {
    if (!terminal.cwd) return
    let cancelled = false
    readPlanningStatus(terminal.cwd)
      .then((result) => {
        if (!cancelled) setStatus(result)
      })
      .catch(() => {
        if (!cancelled) setStatus(null)
      })
    return () => {
      cancelled = true
    }
  }, [terminal.cwd, session.busy])

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
    <button type="button" className={styles.gsdRow} onClick={onOpen} title={terminal.name}>
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
        <span className={styles.gsdRowName}>{terminal.name}</span>
        <span className={styles.gsdRowMeta}>{progressLabel ?? statusLabel}</span>
      </span>
    </button>
  )
}

export function TodoSidebar() {
  const t = useT()
  const openModal = useUiStore((state) => state.openModal_)
  const todos = useTodosStore((state) => state.todos)
  const projects = useProjectsStore((state) => state.projects)
  const createTodo = useTodosStore((state) => state.createTodo)
  const renameTodo = useTodosStore((state) => state.renameTodo)
  const updateTodoTags = useTodosStore((state) => state.updateTodoTags)
  const setTodoProject = useTodosStore((state) => state.setTodoProject)
  const toggleTodo = useTodosStore((state) => state.toggleTodo)
  const deleteTodo = useTodosStore((state) => state.deleteTodo)
  const reorderTodo = useTodosStore((state) => state.reorderTodo)
  const [title, setTitle] = useState('')
  const [tagDraft, setTagDraft] = useState('')
  const [projectDraft, setProjectDraft] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [doneOpen, setDoneOpen] = useState(false)
  const [composerExpanded, setComposerExpanded] = useState(false)
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set())
  const addInputRef = useRef<HTMLInputElement>(null)
  const tabsId = useId()
  const locale = useProjectsStore((state) => state.preferences.language)
  const tab = useTodosStore((state) => state.tab)
  const setTab = useTodosStore((state) => state.setTab)
  const view = useCampaignView()
  const edits = useCampaignEdits(view)
  const jobs = useTaskJobs()
  const workers = useTaskWorkers(view.registry, jobs)
  const diary = useNightDiary(view.registry?.main ?? null)
  const findings = useFindings(view.registry?.main ?? null)
  // What a task row's detail reads, only once it is expanded.
  const sources = view.registry ? { registry: view.registry, jobs, diary, findings } : null
  const nightRunning = useTodosStore(
    (state) => view.projectId !== null && state.nightRun.current?.projectId === view.projectId,
  )
  const savedOrder = useTodosStore((state) =>
    view.projectId ? state.sectionOrder[view.projectId] : undefined,
  )
  const setSectionOrder = useTodosStore((state) => state.setSectionOrder)
  // A campaign's add field shows, for one task, once + or Ctrl+N asks for it: until the task is
  // added, or the field left empty. It belongs to the campaign and the project it was shown in, so
  // switching projects does not carry it over.
  const [addFieldShownFor, setAddFieldShownFor] = useState<{
    projectId: string
    campaignId: string
  } | null>(null)
  const addFieldShown =
    addFieldShownFor?.projectId === view.projectId ? addFieldShownFor.campaignId : null
  const addInputs = useRef(new Map<string, HTMLInputElement>())
  // Each campaign field's draft, by project and campaign: kept here, as the field goes with Tasks.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const draftKey = (campaignId: string) => `${view.projectId}\n${campaignId}`
  // One campaign control at a time, kept here so that leaving Tasks while one runs cannot release
  // it: the ref is set before any await, so a second click cannot slip in.
  const acting = useRef(false)
  const [busy, setBusy] = useState(false)
  /** Runs `action` unless another control is running; the controls are disabled meanwhile. */
  const once = (action: () => Promise<void>) => () => {
    if (acting.current) return
    acting.current = true
    setBusy(true)
    void action().finally(() => {
      acting.current = false
      setBusy(false)
    })
  }
  // Where the focus goes once a decision empties Pending, which then goes away.
  const tasksTab = useRef<HTMLButtonElement>(null)
  const campaigns = view.registry?.campaigns ?? []
  const live = useCampaignLive(view.projectId, campaigns, workers)
  // A finished campaign shows only under Completed, even while live.
  const activeCampaigns = campaigns.filter(
    (campaign) => live.has(campaign.id) && campaign.situation.kind !== 'done',
  )
  const waiting = view.registry ? waitingOnYou(view.registry, diary) : null
  // What each active campaign's agent last said, and the questions they wait on.
  const tails = useAgentTails(
    view.projectId,
    activeCampaigns.map((campaign) => campaign.id),
  )
  const questions = activeCampaigns.flatMap((campaign) => {
    const text = tails.get(campaign.id)?.question
    return text ? [{ campaign, text }] : []
  })
  // What Pending lists, left out wherever else a campaign's tasks are listed.
  const pending: ReadonlySet<string> = new Set([
    ...(waiting?.night.map((entry) => entry.task) ?? []),
    ...(waiting?.gate2.map(({ task }) => task.id) ?? []),
  ])

  const active = todos.filter((todo) => !todo.completed)
  const completed = todos.filter((todo) => todo.completed)
  // The latest night's tasks, and those of them done in the registry now.
  const nightTasks = [...new Set(diary?.entries.map((entry) => entry.task))]
  const doneNow = new Set(
    campaigns.flatMap((campaign) =>
      campaign.tasks.filter((task) => task.state === 'concluída').map((task) => task.id),
    ),
  )
  // Personal and Night keep their totals; Overview follows the selected running campaign.
  const parts: ProgressPart[] | null =
    tab === 'personal'
      ? [{ name: null, done: completed.length, total: todos.length, more: false }]
      : tab === 'night'
        ? diary
          ? [
              {
                name: t('todo.night.title', { date: nightDay(diary.date, locale) }),
                done: nightTasks.filter((id) => doneNow.has(id)).length,
                total: nightTasks.length,
                more: false,
              },
            ]
          : null
        : campaigns
            .filter(
              (campaign) =>
                campaign.id === view.activeId &&
                live.get(campaign.id) === 'working' &&
                campaign.situation.kind !== 'done',
            )
            .map((campaign) => ({
              name: campaign.id,
              done: campaign.done,
              total: campaign.total,
              more: !campaign.decomposed,
            }))

  // The Ctrl+N listener is installed once: it runs the latest render's handler. On Tasks it goes to
  // the add field of the focused campaign when it is active, else of the first active one;
  // anywhere else, to your own list's composer.
  const newTask = useRef(() => {})
  /** Shows a campaign's add field, for one task, and focuses it. */
  const revealAddField = (campaignId: string) => {
    if (!view.projectId) return
    setAddFieldShownFor({ projectId: view.projectId, campaignId })
    // Its field sits in its subsection, inside Active: either may be collapsed.
    setCollapsedSections((current) => {
      const next = new Set(current)
      next.delete(ACTIVE_SECTION)
      next.delete(campaignKey(campaignId))
      return next
    })
    window.requestAnimationFrame(() => addInputs.current.get(campaignId)?.focus())
  }
  newTask.current = () => {
    const target =
      tab === 'tasks'
        ? (activeCampaigns.find((campaign) => campaign.id === view.activeId) ?? activeCampaigns[0])
        : undefined
    if (target && view.projectId) {
      revealAddField(target.id)
      return
    }
    setTab('personal')
    setComposerExpanded(true)
    window.requestAnimationFrame(() => addInputRef.current?.focus())
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== 'n') return
      event.preventDefault()
      newTask.current()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  const submit = () => {
    if (!createTodo(title, parseTags(tagDraft), projectDraft || undefined)) return
    setTitle('')
    setTagDraft('')
    setProjectDraft('')
    setComposerExpanded(false)
  }

  const toggleSection = (key: string) => {
    setCollapsedSections((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const startEditing = (todo: TodoItem) => {
    setEditingId(todo.id)
    setEditTitle(todo.title)
  }

  const finishEditing = () => {
    if (!editingId) return
    if (editTitle.trim()) renameTodo(editingId, editTitle)
    setEditingId(null)
    setEditTitle('')
  }

  const editTags = (todo: TodoItem) => {
    const value = window.prompt(t('todo.tagsPrompt'), todo.tags.join(', '))
    if (value === null) return
    updateTodoTags(todo.id, parseTags(value))
  }

  /** A personal todo's row: its project is its chip, and it moves by dragging among its peers. */
  const renderTodo = (todo: TodoItem) => {
    const editing = editingId === todo.id
    return (
      <div
        key={todo.id}
        className={[
          styles.todoRow,
          todo.completed ? styles.todoRowCompleted : '',
          draggedId === todo.id ? styles.todoRowDragging : '',
          dropTargetId === todo.id && draggedId !== todo.id ? styles.todoRowDropTarget : '',
        ]
          .filter(Boolean)
          .join(' ')}
        draggable={!editing}
        onDragStart={(event) => {
          setDraggedId(todo.id)
          setDropTargetId(null)
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', todo.id)
        }}
        onDragEnd={() => {
          setDraggedId(null)
          setDropTargetId(null)
        }}
        onDragOver={(event) => {
          if (!draggedId) return
          const dragged = todos.find((item) => item.id === draggedId)
          if (dragged?.completed !== todo.completed) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          setDropTargetId(todo.id)
        }}
        onDragLeave={() => {
          if (dropTargetId === todo.id) setDropTargetId(null)
        }}
        onDrop={(event) => {
          event.preventDefault()
          if (draggedId) reorderTodo(draggedId, todo.id)
          setDraggedId(null)
          setDropTargetId(null)
        }}
      >
        <button
          type="button"
          className={styles.dragHandle}
          title={t('todo.drag')}
          aria-label={t('todo.drag')}
          tabIndex={-1}
        >
          <GripVertical size={13} />
        </button>
        <button
          type="button"
          className={styles.checkButton}
          onClick={() => toggleTodo(todo.id)}
          title={todo.completed ? t('todo.reopen') : t('todo.complete')}
          aria-label={todo.completed ? t('todo.reopen') : t('todo.complete')}
        >
          {todo.completed ? <Check size={12} /> : null}
        </button>

        {editing ? (
          <input
            autoFocus
            className={styles.editInput}
            value={editTitle}
            maxLength={TODO_TITLE_MAX_LENGTH}
            onChange={(event) => setEditTitle(event.target.value)}
            onBlur={() => {
              setEditingId(null)
              setEditTitle('')
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') finishEditing()
              if (event.key === 'Escape') {
                setEditingId(null)
                setEditTitle('')
              }
            }}
            aria-label={t('todo.edit')}
          />
        ) : (
          <div className={styles.todoTitle}>
            <button
              type="button"
              className={styles.titleButton}
              onClick={() => startEditing(todo)}
              title={todo.title}
            >
              <span className={styles.todoTitleText}>{todo.title}</span>
            </button>
            {todo.tags.length > 0 ? (
              <span className={styles.tags}>
                {todo.tags.map((tag) => (
                  <span key={tag} className={styles.tag}>
                    #{tag}
                  </span>
                ))}
              </span>
            ) : null}
            {todo.prUrl ? (
              <a
                href={todo.prUrl}
                target="_blank"
                rel="noreferrer"
                className={styles.prBadge}
                title={t('todo.openPr', { number: todo.prNumber ?? 0 })}
                aria-label={t('todo.openPr', { number: todo.prNumber ?? 0 })}
              >
                <ExternalLink size={11} />
              </a>
            ) : null}
            <ProjectPicker
              value={todo.projectId ?? ''}
              projects={projects}
              noProjectLabel={t('todo.noProject')}
              ariaLabel={t('todo.linkProject')}
              compact
              onChange={(projectId) => setTodoProject(todo.id, projectId || null)}
            />
          </div>
        )}

        <div className={styles.rowActions}>
          {editing ? (
            <>
              <button
                type="button"
                className={styles.rowAction}
                onClick={() => editTags(todo)}
                title={t('todo.editTags')}
                aria-label={t('todo.editTags')}
              >
                <Tag size={12} />
              </button>
              <button
                type="button"
                className={styles.rowAction}
                onMouseDown={(event) => event.preventDefault()}
                onClick={finishEditing}
                title={t('todo.saveEdit')}
                aria-label={t('todo.saveEdit')}
              >
                <Check size={13} />
              </button>
              <button
                type="button"
                className={styles.rowAction}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setEditingId(null)
                  setEditTitle('')
                }}
                title={t('common.cancel')}
                aria-label={t('common.cancel')}
              >
                <X size={13} />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={styles.rowAction}
                onClick={() => startEditing(todo)}
                title={t('todo.edit')}
                aria-label={t('todo.edit')}
              >
                <Pencil size={12} />
              </button>
              <button
                type="button"
                className={`${styles.rowAction} ${styles.deleteAction}`}
                onClick={() => deleteTodo(todo.id)}
                title={t('todo.delete')}
                aria-label={t('todo.delete')}
              >
                <Trash2 size={12} />
              </button>
            </>
          )}
        </div>
      </div>
    )
  }

  const composer = (
    <form
      className={styles.addForm}
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <div className={styles.composerBox}>
        <button
          type="submit"
          className={styles.composerSubmit}
          disabled={!title.trim()}
          title={t('todo.add')}
          aria-label={t('todo.add')}
        >
          <Plus size={15} />
        </button>
        <input
          ref={addInputRef}
          className={styles.composerInput}
          value={title}
          maxLength={TODO_TITLE_MAX_LENGTH}
          onFocus={() => setComposerExpanded(true)}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !title.trim()) setComposerExpanded(false)
          }}
          placeholder={t('todo.addPlaceholder')}
          aria-label={t('todo.addPlaceholder')}
        />
        <kbd className={styles.composerShortcut}>{formatShortcut('Ctrl+N')}</kbd>
      </div>
      {composerExpanded ? (
        <div className={styles.composerDetails}>
          <div className={styles.tagInputWrap}>
            <Tag size={13} aria-hidden="true" />
            <input
              className={`${styles.addInput} ${styles.addTagInput}`}
              value={tagDraft}
              onChange={(event) => setTagDraft(event.target.value)}
              placeholder={t('todo.tagsPlaceholder')}
              aria-label={t('todo.tagsPlaceholder')}
            />
          </div>
          <ProjectPicker
            value={projectDraft}
            projects={projects}
            noProjectLabel={t('todo.noProject')}
            ariaLabel={t('todo.linkProject')}
            onChange={setProjectDraft}
          />
        </div>
      ) : null}
    </form>
  )

  // One list: the open todos in their order, then the done ones, collapsed.
  const personal =
    todos.length === 0 ? (
      <div className={styles.empty}>
        <div className={styles.emptyIcon}>
          <ListTodo size={20} />
        </div>
        <strong>{t('todo.emptyTitle')}</strong>
        <span>{t('todo.emptyDescription')}</span>
      </div>
    ) : (
      <div className={styles.list}>
        {active.map(renderTodo)}
        {completed.length > 0 ? (
          <>
            <SectionToggle
              name={t('todo.activeDone', { count: completed.length })}
              count={null}
              open={doneOpen}
              onToggle={() => setDoneOpen((current) => !current)}
              variant="sub"
            />
            {doneOpen ? completed.map(renderTodo) : null}
          </>
        ) : null}
      </div>
    )

  const tasks = (
    <>
      <GsdSyncSection />
      {view.registry ? (
        <SortableSections
          order={orderedSections(savedOrder)}
          onReorder={(order) => {
            if (view.projectId) setSectionOrder(view.projectId, order)
          }}
          sections={{
            pending: {
              node: (
                <PendingSection
                  registry={view.registry}
                  diary={diary}
                  night={waiting?.night ?? []}
                  gate2={waiting?.gate2 ?? []}
                  edits={edits}
                  workers={workers}
                  sources={sources}
                  away={tasksTab}
                  questions={questions}
                />
              ),
            },
            active: {
              node: (
                <ActiveSection
                  campaigns={activeCampaigns}
                  registry={view.registry}
                  live={live}
                  edits={edits}
                  workers={workers}
                  sources={sources}
                  pending={pending}
                  tails={tails}
                  once={once}
                  busy={busy}
                  collapsed={collapsedSections}
                  onToggle={toggleSection}
                  addField={{
                    shown: addFieldShown,
                    reveal: revealAddField,
                    leave: () => setAddFieldShownFor(null),
                    inputs: addInputs.current,
                    draft: (campaignId) => drafts[draftKey(campaignId)] ?? '',
                    setDraft: (campaignId, text) =>
                      setDrafts((current) => ({ ...current, [draftKey(campaignId)]: text })),
                  }}
                />
              ),
            },
            findings: { node: <FindingsCard findings={findings} /> },
            campaigns: {
              node: <CampaignsSection view={view} workers={workers} pending={pending} />,
            },
            completed: {
              node: <CampaignsSection view={view} workers={workers} pending={pending} finished />,
            },
          }}
        />
      ) : view.problem?.kind === 'error' ? (
        <div className={campaignStyles.invalid} role="alert">
          <p className={campaignStyles.invalidTitle}>
            {t('todo.registryError', {
              reason:
                view.problem.message ||
                t(
                  view.problem.stage === 'checkouts'
                    ? 'todo.registryNoMain'
                    : 'todo.registryNotRegistry',
                ),
            })}
          </p>
          <button
            type="button"
            className={`${controlStyles.btn} ${controlStyles.btnSm}`}
            onClick={() => void view.reload()}
          >
            {t('common.reload')}
          </button>
        </div>
      ) : view.problem?.kind === 'missing' ? (
        <p className={styles.sectionEmpty}>{t('todo.noRegistry')}</p>
      ) : view.projectId ? null : (
        <p className={styles.sectionEmpty}>{t('todo.selectProject')}</p>
      )}
    </>
  )

  const night = (
    <>
      <NightStatus projectId={view.projectId} />
      <CampaignsSection view={view} workers={workers} includeLive />
      {view.registry && diary ? (
        <NightCard registry={view.registry} diary={diary} edits={edits} />
      ) : (
        <p className={styles.sectionEmpty}>
          {t(view.projectId ? 'todo.night.empty' : 'todo.selectProject')}
        </p>
      )}
    </>
  )

  return (
    <aside className={styles.sidebar} aria-label={t('todo.title')}>
      <header className={styles.header}>
        <div className={styles.headerTop}>
          <div className={styles.heading}>
            <ListTodo size={17} />
            <span>{t('todo.title')}</span>
          </div>
          <button
            type="button"
            className={styles.headerAction}
            onClick={() => openModal(TODO_SETTINGS_MODAL_ID)}
            title={t('todo.openSettings')}
            aria-label={t('todo.openSettings')}
          >
            <Settings size={14} />
          </button>
        </div>
        {parts?.length ? <ProgressBar parts={parts} /> : null}
        <div className={styles.filters} role="tablist" aria-label={t('todo.tabs.label')}>
          {TODO_TABS.map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              ref={item === 'tasks' ? tasksTab : undefined}
              id={`${tabsId}-${item}`}
              aria-selected={tab === item}
              aria-controls={`${tabsId}-panel`}
              className={`${styles.filterButton} ${tab === item ? styles.filterButtonActive : ''}`}
              onClick={() => setTab(item)}
            >
              {t(TAB_KEYS[item])}
              {item === 'night' && nightRunning ? (
                <span
                  className={`${campaignStyles.dot} ${styles.tabDot}`}
                  data-status="working"
                  role="img"
                  aria-label={t('todo.campaigns.liveRunning')}
                />
              ) : null}
            </button>
          ))}
        </div>
      </header>

      {tab === 'personal' ? composer : null}

      <div
        id={`${tabsId}-panel`}
        role="tabpanel"
        aria-labelledby={`${tabsId}-${tab}`}
        className={styles.content}
      >
        {tab === 'tasks' ? tasks : tab === 'night' ? night : personal}
      </div>
    </aside>
  )
}

/**
 * What waits on you: the night's entries still undecided, and the open tasks of any campaign
 * waiting for your Gate 2 but those entries'.
 */
function waitingOnYou(registry: Registry, diary: NightDiary | null) {
  const night = diary?.entries.filter((entry) => nightUndecided(entry, registry.campaigns)) ?? []
  const listed = new Set(night.map((entry) => entry.task))
  const gate2 = registry.campaigns.flatMap((campaign) =>
    campaign.tasks
      .filter(
        (task) =>
          // Done, or back in the queue for the next night: not waiting for the Gate 2.
          task.state !== 'concluída' &&
          task.state !== 'pronta' &&
          task.result?.startsWith(GATE_2_RESULT) &&
          !listed.has(task.id),
      )
      .map((task) => ({ task, campaign })),
  )
  return { night, gate2 }
}

/** A part of the header bar; `more` when its campaign still has tasks to find. */
type ProgressPart = { name: string | null; done: number; total: number; more: boolean }

/**
 * The header bar: one segment per part, as wide as its total and filled to its share done, then
 * the summed count. A single part is a single bar.
 */
function ProgressBar({ parts }: { parts: ProgressPart[] }) {
  const done = parts.reduce((sum, part) => sum + part.done, 0)
  const total = parts.reduce((sum, part) => sum + part.total, 0)
  const more = parts.some((part) => part.more) ? '+?' : ''
  const label = (part: ProgressPart) =>
    part.name === null
      ? undefined
      : `${part.name} · ${part.done}/${part.total}${part.more ? '+?' : ''}`
  const labels = parts.map(label).filter(Boolean)
  return (
    <div
      className={styles.progress}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-valuetext={labels.length > 0 ? labels.join(', ') : undefined}
    >
      <span className={styles.progressSegments}>
        {parts.map((part, index) => (
          <span
            key={part.name ?? index}
            className={styles.progressTrack}
            title={label(part)}
            style={parts.length > 1 ? { flexGrow: part.total } : undefined}
          >
            <span
              className={styles.progressFill}
              style={{
                width: `${part.total > 0 ? Math.round((part.done / part.total) * 100) : 0}%`,
              }}
            />
          </span>
        ))}
      </span>
      <span className={styles.progressCount}>{`${done} / ${total}${more}`}</span>
    </div>
  )
}

/**
 * What waits on you, hidden when nothing does: the night's undecided entries, each dated with its
 * night, and the tasks waiting for your Gate 2.
 */
function PendingSection({
  registry,
  diary,
  night,
  gate2,
  edits,
  workers,
  sources,
  away,
  questions,
}: {
  registry: Registry
  diary: NightDiary | null
  night: NightEntry[]
  gate2: Array<{ task: CampaignTask; campaign: Campaign }>
  edits: CampaignEdits
  workers: ReadonlyMap<string, TaskWorkers>
  sources: DetailSources | null
  /** Where the focus goes once the last decision took Pending away. */
  away: RefObject<HTMLButtonElement>
  /** The questions campaigns' agents wait on: answered in their terminals. */
  questions: Array<{ campaign: Campaign; text: string }>
}) {
  const t = useT()
  const locale = useProjectsStore((state) => state.preferences.language)
  const [open, setOpen] = useState(true)
  const [gate2Open, setGate2Open] = useState(true)
  const toggle = useRef<HTMLButtonElement>(null)
  const gate2Toggle = useRef<HTMLButtonElement>(null)
  const count = questions.length + night.length + gate2.length
  if (count === 0) return null
  return (
    <section className={styles.section}>
      <SectionToggle
        name={t('todo.pending.title')}
        count={count}
        open={open}
        onToggle={() => setOpen((current) => !current)}
        toggleRef={toggle}
        extra={<span className={campaignStyles.meta}>{t('todo.pending.hint')}</span>}
      />
      {open ? (
        <div className={campaignStyles.groups}>
          {questions.length > 0 ? (
            <ul className={campaignStyles.tasks} aria-label={t('todo.pending.questions')}>
              {questions.map(({ campaign, text }) => (
                <li key={campaign.id} className={campaignStyles.nightEntry} data-lane="queued">
                  <span
                    className={campaignStyles.dot}
                    role="img"
                    aria-label={t('todo.night.resultWaiting')}
                  />
                  <span className={campaignStyles.id}>{campaign.id}</span>
                  <span className={campaignStyles.taskTitle} title={text}>
                    {text}
                  </span>
                  <button
                    type="button"
                    className={`${controlStyles.btn} ${controlStyles.btnSm}`}
                    onClick={() =>
                      continueCampaign(registry.projectId, campaign) ||
                      requestCampaignSession(registry.projectId, campaign, registry)
                    }
                  >
                    {t('todo.campaignControls.goToTab')}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {diary && night.length > 0 ? (
            <ul className={campaignStyles.tasks}>
              {night.map((entry, index) => (
                <NightEntryRow
                  key={`${entry.task}-${index}`}
                  entry={entry}
                  registry={registry}
                  edits={edits}
                  night={t('todo.pending.night', { date: nightDay(diary.date, locale) })}
                  // A decided entry leaves Pending: the focus goes to its header.
                  fallback={() => toggle.current ?? away.current}
                />
              ))}
            </ul>
          ) : null}
          {gate2.length > 0 ? (
            <div
              role="group"
              aria-label={t('todo.pending.gate2')}
              className={`${styles.list} ${campaignStyles.group}`}
            >
              <SectionToggle
                name={t('todo.pending.gate2')}
                count={gate2.length}
                open={gate2Open}
                onToggle={() => setGate2Open((current) => !current)}
                variant="sub"
                toggleRef={gate2Toggle}
              />
              {gate2Open
                ? gate2.map(({ task, campaign }) => (
                    <Gate2Row
                      key={task.id}
                      task={task}
                      campaign={campaign}
                      registry={registry}
                      edits={edits}
                      workers={workers}
                      sources={sources}
                      // A decided task leaves the group: the focus goes to its header, or to
                      // Pending once the group went too.
                      fallback={() => gate2Toggle.current ?? toggle.current ?? away.current}
                    />
                  ))
                : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

type AddField = {
  /** The campaign whose field + or Ctrl+N shows, if any. */
  shown: string | null
  reveal: (campaignId: string) => void
  /** Hides the field again. */
  leave: () => void
  /** Each campaign's input, for Ctrl+N to focus. */
  inputs: Map<string, HTMLInputElement>
  draft: (campaignId: string) => string
  setDraft: (campaignId: string, text: string) => void
}

/**
 * The live campaigns not finished, each in its own subsection: its controls, its add field once
 * asked for, its open tasks but those Pending lists, each with its step, and its done ones
 * collapsed at its end. A campaign with a tab open goes to it, and pauses while its agent works (the
 * same rule as the Campaigns map's dot); one live through its workers alone continues in a new tab.
 * Either can be cancelled.
 */
function ActiveSection({
  campaigns,
  registry,
  live,
  edits,
  workers,
  sources,
  pending,
  tails,
  once,
  busy,
  collapsed,
  onToggle,
  addField,
}: {
  campaigns: Campaign[]
  registry: Registry
  live: ReadonlyMap<string, CampaignLive>
  edits: CampaignEdits
  workers: ReadonlyMap<string, TaskWorkers>
  sources: DetailSources | null
  /** The tasks Pending lists, left out here. */
  pending: ReadonlySet<string>
  /** What each campaign's agent last said. */
  tails: ReadonlyMap<string, AgentTail>
  /** Runs a control unless another one is running. */
  once: (action: () => Promise<void>) => () => void
  /** A control is running: the controls are disabled. */
  busy: boolean
  /** The collapsed keys: the section's own and its campaigns'. */
  collapsed: ReadonlySet<string>
  onToggle: (key: string) => void
  addField: AddField
}) {
  const t = useT()
  const pushToast = useUiStore((state) => state.pushToast)
  const hint = useId()
  const { projectId, path } = registry
  // The campaigns with a tab open, as a string so a change elsewhere does not re-render the list;
  // one live through a worker alone has no tab to go to.
  const withTab = useProjectsStore((state) =>
    (state.projects.find((project) => project.id === projectId)?.terminals ?? [])
      .flatMap((terminal) => terminal.tabs.flatMap((tab) => tab.campaignId ?? []))
      .join('\n'),
  ).split('\n')

  const resume = async (item: Campaign) => {
    const task = resumeTask(item)
    if (!task) return
    const { id } = item
    try {
      await resumeCampaign(projectId, item, registry, task)
    } catch (error) {
      pushToast({
        title: t('todo.campaignControls.continue'),
        body: t('todo.campaignControls.sendFailed', { id, message: String(error) }),
      })
    }
  }
  const cancel = async (item: Campaign) => {
    const { id } = item
    const agreed = await askConfirm(t('todo.campaignControls.cancelConfirm', { id }), {
      title: t('todo.campaignControls.cancel'),
      kind: 'warning',
      okLabel: t('todo.campaignControls.cancel'),
      cancelLabel: t('todo.campaignControls.keep'),
    })
    if (!agreed) return
    let done: CampaignCancel
    try {
      done = await cancelCampaign(projectId, item, registry)
    } catch (error) {
      pushToast({
        title: t('todo.campaignControls.cancel'),
        body: t('todo.campaignControls.cancelFailed', { message: String(error) }),
      })
      return
    }
    const { tabs, jobs, live } = done
    // A refused write says why in its own toast; the summary then counts no task.
    const tasks = (await edits.release(path, id, live)) ?? 0
    pushToast({
      title: t('todo.campaignControls.cancelledTitle', { id }),
      body:
        live.length > 0
          ? t('todo.campaignControls.cancelledPartly', { tabs, jobs, tasks, ids: live.join(', ') })
          : t('todo.campaignControls.cancelled', { tabs, jobs, tasks }),
    })
  }
  const disabled = edits.busy || busy

  const controls = (item: Campaign, index: number) => {
    const task = resumeTask(item)
    const describedBy = `${hint}${index}`
    const hasTab = withTab.includes(item.id)
    // Short labels keep the row on one line; the name and tooltip say the whole action.
    const named = (key: MessageKey) => ({ 'aria-label': t(key), title: t(key) })
    const button = `${controlStyles.btn} ${controlStyles.btnSm} ${styles.controlButton}`
    return (
      <div className={styles.controlRow}>
        {hasTab ? (
          <button
            type="button"
            className={button}
            onClick={() =>
              continueCampaign(projectId, item) || requestCampaignSession(projectId, item, registry)
            }
            {...named('todo.campaignControls.goToTab')}
          >
            <SquareTerminal size={11} aria-hidden />
            {t('todo.campaignControls.goToTab')}
          </button>
        ) : (
          <button
            type="button"
            className={button}
            onClick={once(() => resume(item))}
            disabled={disabled || !task}
            aria-describedby={task ? undefined : describedBy}
            {...named('todo.campaignControls.continue')}
          >
            <Play size={11} aria-hidden />
            {t('todo.campaignControls.continueShort')}
          </button>
        )}
        {hasTab && live.get(item.id) === 'working' ? (
          <button
            type="button"
            className={button}
            data-tone="pause"
            onClick={once(() => pauseCampaign(projectId, item.id))}
            disabled={disabled}
            {...named('todo.campaignControls.pause')}
          >
            <Pause size={11} aria-hidden />
            {t('todo.campaignControls.pauseShort')}
          </button>
        ) : null}
        <button
          type="button"
          className={`${button} ${controlStyles.btnSmDanger}`}
          onClick={once(() => cancel(item))}
          disabled={disabled}
          {...named('todo.campaignControls.cancel')}
        >
          <Square size={11} aria-hidden />
          {t('todo.campaignControls.cancelShort')}
        </button>
        {hasTab || task ? null : (
          <span id={describedBy} className={campaignStyles.meta}>
            {t('todo.campaignControls.allDone')}
          </span>
        )}
      </div>
    )
  }
  const open = !collapsed.has(ACTIVE_SECTION)

  return (
    <section className={styles.section}>
      <SectionToggle
        name={t('todo.activeSection')}
        count={campaigns.length}
        open={open}
        onToggle={() => onToggle(ACTIVE_SECTION)}
      />
      {!open ? null : campaigns.length === 0 ? (
        <p className={styles.sectionEmpty}>{t('todo.activeEmpty')}</p>
      ) : (
        <div className={campaignStyles.groups}>
          {campaigns.map((campaign, index) => (
            <ActiveCampaign
              key={campaign.id}
              campaign={campaign}
              registry={registry}
              edits={edits}
              workers={workers}
              sources={sources}
              pending={pending}
              open={!collapsed.has(campaignKey(campaign.id))}
              onToggle={() => onToggle(campaignKey(campaign.id))}
              controls={controls(campaign, index)}
              agentMessage={tails.get(campaign.id)?.message ?? null}
              onAdd={() => addField.reveal(campaign.id)}
              field={
                addField.shown !== campaign.id ? null : (
                  <CampaignAddField
                    campaign={campaign}
                    edits={edits}
                    title={addField.draft(campaign.id)}
                    onTitle={(text) => addField.setDraft(campaign.id, text)}
                    onLeave={addField.leave}
                    inputRef={(node) => {
                      if (node) addField.inputs.set(campaign.id, node)
                      else addField.inputs.delete(campaign.id)
                    }}
                  />
                )
              }
            />
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * An active campaign's subsection, headed by its id, title, progress and live workers, its facts in
 * the header's tooltip and its + beside it.
 */
function ActiveCampaign({
  campaign,
  registry,
  edits,
  workers,
  sources,
  pending,
  open,
  onToggle,
  controls,
  agentMessage,
  onAdd,
  field,
}: {
  campaign: Campaign
  registry: Registry
  edits: CampaignEdits
  workers: ReadonlyMap<string, TaskWorkers>
  sources: DetailSources | null
  pending: ReadonlySet<string>
  open: boolean
  onToggle: () => void
  controls: ReactNode
  /** The last answer of its agent's tab, when it has one. */
  agentMessage: string | null
  /** Shows its add field. */
  onAdd: () => void
  field: ReactNode
}) {
  const t = useT()
  const facts = useCampaignFacts(campaign, registry.checkouts)
  const [doneOpen, setDoneOpen] = useState(false)
  const openTasks = campaignTaskView(campaign.tasks, 'active').filter(
    (task) => !pending.has(task.id),
  )
  const doneTasks = campaignTaskView(campaign.tasks, 'completed')
  const inPending = campaign.tasks.filter((task) => pending.has(task.id)).length
  const liveWorkers = workersLabel(
    t,
    campaignWorkers(
      campaign.tasks.map((task) => task.id),
      workers,
    ),
  )
  const row = (task: CampaignTask, step = false) => (
    <CampaignTaskRow
      key={task.id}
      task={task}
      edits={edits}
      workers={workers}
      sources={sources}
      step={step}
    />
  )
  const add = t('todo.campaignAddPlaceholder', { id: campaign.id })
  return (
    <div role="group" aria-label={campaign.id} className={`${styles.list} ${campaignStyles.group}`}>
      <SectionToggle
        name={campaign.title ? `${campaign.id} · ${campaign.title}` : campaign.id}
        count={`${campaign.done}/${campaign.total}${campaign.decomposed ? '' : '+?'}`}
        open={open}
        onToggle={onToggle}
        variant="sub"
        title={[facts.window, facts.worktree, facts.updated, situationLabel(t, campaign.situation)]
          .filter(Boolean)
          .join(' · ')}
        extra={
          <>
            {useTodosStore.getState().activeCampaigns[registry.projectId] === campaign.id ? (
              <span className={campaignStyles.chip}>{t('todo.campaigns.lastActive')}</span>
            ) : null}
            {liveWorkers ? <span className={campaignStyles.workers}>{liveWorkers}</span> : null}
          </>
        }
      >
        <button
          type="button"
          className={styles.sectionAdd}
          onClick={onAdd}
          title={add}
          aria-label={add}
        >
          <Plus size={13} />
        </button>
      </SectionToggle>
      {open ? (
        <>
          {controls}
          <CampaignDependencies
            campaign={campaign}
            campaigns={registry.campaigns}
            edits={edits}
            source={registry.text}
          />
          {agentMessage ? (
            <span className={`${styles.detailMeta} ${styles.todoTitleText}`} title={agentMessage}>
              {t('todo.agentLabel')} {agentMessage}
            </span>
          ) : null}
          {field}
          {openTasks.length > 0 ? (
            openTasks.map((task) => row(task, true))
          ) : (
            <p className={styles.filterEmpty}>{t('todo.campaignEmpty')}</p>
          )}
          {inPending > 0 ? (
            <span className={campaignStyles.meta}>
              {t('todo.campaigns.inPending', { count: inPending })}
            </span>
          ) : null}
          {doneTasks.length > 0 ? (
            <>
              <SectionToggle
                name={t('todo.activeDone', { count: doneTasks.length })}
                count={null}
                open={doneOpen}
                onToggle={() => setDoneOpen((current) => !current)}
                variant="sub"
              />
              {doneOpen ? doneTasks.map((task) => row(task)) : null}
            </>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

/** A campaign's add field: a task added here goes to the registry with the campaign's next id. */
function CampaignAddField({
  campaign,
  edits,
  title,
  onTitle,
  onLeave,
  inputRef,
}: {
  campaign: Campaign
  edits: CampaignEdits
  /** Its draft, kept by the caller across a switch of tab. */
  title: string
  onTitle: (text: string) => void
  /** Left empty, or once its task is added. */
  onLeave: () => void
  inputRef: (node: HTMLInputElement | null) => void
}) {
  const t = useT()
  const placeholder = t('todo.campaignAddPlaceholder', { id: campaign.id })
  return (
    <form
      className={styles.addForm}
      onSubmit={(event) => {
        event.preventDefault()
        void edits.add(campaign, title).then((added) => {
          if (!added) return
          onTitle('')
          onLeave()
        })
      }}
    >
      <div className={styles.composerBox}>
        <button
          type="submit"
          className={styles.composerSubmit}
          disabled={!title.trim() || edits.busy}
          title={t('todo.add')}
          aria-label={t('todo.add')}
        >
          <Plus size={15} />
        </button>
        <input
          ref={inputRef}
          className={styles.composerInput}
          value={title}
          // A campaign title is checked in code points on submit; maxLength counts UTF-16 units.
          onChange={(event) => onTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !title.trim()) onLeave()
          }}
          onBlur={() => {
            if (!title.trim()) onLeave()
          }}
          placeholder={placeholder}
          aria-label={placeholder}
        />
        <kbd className={styles.composerShortcut}>{formatShortcut('Ctrl+N')}</kbd>
      </div>
    </form>
  )
}

/** A task waiting for your Gate 2: its row opens a night entry's actions for it. */
function Gate2Row({
  task,
  campaign,
  registry,
  edits,
  workers,
  sources,
  fallback,
}: {
  task: CampaignTask
  campaign: Campaign
  registry: Registry
  edits: CampaignEdits
  workers: ReadonlyMap<string, TaskWorkers>
  sources: DetailSources | null
  fallback: () => HTMLElement | null
}) {
  const actions = useTaskActions({
    taskId: task.id,
    campaign,
    registry,
    edits,
    conclude: () => edits.conclude(task.id, task.evidence ?? undefined),
    evidence: task.evidence,
    requeue: task.window === 'noite',
    fallback,
  })
  return (
    <CampaignTaskRow
      task={task}
      campaignId={campaign.id}
      edits={edits}
      workers={workers}
      sources={sources}
      actions={actions}
    />
  )
}

/**
 * A registry task as a Todo row: its box checks it done, with an undo, and its chevron shows its
 * read-only detail under it.
 */
function CampaignTaskRow({
  task,
  campaignId,
  edits,
  workers,
  sources,
  actions,
  step = false,
}: {
  task: CampaignTask
  /** Shown in place of its state, where the list mixes campaigns. */
  campaignId?: string
  edits: CampaignEdits
  workers: ReadonlyMap<string, TaskWorkers>
  /** What its detail reads; without them it has no detail. */
  sources: DetailSources | null
  /** Its id and title open these. */
  actions?: TaskActions
  /** Shows its result, the step it is at, under its title while it is open. */
  step?: boolean
}) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const detailId = useId()
  const detailLabel = t('todo.taskDetail.toggle', { id: task.id })
  const done = task.state === 'concluída'
  const undoable = done && edits.undoable(task.id)
  // A task done elsewhere has no state here to go back to.
  const label = t(done ? (undoable ? 'todo.reopen' : STATE_KEYS[task.state]) : 'todo.complete')
  const live = workersLabel(t, workers.get(task.id))
  // Through its steps when it has them, its result in the tooltip; else its result.
  const progress = stepProgress(task)
  const stepLine =
    progress.total === 0
      ? task.result
      : progress.current === null
        ? `${progress.total}/${progress.total}`
        : `${progress.done}/${progress.total} · ${progress.current}`
  const title = (
    <>
      <span className={campaignStyles.id}>{task.id}</span>{' '}
      <span className={styles.todoTitleText}>{task.title}</span>
      {live ? <span className={campaignStyles.workers}>{live}</span> : null}
    </>
  )
  return (
    <div
      data-task={task.id}
      className={`${styles.todoRow} ${done ? styles.todoRowCompleted : ''}`}
      onKeyDown={actions?.onKeyDown}
    >
      {sources ? (
        <button
          type="button"
          className={styles.detailToggle}
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          aria-controls={expanded ? detailId : undefined}
          aria-label={detailLabel}
          title={detailLabel}
        >
          <ChevronDown
            size={12}
            className={`${styles.sectionChevron} ${expanded ? '' : styles.sectionChevronClosed}`}
          />
        </button>
      ) : (
        <span aria-hidden />
      )}
      <button
        type="button"
        className={styles.checkButton}
        onClick={() => void edits.toggle(task)}
        disabled={edits.busy || (done && !undoable)}
        title={label}
        aria-label={label}
      >
        {done ? <Check size={12} /> : null}
      </button>
      {actions ? (
        <button type="button" className={styles.todoTitle} title={task.title} {...actions.toggle}>
          {title}
        </button>
      ) : (
        <div className={styles.todoTitle} title={task.title}>
          {title}
        </div>
      )}
      {campaignId ? (
        <span className={campaignStyles.id}>{campaignId}</span>
      ) : done ? null : (
        <span className={campaignStyles.chip} data-lane={TASK_LANES[task.state]}>
          {t(STATE_KEYS[task.state])}
        </span>
      )}
      {step && !done && stepLine ? (
        <span
          className={`${styles.detailMeta} ${styles.todoTitleText} ${styles.stepLine}`}
          title={task.result ?? stepLine}
        >
          {stepLine}
        </span>
      ) : null}
      {actions?.menu}
      {expanded && sources ? <TaskDetail id={detailId} task={task} sources={sources} /> : null}
    </div>
  )
}

function ProjectPicker({
  value,
  projects,
  noProjectLabel,
  ariaLabel,
  compact = false,
  onChange,
}: {
  value: string
  projects: Array<{ id: string; name: string }>
  noProjectLabel: string
  ariaLabel: string
  compact?: boolean
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0, width: 240 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const selectedLabel = projects.find((project) => project.id === value)?.name ?? noProjectLabel

  useEffect(() => {
    if (!open) return
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false)
      }
    }
    document.addEventListener('click', closeOnOutsideClick)
    return () => document.removeEventListener('click', closeOnOutsideClick)
  }, [open])

  useEffect(() => {
    if (!open) return
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(300, Math.max(220, rect.width), window.innerWidth - 16)
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
      const estimatedHeight = Math.min(240, (projects.length + 1) * 32 + 8)
      const roomBelow = window.innerHeight - rect.bottom - 8
      const top =
        roomBelow >= Math.min(estimatedHeight, 180)
          ? rect.bottom + 5
          : Math.max(8, rect.top - estimatedHeight - 5)
      setMenuPosition({ left, top, width })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open, projects.length])

  const choose = (nextValue: string) => {
    onChange(nextValue)
    setOpen(false)
  }

  return (
    <div className={compact ? styles.projectLink : styles.projectInputWrap}>
      <FolderKanban size={compact ? 11 : 13} aria-hidden="true" />
      <button
        ref={triggerRef}
        type="button"
        className={styles.projectPickerButton}
        aria-label={ariaLabel}
        aria-expanded={open}
        title={selectedLabel}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((current) => !current)
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <span>{selectedLabel}</span>
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              className={styles.projectMenu}
              role="listbox"
              aria-label={ariaLabel}
              style={menuPosition}
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                role="option"
                aria-selected={!value}
                className={`${styles.projectOption} ${!value ? styles.projectOptionSelected : ''}`}
                onClick={(event) => {
                  event.stopPropagation()
                  choose('')
                }}
              >
                {noProjectLabel}
              </button>
              {projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  role="option"
                  aria-selected={project.id === value}
                  className={`${styles.projectOption} ${project.id === value ? styles.projectOptionSelected : ''}`}
                  title={project.name}
                  onClick={(event) => {
                    event.stopPropagation()
                    choose(project.id)
                  }}
                >
                  {project.name}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}

function parseTags(value: string): string[] {
  return value
    .split(/[,#\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
}
