import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { quotaWindowLabel } from '../lib/agentFitness'
import { translate } from '../lib/i18n'
import { clearAllTtlCaches } from '../lib/ttlCache'
import { useProjectsStore } from '../stores/projectsStore'
import { useOrchestratorQuotaWarnings } from './useOrchestratorQuotaWarnings'

const usage = vi.hoisted(() => ({
  claude: vi.fn(),
  antigravity: vi.fn(),
  fitness: vi.fn(async () => undefined),
}))

vi.mock('../lib/tauri', () => ({
  getClaudeUsage: usage.claude,
  getAntigravityUsage: usage.antigravity,
  setAgentFitness: usage.fitness,
}))
vi.mock('../lib/codexUsageCache', () => ({ getCachedCodexUsage: vi.fn() }))

const fableAt92 = {
  five_hour: { utilization: 5, resets_at: '' },
  seven_day: { utilization: 10, resets_at: '' },
  seven_day_opus: { utilization: 0, resets_at: '' },
  model_limits: [{ model: 'Fable', utilization: 92, resets_at: 'monday' }],
}

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
    clearAllTtlCaches()
    usage.claude.mockReset()
    usage.antigravity.mockReset()
    usage.fitness.mockClear()
  })

  it('names the model-limit window that crossed the threshold, not a generic quota', async () => {
    usage.claude.mockResolvedValue(fableAt92)
    const { result } = renderHook(() => useOrchestratorQuotaWarnings())
    await waitFor(() => expect(result.current).toHaveLength(1))
    const [warning] = result.current
    expect(warning).toMatchObject({ agent: 'claude', pct: 92, window: 'fable' })
    expect(quotaWindowLabel(warning.window, t)).toBe('weekly limit of fable')
  })

  // The usage API rate limits readily: the warnings share the 60 s cache instead of asking again.
  it('reads Claude usage through the shared cache', async () => {
    usage.claude.mockResolvedValue(fableAt92)
    const first = renderHook(() => useOrchestratorQuotaWarnings())
    await waitFor(() => expect(first.result.current).toHaveLength(1))
    const second = renderHook(() => useOrchestratorQuotaWarnings())
    await waitFor(() => expect(second.result.current).toHaveLength(1))

    expect(usage.claude).toHaveBeenCalledTimes(1)
  })

  // Antigravity workers (#218): one vendor reading, read only while its usage reading is on.
  const onlyAntigravity = (antigravity: boolean) => {
    const { preferences } = useProjectsStore.getState()
    useProjectsStore.setState({
      preferences: { ...preferences, usageAccess: { claude: false, codex: false, antigravity } },
    })
  }
  const agyBucket = (label: string, used_percent: number) => ({
    label,
    models: [],
    used_percent,
    remaining_percent: 100 - used_percent,
    resets_at: '',
  })

  it('reports the Antigravity quota to the orchestrator and warns on its tightest bucket', async () => {
    onlyAntigravity(true)
    usage.antigravity.mockResolvedValue({
      status: 'ready',
      cli_path: 'agy',
      used_percent: 92,
      rate_limited: false,
      buckets: [agyBucket('Gemini Flash', 10), agyBucket('Claude', 92)],
    })
    const { result } = renderHook(() => useOrchestratorQuotaWarnings())
    await waitFor(() => expect(result.current).toHaveLength(1))

    expect(result.current[0]).toMatchObject({ agent: 'antigravity', pct: 92, window: 'Claude' })
    expect(usage.fitness).toHaveBeenCalledWith(
      'antigravity',
      expect.objectContaining({ worst: 'Claude', used: 92 }),
    )
    // A bucket is not a weekly window.
    expect(quotaWindowLabel('Claude', t, 'antigravity')).toBe('Claude quota')
  })

  it('does not hand the core a reading that arrives after Antigravity was turned off', async () => {
    onlyAntigravity(true)
    let arrive: (usage: unknown) => void = () => undefined
    usage.antigravity.mockReturnValue(new Promise((resolve) => (arrive = resolve)))
    renderHook(() => useOrchestratorQuotaWarnings())
    await waitFor(() => expect(usage.antigravity).toHaveBeenCalled())

    act(() => onlyAntigravity(false))
    await waitFor(() => expect(usage.fitness).toHaveBeenCalledWith('antigravity', null))
    await act(async () =>
      arrive({
        status: 'ready',
        cli_path: 'agy',
        used_percent: 92,
        rate_limited: false,
        buckets: [agyBucket('Claude', 92)],
      }),
    )

    const published = usage.fitness.mock.calls.filter(([agent]) => agent === 'antigravity')
    expect(published.at(-1)).toEqual(['antigravity', null])
  })

  it('forgets the Antigravity reading while its usage reading is off or not ready', async () => {
    onlyAntigravity(false)
    const off = renderHook(() => useOrchestratorQuotaWarnings())
    await waitFor(() => expect(usage.fitness).toHaveBeenCalledWith('antigravity', null))
    expect(usage.antigravity).not.toHaveBeenCalled()
    off.unmount()

    usage.fitness.mockClear()
    onlyAntigravity(true)
    usage.antigravity.mockResolvedValue({
      status: 'no_auth',
      cli_path: 'agy',
      used_percent: 0,
      rate_limited: false,
      buckets: [],
    })
    const { result } = renderHook(() => useOrchestratorQuotaWarnings())
    await waitFor(() => expect(usage.antigravity).toHaveBeenCalled())
    await waitFor(() => expect(usage.fitness).toHaveBeenCalledWith('antigravity', null))
    expect(result.current).toEqual([])
  })
})

describe('quotaWindowLabel', () => {
  it('names the session, weekly and Opus windows', () => {
    expect(quotaWindowLabel('5h', t)).toBe('5-hour session')
    expect(quotaWindowLabel('week', t)).toBe('weekly limit')
    expect(quotaWindowLabel('opus', t)).toBe('weekly Opus limit')
  })
})
