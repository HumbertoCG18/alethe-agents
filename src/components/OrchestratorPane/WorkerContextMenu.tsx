import { Eye, RotateCcw, Square } from 'lucide-react'

import { useT } from '../../lib/i18n'
import type { OrchestratorJob } from '../../lib/tauri/orchestrator'
import { ContextMenu, type MenuItem } from '../ProjectSidebar/ContextMenu'

type Props = {
  job: OrchestratorJob
  x: number
  y: number
  onOpen: (jobId: string) => void
  onStop: (jobId: string) => void
  onRestart: (jobId: string) => void
  onClose: () => void
}

const ACTIVE_STATUSES = new Set<OrchestratorJob['status']>(['queued', 'running', 'blocked'])

/**
 * What right-clicking a worker offers. Claude's own subagents and background shells live inside
 * the planner's process, out of Alethe's reach, so they can only be opened.
 */
export function WorkerContextMenu({ job, x, y, onOpen, onStop, onRestart, onClose }: Props) {
  const t = useT()
  const items: MenuItem[] = [
    {
      kind: 'item',
      label: t('orchestrator.menuOpen'),
      icon: <Eye size={13} />,
      onClick: () => onOpen(job.id),
    },
  ]
  if (!job.native && ACTIVE_STATUSES.has(job.status)) {
    items.push({
      kind: 'item',
      label: t('orchestrator.menuStop'),
      icon: <Square size={13} />,
      danger: true,
      onClick: () => onStop(job.id),
    })
  }
  if (!job.native) {
    items.push({
      kind: 'item',
      label: t('orchestrator.menuRestart'),
      icon: <RotateCcw size={13} />,
      onClick: () => onRestart(job.id),
    })
  }
  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />
}
