import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { quotaWindowLabel } from '../lib/agentFitness'
import { translate } from '../lib/i18n'
import { useProjectsStore } from '../stores/projectsStore'
import { useOrchestratorQuotaWarnings } from './useOrchestratorQuotaWarnings'

const usage = vi.hoisted(() => ({ claude: vi.fn() }))

vi.mock('../lib/tauri', () => ({
  getClaudeUsage: usage.claude,
  setAgentFitness: vi.fn(async () => undefined),
}))
vi.mock('../lib/codexUsageCache', () => ({ getCachedCodexUsage: vi.fn() }))

const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
  translate('en', key, params)

describe('useOrchestratorQuotaWarnings', () => {
  beforeEach(() => {
    const { preferences } = useProjectsStore.getState()
    useProjectsStore.setState({
      preferences: {
        ...preferences,
        usageAccess: { claude: true, codex: false, antigravity: false },
      },
    })
  })

  it('names the model-limit window that crossed the threshold, not a generic quota', async () => {
    usage.claude.mockResolvedValue({
      five_hour: { utilization: 5, resets_at: '' },
      seven_day: { utilization: 10, resets_at: '' },
      seven_day_opus: { utilization: 0, resets_at: '' },
      model_limits: [{ model: 'Fable', utilization: 92, resets_at: 'monday' }],
    })
    const { result } = renderHook(() => useOrchestratorQuotaWarnings())
    await waitFor(() => expect(result.current).toHaveLength(1))
    const [warning] = result.current
    expect(warning).toMatchObject({ agent: 'claude', pct: 92, window: 'fable' })
    expect(quotaWindowLabel(warning.window, t)).toBe('weekly limit of fable')
  })
})

describe('quotaWindowLabel', () => {
  it('names the session, weekly and Opus windows', () => {
    expect(quotaWindowLabel('5h', t)).toBe('5-hour session')
    expect(quotaWindowLabel('week', t)).toBe('weekly limit')
    expect(quotaWindowLabel('opus', t)).toBe('weekly Opus limit')
  })
})
