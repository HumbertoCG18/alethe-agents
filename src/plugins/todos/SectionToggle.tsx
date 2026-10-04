import { ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'

import styles from './TodoSidebar.module.css'

/**
 * The header of a collapsible Todo section: chevron, name, count and rule. `icon` goes before the
 * name, `extra` after the rule inside the toggle, and `children` beside the toggle.
 */
export function SectionToggle({
  name,
  count,
  open,
  onToggle,
  icon,
  extra,
  children,
}: {
  name: ReactNode
  count: ReactNode
  open: boolean
  onToggle: () => void
  icon?: ReactNode
  extra?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className={styles.sectionHeader}>
      <button
        type="button"
        className={styles.sectionToggle}
        onClick={onToggle}
        aria-expanded={open}
      >
        <ChevronDown
          size={13}
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
