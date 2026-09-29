import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useUiStore } from '../stores/uiStore'
import { loadClaudeUsage } from './claudeUsageCache'
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
  clearAllTtlCaches()
  getClaudeUsage.mockReset()
  useUiStore.setState({ claudeUsage: null, claudeUsageError: null })
})

// The usage API rate limits readily; that is not the same as having no token (#244).
describe('loadClaudeUsage', () => {
  it('keeps the last reading when a refresh is refused', async () => {
    getClaudeUsage.mockResolvedValueOnce(reading)
    await loadClaudeUsage()

    getClaudeUsage.mockRejectedValueOnce('API returned 429 Too Many Requests')
    expect(await loadClaudeUsage(true)).toBeNull()

    expect(useUiStore.getState().claudeUsage).toEqual(reading)
    expect(useUiStore.getState().claudeUsageError).toBe('unavailable')
  })

  it('says there is no token only when there is none', async () => {
    getClaudeUsage.mockResolvedValueOnce(reading)
    await loadClaudeUsage()

    getClaudeUsage.mockRejectedValueOnce('no_token')
    await loadClaudeUsage(true)

    expect(useUiStore.getState().claudeUsage).toBeNull()
    expect(useUiStore.getState().claudeUsageError).toBe('no_token')
  })

  it('clears the error once a read succeeds again', async () => {
    getClaudeUsage.mockRejectedValueOnce('API returned 429 Too Many Requests')
    await loadClaudeUsage(true)
    expect(useUiStore.getState().claudeUsageError).toBe('unavailable')

    getClaudeUsage.mockResolvedValueOnce(reading)
    expect(await loadClaudeUsage(true)).toEqual(reading)

    expect(useUiStore.getState().claudeUsageError).toBeNull()
  })

  it('never brings back a reading from the cache after a refresh failed', async () => {
    getClaudeUsage.mockResolvedValueOnce(reading)
    await loadClaudeUsage()
    getClaudeUsage.mockRejectedValueOnce('no_token')
    await loadClaudeUsage(true)

    // The regular poll comes around again within the cache window.
    getClaudeUsage.mockRejectedValueOnce('no_token')
    await loadClaudeUsage()

    expect(getClaudeUsage).toHaveBeenCalledTimes(3)
    expect(useUiStore.getState().claudeUsage).toBeNull()
    expect(useUiStore.getState().claudeUsageError).toBe('no_token')
  })
})
