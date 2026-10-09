import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import example from './lib/__fixtures__/campanhas.exemplo.json'
import { parseCampaigns } from './lib/campaigns'
import { ptyExists, readTextFile, writePty } from './lib/tauri'
import { generateMarkdown } from './lib/tauri/markdown'
import { orchestratorJobs, orchestratorMessage } from './lib/tauri/orchestrator'
import { EMPTY_PROJECTS_FILE } from './lib/types'
import { MarkdownReaderWindow } from './MarkdownReaderWindow'
import { openCampaign } from './plugins/todos/campaignView'
import { useProjectsStore } from './stores/projectsStore'

vi.mock('./lib/tauri/markdown', () => ({
  generateMarkdown: vi.fn(async () => 'Individual answer'),
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('./lib/tauri', async (original) => ({
  ...(await original<typeof import('./lib/tauri')>()),
  ptyExists: vi.fn(async () => true),
  writePty: vi.fn(async () => {}),
  findRelativePath: vi.fn(async () => null),
  readTextFile: vi.fn(async () => 'Selected passage'),
  watchFile: vi.fn(async () => {}),
  unwatchFile: vi.fn(async () => {}),
  listenFileChanged: vi.fn(async () => () => {}),
}))
vi.mock('./lib/tauri/orchestrator', () => ({
  orchestratorJobs: vi.fn(async () => ({ jobs: [] })),
  listenOrchestratorJobs: vi.fn(async () => () => {}),
  orchestratorMessage: vi.fn(async () => ({})),
}))
vi.mock('./components/MarkdownPane/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p>,
}))
beforeEach(() => {
  vi.clearAllMocks()
  useProjectsStore.setState({
    ...structuredClone(EMPTY_PROJECTS_FILE),
    hydrated: true,
    hydrate: vi.fn(async () => {}),
  })
})
afterEach(cleanup)

async function selectPassage() {
  const text = await screen.findByText('Selected passage', { selector: 'p' })
  const range = document.createRange()
  range.selectNodeContents(text)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  fireEvent(document, new Event('selectionchange'))
  fireEvent.change(screen.getByLabelText('Your question'), {
    target: { value: 'What does this do?' },
  })
}

it('opens the full source and asks the chosen individual agent with file, quote and question', async () => {
  render(<MarkdownReaderWindow path="C:/project/report.md" />)
  expect(screen.getByRole('button', { name: 'Ask agent' })).toBeDisabled()
  await selectPassage()
  fireEvent.click(screen.getByRole('button', { name: 'Answering agent or worker' }))
  fireEvent.click(screen.getByRole('option', { name: 'Codex' }))
  fireEvent.click(screen.getByRole('button', { name: 'Ask agent' }))
  expect(await screen.findByText('Individual answer')).toBeInTheDocument()
  expect(generateMarkdown).toHaveBeenCalledWith(
    expect.objectContaining({
      agent: 'codex',
      path: 'C:/project/report.md',
      content: 'Selected passage',
      question: expect.stringContaining('What does this do?'),
    }),
    expect.any(AbortSignal),
  )
  expect(readTextFile).toHaveBeenCalledWith('C:/project/report.md')
})

it('sends selected text to an orchestration worker through the existing worker message path', async () => {
  vi.mocked(orchestratorJobs).mockResolvedValueOnce({
    jobs: [
      {
        id: 'night-1',
        task: 'NIGHT-01',
        agent: 'codex',
        cwd: 'C:/project',
        status: 'running',
        threadId: 'thread-1',
      },
    ],
  } as never)
  render(<MarkdownReaderWindow path="C:/project/night-report.md" />)
  await selectPassage()
  fireEvent.click(screen.getByRole('button', { name: 'Answering agent or worker' }))
  fireEvent.click(await screen.findByRole('option', { name: /NIGHT-01/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Ask agent' }))
  await waitFor(() =>
    expect(orchestratorMessage).toHaveBeenCalledWith(
      'night-1',
      expect.stringContaining(
        '"file":"C:/project/night-report.md","quote":"Selected passage","question":"What does this do?"',
      ),
      false,
    ),
  )
  expect(generateMarkdown).not.toHaveBeenCalledWith(expect.anything())
})

it('discards an answer if the document changes while the agent is answering', async () => {
  let late!: (value: string) => void
  vi.mocked(generateMarkdown).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        late = resolve
      }),
  )
  const view = render(<MarkdownReaderWindow path="C:/old.md" />)
  await selectPassage()
  fireEvent.click(screen.getByRole('button', { name: 'Ask agent' }))
  view.rerender(<MarkdownReaderWindow path="C:/new.md" />)
  await act(async () => late('Old answer'))
  expect(screen.queryByText('Old answer')).toBeNull()
})

it('uses the existing individual night session created by openCampaign and rejects an exited PTY', async () => {
  const project = useProjectsStore
    .getState()
    .createProject({ name: 'Night project', defaultCwd: 'C:/project' })
  const parsed = parseCampaigns(JSON.stringify(example))!
  const campaign = parsed.campaigns.find((item) => item.id === 'OITO')!
  const task = campaign.tasks.find((item) => item.id === 'OITO-08')!
  const registry = {
    ...parsed,
    path: 'C:/project/.workflow/campanhas.json',
    main: 'C:/project',
    text: JSON.stringify(example),
    checkouts: {
      main: 'C:/project',
      worktrees: [{ path: 'C:/project', branch: 'dev', lastCommitMs: null }],
    },
  }
  const terminalId = await openCampaign(project.id, campaign, 'claude', registry, task)
  const terminal = useProjectsStore
    .getState()
    .projects.find((p) => p.id === project.id)!
    .terminals.find((item) => item.id === terminalId)!
  expect(terminal.tabs[0].type).toBe('claude')
  useProjectsStore
    .getState()
    .setSubTabPtyId(project.id, terminal.id, terminal.tabs[0].id, 'night-pty')
  const before = JSON.stringify(useProjectsStore.getState().projects)
  render(<MarkdownReaderWindow path="C:/project/night.md" />)
  await selectPassage()
  fireEvent.click(screen.getByRole('button', { name: 'Answering agent or worker' }))
  fireEvent.click(await screen.findByRole('option', { name: /OITO-08/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Ask agent' }))
  await waitFor(() => expect(writePty).toHaveBeenCalledWith('night-pty', '\r'))
  expect(writePty).toHaveBeenCalledWith(
    'night-pty',
    expect.stringContaining(
      '"file":"C:/project/night.md","quote":"Selected passage","question":"What does this do?"',
    ),
  )
  expect(JSON.stringify(useProjectsStore.getState().projects)).toBe(before)
  vi.mocked(writePty).mockClear()
  vi.mocked(ptyExists).mockResolvedValueOnce(false)
  fireEvent.click(screen.getByRole('button', { name: 'Ask agent' }))
  await screen.findByRole('alert')
  expect(writePty).not.toHaveBeenCalled()
  expect(JSON.stringify(useProjectsStore.getState().projects)).toBe(before)
})

it('keeps the submitted question with its answer when the draft is edited', async () => {
  let finish!: (answer: string) => void
  vi.mocked(generateMarkdown).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  render(<MarkdownReaderWindow path="C:/context.md" />)
  await selectPassage()
  fireEvent.click(screen.getByRole('button', { name: 'Ask agent' }))
  fireEvent.change(screen.getByLabelText('Your question'), {
    target: { value: 'Another question' },
  })
  await act(async () => finish('Original answer'))
  expect(screen.getByLabelText('Answer')).toHaveTextContent('What does this do?')
  expect(screen.getByLabelText('Answer')).not.toHaveTextContent('Another question')
})
