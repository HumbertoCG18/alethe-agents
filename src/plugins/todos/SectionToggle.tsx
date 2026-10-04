import { ChevronDown } from 'lucide-react'
import type { ReactNode, Ref } from 'react'

import styles from './TodoSidebar.module.css'

/**
 * The header of a collapsible Todo section: chevron, name, count and rule. `icon` goes before the
 * name, `extra` after the rule inside the toggle, and `children` beside the toggle. The `sub`
 * variant is the lighter, smaller header of a group nested in a section.
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
  return (
    <div className={styles.sectionHeader} data-variant={variant}>
      <button
        ref={toggleRef}
        type="button"
        className={styles.sectionToggle}
        onClick={onToggle}
        aria-expanded={open}
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
    </div>
  )
}
