import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useUiStore } from '../stores/uiStore'
import { loadClaudeUsage, resetClaudeUsageBackoffForTests } from './claudeUsageCache'
import type { ClaudeUsage } from './tauri'
import { clearAllTtlCaches } from './ttlCache'

const { getClaudeUsage } = vi.hoisted(() => ({ getClaudeUsage: vi.fn() }))
vi.mock('./tauri', () => ({ getClaudeUsage }))

const reading: ClaudeUsage = {
  five_hour: { utilization: 34, resets_at: '2026-09-29T20:00:00Z' },
  seven_day: { utilization: 46, resets_at: '2026-10-01T09:00:00Z' },
  seven_day_opus: { utilization: 0, resets_at: '' },
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-09T12:00:00Z'))
  clearAllTtlCaches()
  resetClaudeUsageBackoffForTests()
  getClaudeUsage.mockReset()
  useUiStore.setState({ claudeUsage: null, claudeUsageError: null })
})

afterEach(() => {
  vi.useRealTimers()
})

// The usage API rate limits readily; that is not the same as having no token (#244).
describe('loadClaudeUsage', () => {
  it('keeps the last reading when a refresh is refused', async () => {
    getClaudeUsage.mockResolvedValueOnce(reading)
    await loadClaudeUsage()

    getClaudeUsage.mockRejectedValueOnce('unavailable:503')
    expect(await loadClaudeUsage(true)).toBeNull()

    expect(useUiStore.getState().claudeUsage).toEqual(reading)
    expect(useUiStore.getState().claudeUsageError).toEqual({ kind: 'unavailable' })
  })

  it('says there is no token only when there is none', async () => {
    getClaudeUsage.mockResolvedValueOnce(reading)
    await loadClaudeUsage()

    getClaudeUsage.mockRejectedValueOnce('no_token')
    await loadClaudeUsage(true)

    expect(useUiStore.getState().claudeUsage).toBeNull()
    expect(useUiStore.getState().claudeUsageError).toEqual({ kind: 'no_token' })
  })

  it('clears the error once a read succeeds again', async () => {
    getClaudeUsage.mockRejectedValueOnce('unavailable:503')
    await loadClaudeUsage(true)
    expect(useUiStore.getState().claudeUsageError).toEqual({ kind: 'unavailable' })

    getClaudeUsage.mockResolvedValueOnce(reading)
    expect(await loadClaudeUsage(true)).toEqual(reading)

    expect(useUiStore.getState().claudeUsageError).toBeNull()
  })

  it('never brings back a reading from the cache after a refresh failed', async () => {
    getClaudeUsage.mockResolvedValueOnce(reading)
    await loadClaudeUsage()
    getClaudeUsage.mockRejectedValueOnce('no_token')
    await loadClaudeUsage(true)

    // The regular poll comes around again within the cache window and gets the failure back.
    await loadClaudeUsage()

    expect(getClaudeUsage).toHaveBeenCalledTimes(2)
    expect(useUiStore.getState().claudeUsage).toBeNull()
    expect(useUiStore.getState().claudeUsageError).toEqual({ kind: 'no_token' })
  })

  it.each([
    ['unauthorized:401', 'unauthorized'],
    ['offline', 'offline'],
    ['unavailable:503', 'unavailable'],
    ['something unexpected', 'unavailable'],
  ])('names the cause of %s', async (error, kind) => {
    getClaudeUsage.mockRejectedValueOnce(error)
    await loadClaudeUsage(true)

    expect(useUiStore.getState().claudeUsageError).toEqual({ kind })
  })

  it('asks at most once per cache window', async () => {
    getClaudeUsage.mockResolvedValue(reading)
    await Promise.all([loadClaudeUsage(), loadClaudeUsage()])
    await loadClaudeUsage()

    expect(getClaudeUsage).toHaveBeenCalledTimes(1)
  })

  it('remembers a failed read for the cache window; a forced read still asks', async () => {
    getClaudeUsage.mockRejectedValue('unavailable:503')
    await loadClaudeUsage(true)
    await loadClaudeUsage()
    await loadClaudeUsage()
    await loadClaudeUsage()
    expect(getClaudeUsage).toHaveBeenCalledTimes(1)
    expect(useUiStore.getState().claudeUsageError).toEqual({ kind: 'unavailable' })

    // Only a rate limit holds back a forced read.
    await loadClaudeUsage(true)
    expect(getClaudeUsage).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(60_000)
    await loadClaudeUsage()
    expect(getClaudeUsage).toHaveBeenCalledTimes(3)
  })
})

describe('rate-limit back-off', () => {
  it('sends nothing until Retry-After has passed, even when forced', async () => {
    getClaudeUsage.mockRejectedValueOnce('rate_limited:429:120')
    await loadClaudeUsage(true)
    const retryAt = Date.now() + 120_000
    expect(useUiStore.getState().claudeUsageError).toEqual({ kind: 'rate_limited', retryAt })

    vi.advanceTimersByTime(119_999)
    await loadClaudeUsage(true)
    await loadClaudeUsage()
    expect(getClaudeUsage).toHaveBeenCalledTimes(1)
    expect(useUiStore.getState().claudeUsageError).toEqual({ kind: 'rate_limited', retryAt })

    vi.advanceTimersByTime(1)
    getClaudeUsage.mockResolvedValueOnce(reading)
    expect(await loadClaudeUsage()).toEqual(reading)
    expect(getClaudeUsage).toHaveBeenCalledTimes(2)
  })

  it('waits five minutes when the limit does not say how long', async () => {
    getClaudeUsage.mockRejectedValueOnce('rate_limited:429')
    await loadClaudeUsage(true)

    vi.advanceTimersByTime(5 * 60_000 - 1)
    await loadClaudeUsage(true)
    expect(getClaudeUsage).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1)
    getClaudeUsage.mockResolvedValueOnce(reading)
    await loadClaudeUsage(true)
    expect(getClaudeUsage).toHaveBeenCalledTimes(2)
  })

  it('honours a Retry-After of up to an hour', async () => {
    getClaudeUsage.mockRejectedValueOnce('rate_limited:429:3600')
    await loadClaudeUsage(true)

    expect(useUiStore.getState().claudeUsageError).toEqual({
      kind: 'rate_limited',
      retryAt: Date.now() + 3_600_000,
    })
  })

  it.each(['-5', 'Infinity', 'abc', '3601', '1e9'])(
    'waits five minutes for a Retry-After of %s',
    async (secs) => {
      getClaudeUsage.mockRejectedValueOnce(`rate_limited:429:${secs}`)
      await loadClaudeUsage(true)

      expect(useUiStore.getState().claudeUsageError).toEqual({
        kind: 'rate_limited',
        retryAt: Date.now() + 5 * 60_000,
      })
    },
  )

  it('keeps one read per window once the back-off is over', async () => {
    getClaudeUsage.mockRejectedValueOnce('rate_limited:429:120')
    await loadClaudeUsage(true)
    vi.advanceTimersByTime(120_000)

    getClaudeUsage.mockRejectedValue('unavailable:503')
    await loadClaudeUsage()
    await loadClaudeUsage()
    await loadClaudeUsage()
    expect(getClaudeUsage).toHaveBeenCalledTimes(2)
  })

  it('ends with a successful read, which then serves the window', async () => {
    getClaudeUsage.mockRejectedValueOnce('rate_limited:429:10')
    await loadClaudeUsage(true)
    vi.advanceTimersByTime(10_000)
    getClaudeUsage.mockResolvedValueOnce(reading)
    await loadClaudeUsage(true)

    vi.advanceTimersByTime(1_000)
    expect(await loadClaudeUsage()).toEqual(reading)
    expect(getClaudeUsage).toHaveBeenCalledTimes(2)
    expect(useUiStore.getState().claudeUsageError).toBeNull()
  })

  it('is timed on a monotonic clock, so a wall-clock jump does not end it', async () => {
    getClaudeUsage.mockRejectedValueOnce('rate_limited:429:120')
    await loadClaudeUsage(true)

    vi.setSystemTime(Date.now() + 24 * 3_600_000)
    await loadClaudeUsage(true)
    expect(getClaudeUsage).toHaveBeenCalledTimes(1)
  })
})
