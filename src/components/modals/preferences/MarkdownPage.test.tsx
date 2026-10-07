import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  discover: vi.fn(),
  state: {
    preferences: {
      language: 'en',
      markdownSummary: { enabled: true, agent: 'codex', model: '', style: 'medium' },
    },
    setPreferences: vi.fn(),
  },
}))
vi.mock('../../../stores/projectsStore', () => ({
  useProjectsStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
}))
vi.mock('../../../lib/tauri/agents', () => ({ discoverProviderModels: mocks.discover }))
import { MarkdownPage } from './MarkdownPage'

beforeEach(() => {
  mocks.discover.mockReset().mockResolvedValue([{ id: 'current-model', label: 'Current model' }])
  mocks.state.setPreferences.mockReset()
})

it('uses themed selectors and saves a discovered model without blur', async () => {
  render(<MarkdownPage />)
  fireEvent.click(screen.getByRole('button', { name: 'Model' }))
  fireEvent.click(await screen.findByRole('option', { name: 'Current model' }))
  expect(mocks.state.setPreferences).toHaveBeenCalledWith({
    markdownSummary: expect.objectContaining({ model: 'current-model' }),
  })
  expect(document.querySelector('datalist')).toBeNull()
})

it('shows a discovery error while keeping the default/custom model choices usable', async () => {
  mocks.discover.mockRejectedValue(new Error('unavailable'))
  render(<MarkdownPage />)
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Model' })).not.toBeDisabled()
})
