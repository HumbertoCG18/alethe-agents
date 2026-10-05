import {
  Check,
  ExternalLink,
  Eye,
  EyeOff,
  FolderKanban,
  GripVertical,
  ListTodo,
  Pause,
  Pencil,
  Play,
  Plus,
  Settings,
  Square,
  Tag,
  Trash2,
  X,
} from 'lucide-react'
import { type RefObject, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

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
  type NightDiary,
  resumeTask,
  type TaskWorkers,
} from '../../lib/campaigns'
import { askConfirm } from '../../lib/dialog'
import { useT } from '../../lib/i18n'
import { formatShortcut } from '../../lib/platform'
import { type PlanningStatus, readPlanningStatus } from '../../lib/tauri'
import { TODO_TITLE_MAX_LENGTH } from '../../lib/todos'
import type { Terminal, TodoItem } from '../../lib/types'
import { selectActiveProject, useProjectsStore } from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useUiStore } from '../../stores/uiStore'
import { CampaignsSection } from './CampaignsSection'
import campaignStyles from './CampaignsSection.module.css'
import {
  type CampaignCancel,
  type CampaignEdits,
  campaignLiveStatus,
  cancelCampaign,
  nightUndecided,
  pauseCampaign,
  type Registry,
  resumeCampaign,
  STATE_KEYS,
  TASK_LANES,
  useCampaignEdits,
  useCampaignView,
  useNightDiary,
  useTaskWorkers,
  workersLabel,
} from './campaignView'
import { FindingsCard } from './FindingsCard'
import { TODO_SETTINGS_MODAL_ID } from './manifest'
import { NightCard, NightStatus } from './NightCard'
import { SectionToggle, SortableSections } from './SectionToggle'
import { orderedSections, useTodosStore } from './store'
import { type TaskActions, useTaskActions } from './taskActions'
import styles from './TodoSidebar.module.css'

/** The key of the active campaign's section among the collapsed ones. */
const CAMPAIGN_SECTION = 'campaign'

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
  const [filter, setFilter] = useState<'all' | 'active' | 'completed'>('all')
  const [composerExpanded, setComposerExpanded] = useState(false)
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    () => new Set(['completed']),
  )
  const addInputRef = useRef<HTMLInputElement>(null)
  const view = useCampaignView()
  const edits = useCampaignEdits(view)
  const workers = useTaskWorkers(view.registry)
  const diary = useNightDiary(view.registry?.main ?? null)
  // The night card's header, wherever the card is: Pending focuses it after moving it away.
  const nightToggle = useRef<HTMLButtonElement>(null)
  const listSource = useTodosStore((state) => state.listSource)
  const savedOrder = useTodosStore((state) =>
    view.projectId ? state.sectionOrder[view.projectId] : undefined,
  )
  const setSectionOrder = useTodosStore((state) => state.setSectionOrder)
  const addFieldHidden = useTodosStore((state) =>
    view.projectId ? state.addFieldHidden[view.projectId] === true : false,
  )
  const setAddFieldHidden = useTodosStore((state) => state.setAddFieldHidden)
  // Ctrl+N shows a hidden add field for one task: until it is added, or left empty. It belongs to
  // the project it was shown in, so switching projects does not carry it over.
  const [addFieldShownFor, setAddFieldShownFor] = useState<string | null>(null)
  const addFieldShown = addFieldShownFor !== null && addFieldShownFor === view.projectId
  // The Ctrl+N listener is installed once: it reads the project through this ref.
  const projectIdRef = useRef(view.projectId)
  projectIdRef.current = view.projectId
  const setAddFieldShown = (shown: boolean) =>
    setAddFieldShownFor(shown ? (projectIdRef.current ?? null) : null)
  // The source picked in this project (a campaign id, or null for the personal list).
  const [picked, setPicked] = useState<{ projectId: string | null; id: string | null } | null>(null)
  const campaigns = view.registry?.campaigns ?? []
  const fallback =
    listSource === 'campaign'
      ? (view.activeId ??
        campaigns.find((campaign) => campaign.situation.kind !== 'done')?.id ??
        null)
      : null
  const sourceId = picked && picked.projectId === view.projectId ? picked.id : fallback
  const campaign = campaigns.find((item) => item.id === sourceId) ?? null
  const pickSource = (id: string | null) => setPicked({ projectId: view.projectId, id })
  const addPlaceholder = campaign
    ? t('todo.campaignAddPlaceholder', { id: campaign.id })
    : t('todo.addPlaceholder')

  const active = todos.filter((todo) => !todo.completed)
  const completed = todos.filter((todo) => todo.completed)
  const progress = campaign
    ? {
        done: campaign.done,
        total: campaign.total,
        percent: campaign.percent,
        label: `${campaign.done} / ${campaign.total}${campaign.decomposed ? '' : '+?'}`,
      }
    : {
        done: completed.length,
        total: todos.length,
        percent: todos.length > 0 ? Math.round((completed.length / todos.length) * 100) : 0,
        label: `${completed.length} / ${todos.length}`,
      }
  const activeProjectSections = projects
    .map((project) => ({
      key: `project:${project.id}`,
      label: project.name,
      projectId: project.id,
      iconUrl: project.iconUrl,
      items: active.filter((todo) => todo.projectId === project.id),
    }))
    .filter((section) => section.items.length > 0)
  // A todo pointing at a deleted project belongs to no section, so it would be
  // invisible while still counting towards the progress bar.
  const knownProjectIds = new Set(projects.map((project) => project.id))
  const unassigned = active.filter(
    (todo) => !todo.projectId || !knownProjectIds.has(todo.projectId),
  )

  useEffect(() => {
    const focusComposer = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== 'n') return
      event.preventDefault()
      setComposerExpanded(true)
      setAddFieldShownFor(projectIdRef.current ?? null)
      // A campaign's add field sits in its section, which may be collapsed or hide the field.
      setCollapsedSections((current) => {
        const next = new Set(current)
        return next.delete(CAMPAIGN_SECTION) ? next : current
      })
      window.requestAnimationFrame(() => addInputRef.current?.focus())
    }
    window.addEventListener('keydown', focusComposer, true)
    return () => window.removeEventListener('keydown', focusComposer, true)
  }, [])

  const submit = async () => {
    if (campaign) {
      if (!(await edits.add(campaign, title))) return
      setTitle('')
      setComposerExpanded(false)
      setAddFieldShown(false)
      return
    }
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

  const startProjectTodo = (projectId = '') => {
    setProjectDraft(projectId)
    setComposerExpanded(true)
    window.requestAnimationFrame(() => addInputRef.current?.focus())
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

  const renderSection = ({
    key,
    label,
    items,
    completedSection = false,
    projectId,
    iconUrl,
  }: {
    key: string
    label: string
    items: TodoItem[]
    completedSection?: boolean
    projectId?: string
    iconUrl?: string
  }) => {
    const collapsed = collapsedSections.has(key)
    return (
      <section key={key} className={styles.section}>
        <SectionToggle
          name={label}
          count={items.length}
          open={!collapsed}
          onToggle={() => toggleSection(key)}
          icon={iconUrl ? <img src={iconUrl} alt="" className={styles.sectionIcon} /> : null}
        >
          {!completedSection ? (
            <button
              type="button"
              className={styles.sectionAdd}
              onClick={() => startProjectTodo(projectId)}
              title={t('todo.add')}
              aria-label={t('todo.add')}
            >
              <Plus size={13} />
            </button>
          ) : null}
        </SectionToggle>
        {!collapsed && items.length > 0 ? (
          <div className={styles.list}>
            {items.map((todo) => {
              const editing = editingId === todo.id
              return (
                <div
                  key={todo.id}
                  className={[
                    styles.todoRow,
                    todo.completed ? styles.todoRowCompleted : '',
                    draggedId === todo.id ? styles.todoRowDragging : '',
                    dropTargetId === todo.id && draggedId !== todo.id
                      ? styles.todoRowDropTarget
                      : '',
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
            })}
          </div>
        ) : completedSection && todos.length > 0 ? (
          <p className={styles.sectionEmpty}>{t('todo.emptyCompleted')}</p>
        ) : null}
      </section>
    )
  }

  // In a campaign the tabs and the add field belong to its section, below the header.
  const filters = (
    <div className={styles.filters} role="tablist" aria-label={t('todo.filters')}>
      <button
        type="button"
        role="tab"
        aria-selected={filter === 'all'}
        className={`${styles.filterButton} ${filter === 'all' ? styles.filterButtonActive : ''}`}
        onClick={() => setFilter('all')}
      >
        {t('todo.all')}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={filter === 'active'}
        className={`${styles.filterButton} ${filter === 'active' ? styles.filterButtonActive : ''}`}
        onClick={() => setFilter('active')}
      >
        {t('todo.active')}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={filter === 'completed'}
        className={`${styles.filterButton} ${filter === 'completed' ? styles.filterButtonActive : ''}`}
        onClick={() => setFilter('completed')}
      >
        {t('todo.completed')}
      </button>
    </div>
  )
  const composer = (
    <form
      className={styles.addForm}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className={styles.composerBox}>
        <button
          type="submit"
          className={styles.composerSubmit}
          disabled={!title.trim() || (campaign !== null && edits.busy)}
          title={t('todo.add')}
          aria-label={t('todo.add')}
        >
          <Plus size={15} />
        </button>
        <input
          ref={addInputRef}
          className={styles.composerInput}
          value={title}
          // A campaign title is checked in code points on submit; maxLength counts UTF-16 units.
          maxLength={campaign ? undefined : TODO_TITLE_MAX_LENGTH}
          onFocus={() => setComposerExpanded(true)}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || title.trim()) return
            setComposerExpanded(false)
            setAddFieldShown(false)
          }}
          onBlur={() => {
            if (!title.trim()) setAddFieldShown(false)
          }}
          placeholder={addPlaceholder}
          aria-label={addPlaceholder}
        />
        <kbd className={styles.composerShortcut}>{formatShortcut('Ctrl+N')}</kbd>
      </div>
      {/* Tags and project belong to personal todos only. */}
      {composerExpanded && !campaign ? (
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

  // The active campaign's section, or your own list's sections.
  const list = (
    <>
      {filter !== 'completed' ? <GsdSyncSection /> : null}
      {campaign ? (
        <section className={styles.section}>
          <SectionToggle
            name={t('todo.activeSection', { id: campaign.id })}
            count={`${campaign.done}/${campaign.total}${campaign.decomposed ? '' : '+?'}`}
            open={!collapsedSections.has(CAMPAIGN_SECTION)}
            onToggle={() => toggleSection(CAMPAIGN_SECTION)}
          >
            <button
              type="button"
              className={styles.sectionAdd}
              onClick={() => {
                if (view.projectId) setAddFieldHidden(view.projectId, !addFieldHidden)
                setAddFieldShown(false)
              }}
              title={t(addFieldHidden ? 'todo.addFieldShow' : 'todo.addFieldHide')}
              aria-label={t(addFieldHidden ? 'todo.addFieldShow' : 'todo.addFieldHide')}
            >
              {addFieldHidden ? <Eye size={13} /> : <EyeOff size={13} />}
            </button>
          </SectionToggle>
          {collapsedSections.has(CAMPAIGN_SECTION) ? null : (
            <>
              {filters}
              {addFieldHidden && !addFieldShown ? null : composer}
              {view.registry ? (
                <CampaignControls
                  campaign={campaign}
                  registry={view.registry}
                  edits={edits}
                  workers={workers}
                />
              ) : null}
              <CampaignTaskRows
                campaign={campaign}
                filter={filter}
                edits={edits}
                workers={workers}
              />
            </>
          )}
        </section>
      ) : todos.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>
            <ListTodo size={20} />
          </div>
          <strong>{t('todo.emptyTitle')}</strong>
          <span>{t('todo.emptyDescription')}</span>
        </div>
      ) : (
        <>
          {filter !== 'completed'
            ? activeProjectSections.map((section) => renderSection(section))
            : null}
          {filter !== 'completed' && unassigned.length > 0
            ? renderSection({
                key: 'unassigned',
                label: t('todo.noProject'),
                items: unassigned,
              })
            : null}
          {filter !== 'active'
            ? renderSection({
                key: 'completed',
                label: t('todo.completed'),
                items: completed,
                completedSection: true,
              })
            : null}
          {filter === 'active' && active.length === 0 ? (
            <p className={styles.filterEmpty}>{t('todo.emptyTitle')}</p>
          ) : null}
        </>
      )}
    </>
  )

  return (
    <aside className={styles.sidebar} aria-label={t('todo.title')}>
      <header className={styles.header}>
        <div className={styles.headerTop}>
          <div className={styles.heading}>
            <ListTodo size={17} />
            {campaigns.length > 0 ? (
              <ProjectPicker
                heading
                value={campaign?.id ?? ''}
                projects={campaigns.map((item) => ({ id: item.id, name: item.id }))}
                noProjectLabel={t('todo.personalTitle')}
                ariaLabel={t('todo.sourceLabel')}
                onChange={(id) => pickSource(id || null)}
              />
            ) : (
              <span>{t('todo.personalTitle')}</span>
            )}
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
        <div
          className={styles.progress}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.done}
        >
          <span className={styles.progressTrack}>
            <span className={styles.progressFill} style={{ width: `${progress.percent}%` }} />
          </span>
          <span className={styles.progressCount}>{progress.label}</span>
        </div>
        {campaign ? null : filters}
      </header>

      {campaign ? null : composer}

      <div className={styles.content}>
        <NightStatus projectId={view.projectId} />
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
                  edits={edits}
                  workers={workers}
                  nightToggle={nightToggle}
                />
              ),
            },
            // Your own list spans several sections: it has no handle, the others move around it.
            list: { node: list, fixed: !campaign },
            campaigns: {
              node: <CampaignsSection view={view} workers={workers} onSelect={pickSource} />,
            },
            findings: { node: <FindingsCard registry={view.registry} /> },
            // A night with nothing left waiting on you is read after the map.
            night: {
              node:
                view.registry &&
                diary &&
                !diary.entries.some((entry) => nightUndecided(entry, campaigns)) ? (
                  <NightCard
                    registry={view.registry}
                    diary={diary}
                    edits={edits}
                    toggleRef={nightToggle}
                  />
                ) : null,
            },
          }}
        />
      </div>
    </aside>
  )
}

/**
 * What waits on you, hidden when nothing does: the night's card while some of its entries are
 * undecided, and the open tasks of any campaign waiting for your Gate 2 that it does not list.
 */
function PendingSection({
  registry,
  diary,
  edits,
  workers,
  nightToggle,
}: {
  registry: Registry | null
  diary: NightDiary | null
  edits: CampaignEdits
  workers: ReadonlyMap<string, TaskWorkers>
  nightToggle: RefObject<HTMLButtonElement>
}) {
  const t = useT()
  const [open, setOpen] = useState(true)
  const [gate2Open, setGate2Open] = useState(true)
  const toggle = useRef<HTMLButtonElement>(null)
  const gate2Toggle = useRef<HTMLButtonElement>(null)
  if (!registry) return null
  const waiting = diary?.entries.filter((entry) => nightUndecided(entry, registry.campaigns)) ?? []
  // While the night card sits here it lists the whole night: a task in it is not listed twice.
  const inNight = new Set(waiting.length > 0 ? diary?.entries.map((entry) => entry.task) : [])
  const gate2 = registry.campaigns.flatMap((campaign) =>
    campaign.tasks
      .filter(
        (task) =>
          // Done, or back in the queue for the next night: not waiting for the Gate 2.
          task.state !== 'concluída' &&
          task.state !== 'pronta' &&
          task.result?.startsWith(GATE_2_RESULT) &&
          !inNight.has(task.id),
      )
      .map((task) => ({ task, campaign })),
  )
  const count = waiting.length + gate2.length
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
          {diary && waiting.length > 0 ? (
            <NightCard
              registry={registry}
              diary={diary}
              edits={edits}
              nested
              // Deciding its last entry moves the card after the map: focus stays in Pending
              // while it is there, else follows the card.
              focusAway={() => toggle.current ?? nightToggle.current}
            />
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
                      // A decided task leaves the group: the focus goes to its header, or to
                      // Pending once the group went too.
                      fallback={() => gate2Toggle.current ?? toggle.current}
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

// Stable fallback, so the selector below returns the same value while nothing changes.
const NO_TERMINALS: Terminal[] = []

/**
 * The selected campaign's controls, collapsed under its add field: Continue while it is not
 * running (the same rule as the Campaigns map's dot), else Pause and Cancel.
 */
function CampaignControls({
  campaign,
  registry,
  edits,
  workers,
}: {
  campaign: Campaign
  registry: Registry
  edits: CampaignEdits
  workers: ReadonlyMap<string, TaskWorkers>
}) {
  const t = useT()
  const pushToast = useUiStore((state) => state.pushToast)
  const [open, setOpen] = useState(false)
  // One control at a time: the ref is set before any await, so a second click cannot slip in.
  const acting = useRef(false)
  const [busy, setBusy] = useState(false)
  const hint = useId()
  const { projectId, path } = registry
  const { id } = campaign
  const terminals = useProjectsStore(
    (state) =>
      state.projects.find((project) => project.id === projectId)?.terminals ?? NO_TERMINALS,
  )
  // A boolean, so output on a pty does not re-render the list.
  const running = useTerminalsStore(
    (state) =>
      campaignLiveStatus([campaign], terminals, state.byPtyId, workers).get(id) === 'working',
  )
  const task = resumeTask(campaign)

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
  const resume = async () => {
    if (!task) return
    try {
      if (await resumeCampaign(projectId, campaign, registry, task)) return
      pushToast({
        title: t('todo.campaignControls.continue'),
        body: t('todo.campaignControls.leftInInput', { id }),
      })
    } catch (error) {
      pushToast({
        title: t('todo.campaignControls.continue'),
        body: t('todo.campaignControls.sendFailed', { id, message: String(error) }),
      })
    }
  }
  const cancel = async () => {
    const agreed = await askConfirm(t('todo.campaignControls.cancelConfirm', { id }), {
      title: t('todo.campaignControls.cancel'),
      kind: 'warning',
      okLabel: t('todo.campaignControls.cancel'),
      cancelLabel: t('todo.campaignControls.keep'),
    })
    if (!agreed) return
    let done: CampaignCancel
    try {
      done = await cancelCampaign(projectId, campaign, registry)
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

  return (
    <div
      role="group"
      aria-label={t('todo.campaignControls.title')}
      className={`${styles.list} ${styles.campaignControls}`}
    >
      <SectionToggle
        name={t('todo.campaignControls.title')}
        count={null}
        open={open}
        onToggle={() => setOpen((current) => !current)}
        variant="sub"
      />
      {open ? (
        <div className={styles.controlRow}>
          {running ? (
            <>
              <button
                type="button"
                className={styles.controlButton}
                data-tone="pause"
                onClick={once(() => pauseCampaign(projectId, id))}
                disabled={disabled}
              >
                <Pause size={11} aria-hidden />
                {t('todo.campaignControls.pause')}
              </button>
              <button
                type="button"
                className={styles.controlButton}
                data-tone="cancel"
                onClick={once(cancel)}
                disabled={disabled}
              >
                <Square size={11} aria-hidden />
                {t('todo.campaignControls.cancel')}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={styles.controlButton}
                onClick={once(resume)}
                disabled={disabled || !task}
                aria-describedby={task ? undefined : hint}
              >
                <Play size={11} aria-hidden />
                {t('todo.campaignControls.continue')}
              </button>
              {task ? null : (
                <span id={hint} className={campaignStyles.meta}>
                  {t('todo.campaignControls.allDone')}
                </span>
              )}
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

/** The selected campaign's tasks for a list tab, in the Todo rows. */
function CampaignTaskRows({
  campaign,
  filter,
  edits,
  workers,
}: {
  campaign: Campaign
  filter: 'all' | 'active' | 'completed'
  edits: CampaignEdits
  workers: ReadonlyMap<string, TaskWorkers>
}) {
  const t = useT()
  const tasks = campaignTaskView(campaign.tasks, filter)
  if (tasks.length === 0) return <p className={styles.filterEmpty}>{t('todo.campaignEmpty')}</p>
  return (
    <div className={styles.list}>
      {tasks.map((task) => (
        <CampaignTaskRow key={task.id} task={task} edits={edits} workers={workers} />
      ))}
    </div>
  )
}

/** A task waiting for your Gate 2: its row opens a night entry's actions for it. */
function Gate2Row({
  task,
  campaign,
  registry,
  edits,
  workers,
  fallback,
}: {
  task: CampaignTask
  campaign: Campaign
  registry: Registry
  edits: CampaignEdits
  workers: ReadonlyMap<string, TaskWorkers>
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
      actions={actions}
    />
  )
}

/** A registry task as a Todo row: its box checks it done, with an undo. */
function CampaignTaskRow({
  task,
  campaignId,
  edits,
  workers,
  actions,
}: {
  task: CampaignTask
  /** Shown in place of its state, where the list mixes campaigns. */
  campaignId?: string
  edits: CampaignEdits
  workers: ReadonlyMap<string, TaskWorkers>
  /** Its id and title open these. */
  actions?: TaskActions
}) {
  const t = useT()
  const done = task.state === 'concluída'
  const undoable = done && edits.undoable(task.id)
  // A task done elsewhere has no state here to go back to.
  const label = t(done ? (undoable ? 'todo.reopen' : STATE_KEYS[task.state]) : 'todo.complete')
  const live = workersLabel(t, workers.get(task.id))
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
      <span aria-hidden />
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
      {actions?.menu}
    </div>
  )
}

function ProjectPicker({
  value,
  projects,
  noProjectLabel,
  ariaLabel,
  compact = false,
  heading = false,
  onChange,
}: {
  value: string
  projects: Array<{ id: string; name: string }>
  noProjectLabel: string
  ariaLabel: string
  compact?: boolean
  /** Reads as the panel heading itself: the list source picker. */
  heading?: boolean
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
    <div
      className={
        heading ? styles.sourcePicker : compact ? styles.projectLink : styles.projectInputWrap
      }
    >
      {heading ? null : <FolderKanban size={compact ? 11 : 13} aria-hidden="true" />}
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
