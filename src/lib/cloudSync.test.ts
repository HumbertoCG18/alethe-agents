import { describe, expect, it, vi } from 'vitest'

import { applyCloudPayload } from './cloudSync'

vi.mock('./tauri', () => ({ pluginsList: vi.fn(async () => []), pluginSetEnabled: vi.fn() }))

describe('applyCloudPayload', () => {
  it('fills a partial sidebar setting from another device before applying it', async () => {
    const setPreferences = vi.fn()

    await applyCloudPayload(
      { format: 1, preferences: { sidebarIcons: { left: ['files'], right: [] } } },
      setPreferences,
    )

    expect(setPreferences).toHaveBeenCalledWith({
      sidebarIcons: { left: ['files'], right: [], hidden: [] },
    })
  })
})
