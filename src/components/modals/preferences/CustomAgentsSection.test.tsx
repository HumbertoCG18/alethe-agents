import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state = {
    preferences: {
      language: 'en',
      customAgents: [{ id: 'my-cli', label: 'My CLI', cliCommand: 'my-cli', icon: 'bot' }],
      enabledAgents: {},
    },
    setAgentEnabled: vi.fn(),
    addCustomAgent: vi.fn(),
    updateCustomAgent: vi.fn(),
    removeCustomAgent: vi.fn(),
  }
  return { askConfirm: vi.fn(), state }
})
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => path }))
vi.mock('../../../lib/dialog', () => ({ askConfirm: mocks.askConfirm, pickFile: vi.fn() }))
vi.mock('../../../lib/customAgentIconAssets', () => ({
  importCustomAgentIconAsset: vi.fn(),
  invalidateCustomAgentIconAsset: vi.fn(),
  isCustomIconFileAvailable: vi.fn(() => true),
}))
vi.mock('../../../stores/projectsStore', () => ({
  useProjectsStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state },
  ),
}))
import { CustomAgentsSection } from './CustomAgentsSection'

beforeEach(() => {
  mocks.askConfirm.mockReset()
  mocks.state.removeCustomAgent.mockReset()
})

// window.confirm in the Tauri webview returns a Promise, always truthy: the agent went without asking.
it('removes a custom agent only after the native dialog confirms', async () => {
  mocks.askConfirm.mockResolvedValue(false)
  render(<CustomAgentsSection enabledCount={4} />)
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  await waitFor(() => expect(mocks.askConfirm).toHaveBeenCalledOnce())
  expect(mocks.askConfirm).toHaveBeenCalledWith('Remove the custom agent "My CLI"?')
  expect(mocks.state.removeCustomAgent).not.toHaveBeenCalled()

  mocks.askConfirm.mockResolvedValue(true)
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  await waitFor(() => expect(mocks.state.removeCustomAgent).toHaveBeenCalledWith('my-cli'))
})
