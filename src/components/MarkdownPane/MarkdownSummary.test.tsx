import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import {
  DEFAULT_MARKDOWN_SUMMARY,
  normalizeMarkdownSummary,
  summarizeMarkdown,
} from '../../lib/markdownSummary'
import { generateMarkdown } from '../../lib/tauri/markdown'
import { EMPTY_PROJECTS_FILE } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { MarkdownPage } from '../modals/preferences/MarkdownPage'
import { MarkdownSummary } from './MarkdownSummary'

vi.mock('../../lib/tauri/markdown', () => ({
  generateMarkdown: vi.fn(),
  openMarkdownReader: vi.fn(),
}))
vi.mock('../../lib/tauri/agents', () => ({ discoverProviderModels: vi.fn(async () => []) }))
vi.mock('./MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}))
beforeEach(() => {
  vi.clearAllMocks()
  useProjectsStore.setState({
    ...structuredClone(EMPTY_PROJECTS_FILE),
    preferences: {
      ...structuredClone(EMPTY_PROJECTS_FILE.preferences),
      markdownSummary: { ...DEFAULT_MARKDOWN_SUMMARY, enabled: true },
    },
  })
})
afterEach(cleanup)

it('deduplicates pending and completed requests, and retries failures', async () => {
  const settings = { ...DEFAULT_MARKDOWN_SUMMARY, enabled: true }
  vi.mocked(generateMarkdown).mockResolvedValue('summary')
  const one = summarizeMarkdown('/cache.md', 'source', settings, 'en')
  const two = summarizeMarkdown('/cache.md', 'source', settings, 'en')
  expect(one.promise).toBe(two.promise)
  await one.promise
  await summarizeMarkdown('/cache.md', 'source', settings, 'en').promise
  expect(generateMarkdown).toHaveBeenCalledTimes(1)
  vi.mocked(generateMarkdown).mockRejectedValueOnce(new Error('quota'))
  await expect(summarizeMarkdown('/failure.md', 'source', settings, 'en').promise).rejects.toThrow(
    'quota',
  )
  await expect(summarizeMarkdown('/failure.md', 'source', settings, 'en').promise).resolves.toBe(
    'summary',
  )
})

it('regenerates from style, provider and model settings and never displays the superseded response', async () => {
  let late!: (value: string) => void
  vi.mocked(generateMarkdown).mockImplementation(async (args) => {
    const request = args as { style: string; agent: string; model: string }
    if (request.style === 'medium')
      return new Promise<string>((resolve) => {
        late = resolve
      })
    return `${request.style}/${request.agent}/${request.model}`
  })
  const summary = render(
    <>
      <MarkdownPage />
      <MarkdownSummary path="/settings.md" content="source" dark />
    </>,
  )
  await waitFor(() => expect(late).toBeTypeOf('function'))
  fireEvent.click(screen.getByRole('button', { name: 'Summary style' }))
  fireEvent.click(screen.getByRole('option', { name: 'Caveman' }))
  expect(await screen.findByText('caveman/codex/')).toBeInTheDocument()
  await act(async () => late('obsolete'))
  expect(screen.queryByText('obsolete')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Summary agent' }))
  fireEvent.click(screen.getByRole('option', { name: 'Claude Code' }))
  expect(await screen.findByText('caveman/claude/')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Model' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Search or enter a model ID' }), {
    target: { value: 'chosen-model' },
  })
  fireEvent.click(screen.getByRole('option', { name: 'chosen-model' }))
  expect(await screen.findByText('caveman/claude/chosen-model')).toBeInTheDocument()
  const calls = vi.mocked(generateMarkdown).mock.calls.length
  summary.unmount()
  render(<MarkdownSummary path="/settings.md" content="source" dark />)
  expect(await screen.findByText('caveman/claude/chosen-model')).toBeInTheDocument()
  expect(vi.mocked(generateMarkdown).mock.calls).toHaveLength(calls)
})

it('backfills old settings, rejects invalid saved options, and does not generate before opt-in', () => {
  expect(normalizeMarkdownSummary(undefined)).toEqual(DEFAULT_MARKDOWN_SUMMARY)
  expect(
    normalizeMarkdownSummary({ agent: 'shell', style: 'invalid', model: null } as never),
  ).toEqual(DEFAULT_MARKDOWN_SUMMARY)
  useProjectsStore.setState({
    preferences: { ...useProjectsStore.getState().preferences, markdownSummary: undefined },
  })
  render(<MarkdownSummary path="/disabled.md" content="source" dark />)
  expect(
    screen.getByText('Enable summaries in Markdown settings, or read the full document.'),
  ).toBeInTheDocument()
  expect(generateMarkdown).not.toHaveBeenCalled()
})

it('cancels a pending summary only after its last reader leaves', () => {
  vi.mocked(generateMarkdown).mockImplementation(() => new Promise(() => {}))
  const one = summarizeMarkdown('/cancel.md', 'source', DEFAULT_MARKDOWN_SUMMARY, 'en')
  const two = summarizeMarkdown('/cancel.md', 'source', DEFAULT_MARKDOWN_SUMMARY, 'en')
  const signal = vi.mocked(generateMarkdown).mock.calls[0][1]!
  one.release()
  expect(signal.aborted).toBe(false)
  two.release()
  expect(signal.aborted).toBe(true)
  const next = summarizeMarkdown('/cancel.md', 'source', DEFAULT_MARKDOWN_SUMMARY, 'en')
  expect(next.promise).not.toBe(one.promise)
  next.release()
})
