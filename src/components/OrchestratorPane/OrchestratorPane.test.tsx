import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { translate } from '../../lib/i18n'
import type {
  OrchestratorJob,
  OrchestratorPendingApproval,
  OrchestratorSnapshot,
} from '../../lib/tauri'
import { EMPTY_PROJECTS_FILE, type Project, type Terminal } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { ApprovalAsk, OrchestratorPane } from '.'

const SNAPSHOT: OrchestratorSnapshot = {
  jobs: [],
  planners: [{ id: 'pty-planner', label: 'Planner', agent: 'claude' }],
  running: 0,
  queued: 0,
  concurrencyLimit: 4,
  roles: [],
}

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === 'orchestrator_jobs') return SNAPSHOT
    throw new Error(`${command} is not mocked`)
  }),
  convertFileSrc: (path: string) => path,
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('../../plugins/todos/campaignView', () => ({
  useCampaignRegistry: () => ({ registry: null }),
}))
vi.mock('../../hooks/useOrchestratorQuotaWarnings', () => ({
  useOrchestratorQuotaWarnings: () => [],
}))

const t = (key: Parameters<typeof translate>[1]) => translate('en', key)

afterEach(cleanup)

// UI-01: the composer is a text field a screen reader can name.
// UI-01: a worker stopped on an approval is announced, not only drawn.
describe('ApprovalAsk', () => {
  it('announces the question a blocked worker is stopped on', () => {
    const job = { id: 'w1', cwd: 'C:/repo' } as OrchestratorJob
    const ask: OrchestratorPendingApproval = {
      rpcId: 1,
      kind: 'command',
      command: 'npm test',
      cwd: null,
      reason: null,
      askedAtMs: 0,
    }

    render(<ApprovalAsk job={job} ask={ask} answering={false} onAnswer={() => {}} t={t} />)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(t('orchestrator.askLabel'))
    expect(alert).toHaveTextContent('npm test')
  })
})
