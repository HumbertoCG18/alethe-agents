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

/** Sections collapse through a header button named like their picker; this is the picker. */
const picker = (name: string) =>
  screen
    .getAllByRole('button', { name })
    .find((el) => el.getAttribute('aria-haspopup') === 'listbox')!

beforeEach(() => {
  mocks.discover.mockReset().mockResolvedValue([{ id: 'current-model', label: 'Current model' }])
  mocks.state.setPreferences.mockReset()
})

it('uses themed selectors and saves a discovered model without blur', async () => {
  render(<MarkdownPage />)
  fireEvent.click(picker('Model'))
  fireEvent.click(await screen.findByRole('option', { name: 'Current model' }))
  expect(mocks.state.setPreferences).toHaveBeenCalledWith({
    markdownSummary: expect.objectContaining({ model: 'current-model' }),
  })
  expect(document.querySelector('datalist')).toBeNull()
})

it('gives each setting its own section and saves the document age window', async () => {
  render(<MarkdownPage />)
  const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
  expect(headings).toEqual([
    'AI summaries',
    'Summary agent',
    'Model',
    'Summary style',
    'Older documents',
  ])
  expect(screen.getByRole('checkbox', { name: 'Generate AI summaries' })).toBeChecked()
  fireEvent.click(picker('Older documents'))
  fireEvent.click(await screen.findByRole('option', { name: 'Older than 14 days' }))
  expect(mocks.state.setPreferences).toHaveBeenCalledWith({ markdownCatalogMaxAgeDays: 14 })
})

it('shows a discovery error while keeping the default/custom model choices usable', async () => {
  mocks.discover.mockRejectedValue(new Error('unavailable'))
  render(<MarkdownPage />)
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(picker('Model')).not.toBeDisabled()
})
