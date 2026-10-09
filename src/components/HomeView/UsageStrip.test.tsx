import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClaudeUsage } from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { UsageStrip } from './UsageStrip'

const reading: ClaudeUsage = {
  five_hour: { utilization: 34, resets_at: '' },
  seven_day: { utilization: 46, resets_at: '' },
  seven_day_opus: { utilization: 0, resets_at: '' },
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
