import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { OrchestratorJob } from '../../lib/tauri/orchestrator'
import { WorkerContextMenu } from './WorkerContextMenu'

function job(overrides: Partial<OrchestratorJob>): OrchestratorJob {
  return {
    id: 'job-07',
    plannerId: 'pty-1',
    agent: 'codex',
    runId: 'run-03',
    runLabel: 'fix the parser',
    spec: 'Make the parser accept trailing commas.',
    cwd: 'C:\\repo',
    status: 'running',
    threadId: 'thread-1',
    outcome: null,
    routing: null,
    seconds: 12,
    plan: [],
    tokens: null,
    costUsd: null,
    quota: null,
    worktree: null,
    pendingApproval: null,
    hasDiff: false,
    summary: '',
    ...overrides,
  }
}

function openMenu(worker: OrchestratorJob) {
  const handlers = { onOpen: vi.fn(), onStop: vi.fn(), onRestart: vi.fn(), onClose: vi.fn() }
  render(<WorkerContextMenu job={worker} x={10} y={20} {...handlers} />)
  const labels = screen.getAllByRole('menuitem').map((item) => item.textContent)
  return { handlers, labels }
}

afterEach(cleanup)

// Right-clicking a worker on the board or in the Executions list (#242).
describe('WorkerContextMenu', () => {
  it('offers open, stop and restart for a delegated worker that is still running', () => {
    const { handlers, labels } = openMenu(job({ status: 'running' }))
    expect(labels).toEqual(['Open', 'Stop', 'Restart'])

    fireEvent.click(screen.getByRole('menuitem', { name: 'Stop' }))
    expect(handlers.onStop).toHaveBeenCalledWith('job-07')
    expect(handlers.onClose).toHaveBeenCalled()
  })

  it('only restarts and opens a delegated worker that already ended', () => {
    for (const status of ['done', 'failed', 'cancelled', 'released', 'interrupted'] as const) {
      const { labels } = openMenu(job({ status }))
      expect(labels).toEqual(['Open', 'Restart'])
      cleanup()
    }
  })

  it('only opens a subagent or shell that runs inside the planner', () => {
    const { handlers, labels } = openMenu(job({ status: 'running', native: true }))
    expect(labels).toEqual(['Open'])

    fireEvent.click(screen.getByRole('menuitem', { name: 'Open' }))
    expect(handlers.onOpen).toHaveBeenCalledWith('job-07')
  })

  it('restarts the worker it was opened on', () => {
    const { handlers } = openMenu(job({ status: 'failed' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Restart' }))
    expect(handlers.onRestart).toHaveBeenCalledWith('job-07')
  })
})
