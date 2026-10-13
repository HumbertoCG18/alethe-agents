import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import type { AntigravityUsage, ClaudeUsage, CodexUsage } from '../../lib/tauri'
import { clearAllTtlCaches } from '../../lib/ttlCache'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { UsageStrip } from './UsageStrip'

const reading: ClaudeUsage = {
  five_hour: { utilization: 34, resets_at: '' },
  seven_day: { utilization: 46, resets_at: '' },
}

beforeEach(() => {
  const { preferences } = useProjectsStore.getState()
  useProjectsStore.setState({
    preferences: {
      ...preferences,
      language: 'en',
      usageShowClaude: true,
      usageShowCodex: false,
      usageShowAntigravity: false,
      usageAccess: { claude: true, codex: false, antigravity: false },
    },
  })
})

afterEach(cleanup)

// A failed read used to say only "unavailable"; the card now says why (#130).
describe('Claude usage card', () => {
  // A clock time stays true while the card sits unchanged; a countdown would freeze.
  it('says the read was rate limited and at what time to try again', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 9, 14, 0))
    useUiStore.setState({
      claudeUsage: null,
      claudeUsageError: { kind: 'rate_limited', retryAt: new Date(2026, 9, 9, 14, 32).getTime() },
    })
    render(<UsageStrip showActivity={false} />)
    vi.useRealTimers()

    expect(screen.getByText('usage rate limited')).toBeInTheDocument()
    expect(
      screen.getByText(/^the usage service asked to wait; try again at 02:32\sPM$/),
    ).toBeInTheDocument()
  })

  it.each([
    ['unauthorized', 'sign-in expired'],
    ['offline', 'offline'],
    ['unavailable', 'usage unavailable'],
  ] as const)('names a %s read', (kind, title) => {
    useUiStore.setState({ claudeUsage: null, claudeUsageError: { kind } })
    render(<UsageStrip showActivity={false} />)

    expect(screen.getByText(title)).toBeInTheDocument()
  })

  it('names the cause next to a reading kept from before the failure', () => {
    useUiStore.setState({ claudeUsage: reading, claudeUsageError: { kind: 'unauthorized' } })
    render(<UsageStrip showActivity={false} />)

    expect(screen.getByText('sign-in expired')).toBeInTheDocument()
    expect(screen.queryByText('live')).not.toBeInTheDocument()
  })
})

function showOnly(provider: 'claude' | 'codex' | 'antigravity') {
  const { preferences } = useProjectsStore.getState()
  useProjectsStore.setState({
    preferences: {
      ...preferences,
      usageShowClaude: provider === 'claude',
      usageShowCodex: provider === 'codex',
      usageShowAntigravity: provider === 'antigravity',
      usageAccess: {
        claude: provider === 'claude',
        codex: provider === 'codex',
        antigravity: provider === 'antigravity',
      },
    },
  })
}

// Each card follows the limits its own CLI's /usage shows (#184).
describe('usage limits as each CLI reports them', () => {
  beforeEach(() => {
    clearAllTtlCaches()
    invoke.mockReset()
  })

  it('shows Claude model limits it reports and no fixed Opus row', () => {
    showOnly('claude')
    useUiStore.setState({
      claudeUsageError: null,
      claudeUsage: {
        ...reading,
        model_limits: [{ model: 'Fable', utilization: 2, resets_at: '' }],
      },
    })
    render(<UsageStrip showActivity={false} />)

    expect(screen.getAllByText(/fable/).length).toBeGreaterThan(0)
    expect(screen.queryAllByText(/opus/)).toEqual([])
  })

  it('shows each Antigravity quota group with its 5-hour and weekly window', () => {
    showOnly('antigravity')
    const bucket = (label: string, window: string, used_percent: number) => ({
      label,
      models: [],
      window,
      used_percent,
      remaining_percent: 100 - used_percent,
      resets_at: '',
    })
    const usage: AntigravityUsage = {
      status: 'ready',
      cli_path: 'agy',
      used_percent: 40,
      rate_limited: false,
      buckets: [
        bucket('Gemini', 'weekly', 1),
        bucket('Gemini', '5h', 0),
        bucket('Claude and GPT', 'weekly', 40),
        bucket('Claude and GPT', '5h', 0),
      ],
    }
    useUiStore.setState({ antigravityUsage: usage })
    render(<UsageStrip showActivity={false} />)

    expect(screen.getByText('2 groups')).toBeInTheDocument()
    expect(screen.getByText('2 quota groups')).toBeInTheDocument()
    expect(screen.getByText('most used · claude and gpt · week')).toBeInTheDocument()
    expect(screen.getAllByText(/^gemini · 5h/).length).toBe(1)
  })

  it('adds the Codex account overview from its own /usage', async () => {
    showOnly('codex')
    const codexUsage: CodexUsage = {
      primary: { used_percent: 0, window_minutes: 0, resets_at_ms: 0 },
      secondary: { used_percent: 25, window_minutes: 10080, resets_at_ms: 0 },
      plan: 'prolite',
      rate_limited: false,
      reset_credits: 0,
    }
    useUiStore.setState({ codexUsage })
    invoke.mockImplementation(async (command: string) =>
      command === 'get_codex_account_stats'
        ? {
            lifetime_tokens: 2_384_437_875,
            peak_daily_tokens: 142_995_352,
            longest_turn_secs: 16_093,
            current_streak_days: 14,
            longest_streak_days: 16,
          }
        : undefined,
    )
    render(<UsageStrip showActivity={false} />)

    expect(await screen.findByText('2.4B')).toBeInTheDocument()
    expect(screen.getByText('143M')).toBeInTheDocument()
    expect(screen.getByText('4h 28m')).toBeInTheDocument()
    expect(screen.getByText('14 d · best 16')).toBeInTheDocument()
  })
})
