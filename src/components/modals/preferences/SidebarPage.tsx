import {
  closestCenter,
  DndContext,
  type Modifier,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  Blocks,
  FileText,
  Folder,
  GitPullRequest,
  Grid3x3,
  GripVertical,
  Home,
  Mic,
  Plug,
  Sparkles,
} from 'lucide-react'
import type { ReactNode } from 'react'

import { useGsdSyncAvailable } from '../../../hooks/useGsdSyncSessions'
import { type MessageKey, useT } from '../../../lib/i18n'
import {
  type SidebarSide,
  type SidebarTabContribution,
  sidebarTabLabel,
} from '../../../lib/plugins'
import {
  arrangeSidebarIcons,
  LOCKED_SIDEBAR_ICONS,
  sidebarIconHidden,
  sidebarIconIds,
  sidebarIconPrefs,
} from '../../../lib/sidebarIcons'
import { useSidebarViews } from '../../../lib/viewPlacement'
import { useProjectsStore } from '../../../stores/projectsStore'
import controls from '../controls.module.css'
import { SettingsSection } from './primitives'
import styles from './SidebarPage.module.css'

type Icon = { label: string; Icon: SidebarTabContribution['icon'] }

const BUILT_IN: Record<string, { label: MessageKey; Icon: Icon['Icon'] }> = {
  home: { label: 'ui.sidebar.home', Icon: Home },
  projects: { label: 'ui.sidebar.projects', Icon: Grid3x3 },
  files: { label: 'ui.sidebar.files', Icon: Folder },
  markdown: { label: 'rightSidebar.markdownTab', Icon: FileText },
  gsdSync: { label: 'rightSidebar.gsdSyncTab', Icon: Sparkles },
  mcp: { label: 'mcp.tab', Icon: Plug },
  jev: { label: 'voice.history.tabTitle', Icon: Mic },
  prs: { label: 'rightSidebar.prsTab', Icon: GitPullRequest },
  plugins: { label: 'pluginsTab.title', Icon: Blocks },
}

/** A drag stays on the vertical axis. */
const vertical: Modifier = ({ transform }) => ({ ...transform, x: 0 })

/** Shows, hides and orders the icons of both sidebars. Which bar a view sits in is Appearance's. */
export function SidebarPage() {
  const t = useT()
  const prefs = sidebarIconPrefs(useProjectsStore((state) => state.preferences.sidebarIcons))
  const mcp = useProjectsStore((state) => state.preferences.enabledFeatures.mcp)
  const prs = useProjectsStore((state) => state.preferences.enabledFeatures.prs)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  const gsdSync = useGsdSyncAvailable()
  const views = { left: useSidebarViews('left'), right: useSidebarViews('right') }

  const icons: Record<string, Icon> = {}
  for (const [id, { label, Icon }] of Object.entries(BUILT_IN))
    icons[id] = { label: t(label), Icon }
  for (const view of [...views.left, ...views.right]) {
    icons[view.id] = { label: sidebarTabLabel(t, view), Icon: view.icon }
  }
  const save = (next: Partial<typeof prefs>) =>
    setPreferences({ sidebarIcons: { ...prefs, ...next } })
  const toggle = (id: string) =>
    save({
      hidden: prefs.hidden.includes(id)
        ? prefs.hidden.filter((hidden) => hidden !== id)
        : [...prefs.hidden, id],
    })

  const bar = (side: SidebarSide) => {
    const title = t(side === 'left' ? 'prefs.sidebarLeft' : 'prefs.sidebarRight')
    const ids = arrangeSidebarIcons(
      sidebarIconIds(
        side,
        views[side].map((view) => view.id),
        { gsdSync, mcp, prs },
      ),
      prefs[side],
    )
    const row = (id: string) => (
      <IconRow
        key={id}
        id={id}
        icon={icons[id]}
        ids={ids}
        shown={!sidebarIconHidden(id, prefs)}
        onToggle={() => toggle(id)}
        onReorder={(order) => save({ [side]: order })}
      />
    )
    return (
      <SettingsSection id={`sidebar-${side}`} title={title} description={t('prefs.sidebarDesc')}>
        <SortableList label={title} ids={ids} onReorder={(order) => save({ [side]: order })}>
          {side === 'left' ? row('home') : null}
          {ids.map(row)}
        </SortableList>
      </SettingsSection>
    )
  }

  return (
    <>
      {bar('left')}
      {bar('right')}
    </>
  )
}

/** Puts `id` where `to` is, `to` moving one place towards where `id` was. */
function moved(ids: readonly string[], id: string, to: string): string[] | null {
  const index = ids.indexOf(to)
  if (index < 0 || id === to || !ids.includes(id)) return null
  const next = ids.filter((item) => item !== id)
  next.splice(index, 0, id)
  return next
}

/** A press becomes a drag only past 8 px, as in the Todo sections. */
function SortableList({
  label,
  ids,
  onReorder,
  children,
}: {
  label: string
  ids: readonly string[]
  onReorder: (order: string[]) => void
  children: ReactNode
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))
  return (
    <DndContext
      sensors={sensors}
      modifiers={[vertical]}
      collisionDetection={closestCenter}
      onDragEnd={({ active, over }) => {
        const next = over && moved(ids, String(active.id), String(over.id))
        if (next) onReorder(next)
      }}
    >
      <ul className={styles.list} aria-label={label}>
        {children}
      </ul>
    </DndContext>
  )
}

/** One icon: its handle (drag, or ArrowUp/ArrowDown), name and switch. Home is pinned first. */
function IconRow({
  id,
  icon,
  ids,
  shown,
  onToggle,
  onReorder,
}: {
  id: string
  icon: Icon
  ids: readonly string[]
  shown: boolean
  onToggle: () => void
  onReorder: (order: string[]) => void
}) {
  const t = useT()
  const pinned = !ids.includes(id)
  const draggable = useDraggable({ id, disabled: pinned })
  const droppable = useDroppable({ id, disabled: pinned })
  const locked = LOCKED_SIDEBAR_ICONS.has(id)
  const { label, Icon } = icon
  return (
    <li
      ref={(node) => {
        draggable.setNodeRef(node)
        droppable.setNodeRef(node)
      }}
      className={styles.row}
      data-dragging={draggable.isDragging || undefined}
      style={
        draggable.transform
          ? { transform: `translate3d(0, ${draggable.transform.y}px, 0)` }
          : undefined
      }
    >
      {pinned ? (
        <span className={styles.pinned} aria-hidden />
      ) : (
        <button
          type="button"
          className={`${controls.iconBtnSm} ${styles.grip}`}
          aria-label={t('prefs.sidebarIconMove', { name: label })}
          title={t('prefs.sidebarIconMoveHint')}
          aria-keyshortcuts="ArrowUp ArrowDown"
          {...draggable.listeners}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
            event.preventDefault()
            const to = ids[ids.indexOf(id) + (event.key === 'ArrowUp' ? -1 : 1)]
            const next = to ? moved(ids, id, to) : null
            if (next) onReorder(next)
          }}
        >
          <GripVertical size={13} />
        </button>
      )}
      <Icon size={14} />
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        className={controls.switch}
        aria-checked={shown}
        aria-label={label}
        title={locked ? t('prefs.sidebarIconLocked') : undefined}
        disabled={locked}
        onClick={onToggle}
      />
    </li>
  )
}
