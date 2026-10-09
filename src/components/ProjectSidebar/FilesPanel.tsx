import { FolderOpen, FolderPlus } from 'lucide-react'

import { useT } from '../../lib/i18n'
import { getProjectDefaultCwd } from '../../lib/terminalFactory'
import type { Project, SubTab, Terminal } from '../../lib/types'
import { useUiStore } from '../../stores/uiStore'
import { EmptyState } from '../EmptyState'
import { FileExplorer } from './FileExplorer'
import styles from './FileExplorer.module.css'

/** Body of the sidebar's Files tab, shared by both sidebar styles. */
export function FilesPanel({
  project,
  terminal,
  subTab,
}: {
  project: Project | null
  terminal: Terminal | null
  subTab: SubTab | undefined
}) {
  const t = useT()
  const openModal = useUiStore((s) => s.openModal_)

  if (project && terminal && subTab) {
    return (
      <FileExplorer
        projectId={project.id}
        cwd={subTab.cwd || terminal.cwd}
        ptyId={subTab.ptyId}
        terminalName={terminal.name}
      />
    )
  }

  // No terminal to follow: the project's own folder is still worth browsing. Never a group
  // sibling's folder, which `getProjectDefaultCwd` falls back to when given the projects.
  const projectCwd = getProjectDefaultCwd(project)
  if (project && projectCwd) return <FileExplorer projectId={project.id} cwd={projectCwd} />

  return (
    <>
      <div className={styles.header}>
        <span className={styles.headerLabel}>{t('ui.sidebar.explorer')}</span>
      </div>
      <div className={styles.empty}>
        {project ? (
          <EmptyState
            compact
            icon={<FolderOpen size={18} />}
            title={t('files.emptyTitle')}
            description={t('files.emptyDesc')}
          />
        ) : (
          <EmptyState
            compact
            icon={<FolderPlus size={18} />}
            title={t('ui.sidebar.emptyTitle')}
            description={t('ui.sidebar.emptyDesc')}
            primaryAction={{
              label: t('ui.sidebar.emptyAction'),
              onClick: () => openModal('newProject'),
            }}
          />
        )}
      </div>
    </>
  )
}
