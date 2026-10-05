import {
  closestCenter,
  type CollisionDetection,
  DndContext,
  type DraggableSyntheticListeners,
  type DroppableContainer,
  type Modifier,
  PointerSensor,
  pointerWithin,
  useDndContext,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { ChevronDown, GripVertical } from 'lucide-react'
import {
  createContext,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useContext,
  useState,
} from 'react'

import { useT } from '../../lib/i18n'
import styles from './TodoSidebar.module.css'

/**
 * The header of a collapsible Todo section: chevron, name, count and rule. `icon` goes before the
 * name, `extra` after the rule inside the toggle, and `children` beside the toggle. The `sub`
 * variant is the lighter, smaller header of a group nested in a section. The header of a movable
 * top-level section is also its drag handle, with a grip shown on hover.
 */
export function SectionToggle({
  name,
  count,
  open,
  onToggle,
  icon,
  extra,
  children,
  variant,
  toggleRef,
}: {
  name: ReactNode
  count: ReactNode
  open: boolean
  onToggle: () => void
  icon?: ReactNode
  extra?: ReactNode
  children?: ReactNode
  variant?: 'sub'
  toggleRef?: Ref<HTMLButtonElement>
}) {
  const t = useT()
  const handle = useContext(SectionHandleContext)
  const drag = variant ? null : handle
  return (
    <div
      ref={drag?.setNode}
      className={styles.sectionHeader}
      data-variant={variant}
      data-section={drag?.id}
      data-dragging={drag?.dragging || undefined}
      style={drag?.style}
      onKeyDown={drag?.onKeyDown}
      {...drag?.listeners}
    >
      <button
        ref={toggleRef}
        type="button"
        className={styles.sectionToggle}
        onClick={onToggle}
        aria-expanded={open}
        aria-keyshortcuts={drag ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
      >
        <ChevronDown
          size={variant ? 11 : 13}
          className={`${styles.sectionChevron} ${open ? '' : styles.sectionChevronClosed}`}
        />
        {icon}
        <span className={styles.sectionName}>{name}</span>
        <span className={styles.sectionCount}>{count}</span>
        <span className={styles.sectionRule} />
        {extra}
      </button>
      {children}
      {drag ? (
        <span className={styles.sectionGrip} title={t('todo.sectionDrag')} aria-hidden>
          <GripVertical size={12} />
        </span>
      ) : null}
    </div>
  )
}

/** What a movable section's header needs to be its handle. */
type SectionHandle = {
  id: string
  setNode: (node: HTMLElement | null) => void
  listeners: DraggableSyntheticListeners
  style: CSSProperties | undefined
  dragging: boolean
  onKeyDown: (event: KeyboardEvent) => void
}

/** Given to the top-level header of a movable section; null where the section does not move. */
const SectionHandleContext = createContext<SectionHandle | null>(null)

/** A section drag stays on the vertical axis. */
const vertical: Modifier = ({ transform }) => ({ ...transform, x: 0 })

/** A section that renders nothing keeps its place in the order, but is no target. */
const shown = (container: DroppableContainer) => Boolean(container.node.current?.firstElementChild)

/** The shown section under the pointer, else the nearest one. */
const collision: CollisionDetection = (args) => {
  const targets = { ...args, droppableContainers: args.droppableContainers.filter(shown) }
  const within = pointerWithin(targets)
  return within.length > 0 ? within : closestCenter(targets)
}

type Drop = { id: string; side: 'before' | 'after' }

/**
 * The Todo tab's top-level sections in `order`. Each moves by dragging its header vertically, or
 * with Alt+ArrowUp/ArrowDown on it, among the sections shown. A press becomes a drag only past 8 px,
 * so a click still toggles; the pointer sensor swallows the click that ends a drag.
 */
export function SortableSections({
  order,
  sections,
  onReorder,
}: {
  order: readonly string[]
  sections: Record<string, { node: ReactNode }>
  onReorder: (order: string[]) => void
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))
  const [drop, setDrop] = useState<Drop | null>(null)

  /** Puts `id` where `to` is, `to` moving one place towards where `id` was. */
  const move = (id: string, to: string) => {
    const index = order.indexOf(to)
    if (index < 0 || id === to || !order.includes(id)) return
    const next = order.filter((item) => item !== id)
    next.splice(index, 0, id)
    onReorder(next)
  }
  return (
    <DndContext
      sensors={sensors}
      modifiers={[vertical]}
      collisionDetection={collision}
      onDragOver={({ active, over }) => {
        const id = String(active.id)
        const target = over ? String(over.id) : null
        setDrop(
          target && target !== id
            ? { id: target, side: order.indexOf(id) < order.indexOf(target) ? 'after' : 'before' }
            : null,
        )
      }}
      onDragEnd={({ active, over }) => {
        setDrop(null)
        if (over) move(String(active.id), String(over.id))
      }}
      onDragCancel={() => setDrop(null)}
    >
      {order.map((id) =>
        sections[id] ? (
          <SortableSection
            key={id}
            id={id}
            order={order}
            drop={drop?.id === id ? drop.side : undefined}
            move={move}
          >
            {sections[id].node}
          </SortableSection>
        ) : null,
      )}
    </DndContext>
  )
}

function SortableSection({
  id,
  order,
  drop,
  move,
  children,
}: {
  id: string
  order: readonly string[]
  drop: Drop['side'] | undefined
  move: (id: string, to: string) => void
  children: ReactNode
}) {
  const draggable = useDraggable({ id })
  const droppable = useDroppable({ id })
  const { droppableContainers } = useDndContext()
  const handle: SectionHandle = {
    id,
    setNode: draggable.setNodeRef,
    listeners: draggable.listeners,
    style: draggable.transform
      ? { transform: `translate3d(0, ${draggable.transform.y}px, 0)` }
      : undefined,
    dragging: draggable.isDragging,
    onKeyDown: (event) => {
      if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
      event.preventDefault()
      const visible = order.filter((item) => {
        const container = droppableContainers.get(item)
        return container !== undefined && shown(container)
      })
      const to = visible[visible.indexOf(id) + (event.key === 'ArrowUp' ? -1 : 1)]
      if (!to) return
      const focused = document.activeElement
      move(id, to)
      // Moving the section's node can take the focus with it.
      window.requestAnimationFrame(() => {
        if (focused instanceof HTMLElement && document.activeElement !== focused) focused.focus()
      })
    },
  }

  return (
    <div
      ref={droppable.setNodeRef}
      className={styles.sortable}
      data-drop={drop}
      data-dragging={draggable.isDragging || undefined}
    >
      <SectionHandleContext.Provider value={handle}>{children}</SectionHandleContext.Provider>
    </div>
  )
}
