import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { orchestratorApplySettings } from '../lib/tauri/orchestrator'
import { EMPTY_PROJECTS_FILE } from '../lib/types'
import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'
import { useOrchestrationSettingsSync } from './useOrchestrationSettingsSync'

vi.mock('../lib/tauri/orchestrator', () => ({
  orchestratorApplySettings: vi.fn(async () => undefined),
}))

const applied = vi.mocked(orchestratorApplySettings)

const reviewer = {
  name: 'reviewer',
  agent: 'codex' as const,
  model: 'gpt-6.1-sol',
  effort: 'medium',
  readOnly: true,
  timeoutSeconds: 600,
}

beforeEach(() => {
  applied.mockClear()
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: false })
})

// The orchestrator only knows the Orchestration settings the app sends it (#254).
describe('useOrchestrationSettingsSync', () => {
  it('says so when the orchestrator does not take the settings', async () => {
    applied.mockRejectedValueOnce('invalid type: floating point')
    useUiStore.setState({ toasts: [] })
    renderHook(() => useOrchestrationSettingsSync())

    useProjectsStore.setState({ hydrated: true })

    await waitFor(() =>
      expect(useUiStore.getState().toasts).toContainEqual(
        expect.objectContaining({ body: expect.stringContaining('invalid type') }),
      ),
    )
  })

  it('sends the saved settings once they are loaded, and again when they change', async () => {
    renderHook(() => useOrchestrationSettingsSync())
    expect(applied).not.toHaveBeenCalled()

    useProjectsStore.setState({ hydrated: true })
    await waitFor(() =>
      expect(applied).toHaveBeenLastCalledWith(EMPTY_PROJECTS_FILE.preferences.orchestration),
    )

    const { preferences, setPreferences } = useProjectsStore.getState()
    setPreferences({ orchestration: { ...preferences.orchestration, roles: [reviewer] } })
    await waitFor(() =>
      expect(applied).toHaveBeenLastCalledWith(expect.objectContaining({ roles: [reviewer] })),
    )
  })
})
