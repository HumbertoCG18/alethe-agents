import { describe, expect, it } from 'vitest'

import { codexHeadlineWindow, hasCodexWindow, type CodexUsage } from './usage'

const absent = { used_percent: 0, window_minutes: 0, resets_at_ms: 0 }
const weekly = { used_percent: 92, window_minutes: 10_080, resets_at_ms: 1_790_403_968_000 }
const usage = (primary: CodexUsage['primary'], secondary: CodexUsage['secondary']): CodexUsage => ({
  primary,
  secondary,
  plan: 'prolite',
  rate_limited: false,
  reset_credits: 0,
})

describe('codex usage windows', () => {
  it('headlines the weekly window when the plan has no 5h limit', () => {
    const weeklyOnly = usage(absent, weekly)
    expect(hasCodexWindow(weeklyOnly.primary)).toBe(false)
    expect(codexHeadlineWindow(weeklyOnly)).toBe(weekly)
  })

  it('keeps the 5h window as the headline when the plan has one', () => {
    const fiveHour = { used_percent: 10, window_minutes: 300, resets_at_ms: 1 }
    expect(hasCodexWindow(fiveHour)).toBe(true)
    expect(codexHeadlineWindow(usage(fiveHour, weekly))).toBe(fiveHour)
  })
})
