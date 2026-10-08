import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HandoffScope } from '../../lib/types'

const tauri = vi.hoisted(() => ({
  prepareAgentHandoff: vi.fn(),
  materializeAgentHandoff: vi.fn(),
  completeAgentHandoff: vi.fn(),
}))

vi.mock('../../lib/tauri', () => tauri)

const store = vi.hoisted(() => ({
  scope: 'full' as HandoffScope,
  setPreferences: vi.fn(),
}))

vi.mock('../../stores/projectsStore', () => ({
  getProjectDefaultCwd: (project?: { defaultCwd?: string }) => project?.defaultCwd ?? '',
  useProjectsStore: (selector: (state: unknown) => unknown) =>
    selector({
      projects: [{ id: 'project-1', defaultCwd: '/repo', terminals: [] }],
      createTerminal: vi.fn(),
      setPreferences: store.setPreferences,
      preferences: {
        language: 'en',
        alwaysStartUnrestricted: false,
        handoffScope: store.scope,
      },
    }),
}))

vi.mock('../../stores/uiStore', () => ({
  useUiStore: (selector: (state: unknown) => unknown) =>
    selector({
      openModal: 'handoff',
      modalContext: { agent: 'claude', projectId: 'project-1', sourceSessionId: 'session-1' },
      closeModal: vi.fn(),
      setActiveTerminal: vi.fn(),
      requestPaneFocus: vi.fn(),
    }),
}))

import { HandoffModal } from './HandoffModal'

const draft = {
  sourceProvider: 'claude',
  targetProvider: 'codex',
  sourceSessionId: 'session-1',
  cwd: '/repo',
  title: 'Build the feature',
  content: 'capsule',
  includedEventCount: 2,
  omittedEventCount: 0,
  redactionCount: 0,
  usedFallback: false,
}

beforeEach(() => {
  store.scope = 'full'
  store.setPreferences.mockReset()
  tauri.prepareAgentHandoff.mockReset()
  tauri.prepareAgentHandoff.mockResolvedValue(draft)
})

afterEach(cleanup)

describe('HandoffModal scope', () => {
  it('prepares the capsule with the remembered scope', async () => {
    store.scope = 'user-only'

    render(<HandoffModal />)

    await waitFor(() =>
      expect(tauri.prepareAgentHandoff).toHaveBeenCalledWith({
        sourceProvider: 'claude',
        targetProvider: 'codex',
        sourceSessionId: 'session-1',
        cwd: '/repo',
        scope: 'user-only',
      }),
    )
    expect(screen.getByRole('radio', { name: /Only my messages/ })).toBeChecked()
  })

  it('remembers a new choice and prepares the capsule again with it', async () => {
    store.setPreferences.mockImplementation((patch: { handoffScope: HandoffScope }) => {
      store.scope = patch.handoffScope
    })
    const { rerender } = render(<HandoffModal />)
    await waitFor(() =>
      expect(tauri.prepareAgentHandoff).toHaveBeenLastCalledWith(
        expect.objectContaining({ scope: 'full' }),
      ),
    )

    fireEvent.click(screen.getByRole('radio', { name: /Only my messages/ }))
    expect(store.setPreferences).toHaveBeenCalledWith({ handoffScope: 'user-only' })
    rerender(<HandoffModal />)

    await waitFor(() =>
      expect(tauri.prepareAgentHandoff).toHaveBeenLastCalledWith(
        expect.objectContaining({ scope: 'user-only' }),
      ),
    )
  })
})
