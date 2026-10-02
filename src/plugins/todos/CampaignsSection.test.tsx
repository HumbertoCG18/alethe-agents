import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import exemplo from '../../lib/__fixtures__/campanhas.exemplo.json'
import { EMPTY_PROJECTS_FILE } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'

const fs = vi.hoisted(() => ({
  files: new Map<string, string>(),
  onChange: null as ((path: string) => void) | null,
  handoff: null as string | null,
}))

vi.mock('../../lib/terminalLifecycle', () => ({ cleanupPtys: vi.fn() }))
vi.mock('../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/tauri')>()),
  worktreeCheckouts: vi.fn(async () => ({
    main: 'C:\\repo',
    worktrees: [
      { path: 'C:\\repo', branch: 'dev', lastCommitMs: null },
      { path: 'C:\\repo-feature', branch: 'feature', lastCommitMs: null },
    ],
  })),
  readTextFile: vi.fn(async (path: string) => {
    const text = fs.files.get(path)
    if (text === undefined) throw new Error('file not found')
    return text
  }),
  watchFile: vi.fn(async () => {}),
  unwatchFile: vi.fn(async () => {}),
  listenFileChanged: vi.fn(async (handler: (path: string) => void) => {
    fs.onChange = handler
    return () => {}
  }),
  findRelativePath: vi.fn(async () => fs.handoff),
}))

import { findRelativePath, readTextFile, watchFile } from '../../lib/tauri'
import { CampaignsSection } from './CampaignsSection'
import { resetTodosStoreForTests, useTodosStore } from './store'
import { TodoSidebar } from './TodoSidebar'

const REGISTRY = 'C:\\repo\\.workflow\\campanhas.json'

function withOito(registry: typeof exemplo, fields: Record<string, unknown>) {
  return {
    ...registry,
    campanhas: registry.campanhas.map((campaign) =>
      campaign.id === 'OITO' ? { ...campaign, ...fields } : campaign,
    ),
  }
}

beforeEach(() => {
  fs.files.clear()
  fs.onChange = null
  fs.handoff = null
  resetTodosStoreForTests()
  useUiStore.setState({ activeTerminal: null })
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: false })
  const project = useProjectsStore.getState().createProject({ name: 'App', defaultCwd: 'C:\\repo' })
  useProjectsStore.setState({ activeProjectId: project.id })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function expandSection() {
  fireEvent.click(await screen.findByRole('button', { name: /Campaigns/ }))
}

const IDS = new RegExp(`^(${exemplo.campanhas.map((campaign) => campaign.id).join('|')})$`)
/** Campaign ids in the order the rows show them. */
const rowOrder = () => screen.getAllByText(IDS).map((element) => element.textContent)
const activeRow = () => document.querySelector('[aria-current="true"]')

function openTerminal(cwd: string, type: 'shell' | 'claude', campaignId?: string) {
  const projectId = useProjectsStore.getState().projects[0].id
  return useProjectsStore
    .getState()
    .createTerminal(projectId, { name: cwd, cwd, firstTab: { type, cwd, campaignId } })
}

function focusTerminal(terminalId: string) {
  const projectId = useProjectsStore.getState().projects[0].id
  act(() => useUiStore.getState().setActiveTerminal(projectId, terminalId))
}

describe('CampaignsSection', () => {
  it('renders nothing when the main checkout has no registry', async () => {
    const { container } = render(<CampaignsSection />)
    await waitFor(() => expect(fs.onChange).not.toBeNull())
    expect(container).toBeEmptyDOMElement()
  })

  it('starts collapsed, lists campaigns with progress and situation, and follows file edits', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    render(<CampaignsSection />)
    const toggle = await screen.findByRole('button', { name: /Campaigns/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('OITO')).not.toBeInTheDocument()

    await expandSection()
    expect(screen.getByText('OITO')).toBeInTheDocument()
    expect(screen.getByText('1/8 · 13%')).toBeInTheDocument()
    expect(screen.getByText('In progress, 4 ready')).toBeInTheDocument()
    expect(screen.getByText('1/1+? · 100%')).toBeInTheDocument()
    expect(screen.getByText('Waits for ABERTA')).toBeInTheDocument()

    // Expanding a campaign lists its tasks with state and unmet prerequisites.
    fireEvent.click(screen.getByRole('button', { name: /Espera a campanha ABERTA inteira/ }))
    expect(screen.getByText('DEPOIS-01')).toBeInTheDocument()
    expect(screen.getByText('Waits for ABERTA', { selector: '[data-unmet]' })).toBeInTheDocument()

    const edited = structuredClone(exemplo)
    edited.campanhas[0].titulo = 'Renamed by the script'
    fs.files.set(REGISTRY, JSON.stringify(edited))
    act(() => fs.onChange?.(REGISTRY))
    expect(await screen.findByText('Renamed by the script')).toBeInTheDocument()
  })

  it('shows up in the Todo tab after the user list', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    render(<TodoSidebar />)
    const toggle = await screen.findByRole('button', { name: /Campaigns/ })
    expect(screen.getByText('Nothing on your list').compareDocumentPosition(toggle)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
    // The heading names the personal list, so it does not read as covering the campaigns.
    expect(screen.getByText('My todos')).toBeInTheDocument()
  })

  it('puts the campaign of the focused terminal first, highlighted, and follows the focus', async () => {
    fs.files.set(REGISTRY, JSON.stringify(withOito(exemplo, { worktrees: ['repo-feature'] })))
    const tagged = openTerminal('C:\\repo', 'shell', 'PARADA')
    const inWorktree = openTerminal('C:\\repo-feature', 'claude')
    render(<CampaignsSection />)
    await expandSection()
    expect(rowOrder()[0]).toBe('BASE')
    expect(activeRow()).toBeNull()

    // The tab opened for PARADA wins, although it sits in the main checkout.
    focusTerminal(tagged.id)
    expect(rowOrder()).toEqual(['PARADA', 'BASE', 'OITO', 'ABERTA', 'DEPOIS', 'NOTURNA'])
    expect(activeRow()).toHaveTextContent('PARADA')

    // Any other terminal counts by the worktree its cwd is in.
    focusTerminal(inWorktree.id)
    expect(rowOrder()[0]).toBe('OITO')
    expect(activeRow()).toHaveTextContent('OITO')

    // With no campaign terminal focused, the last active campaign of the project stays on top.
    act(() => useUiStore.setState({ activeTerminal: null }))
    expect(rowOrder()[0]).toBe('OITO')
    expect(useTodosStore.getState().activeCampaigns).toEqual({
      [useProjectsStore.getState().projects[0].id]: 'OITO',
    })

    // Continue never takes over a terminal opened by hand: it offers the agents and starts a tab
    // tagged for OITO, even though a Claude tab already runs in its worktree.
    fireEvent.click(screen.getByRole('button', { name: 'Continue campaign OITO' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Claude Code' }))
    await waitFor(() => expect(useProjectsStore.getState().projects[0].terminals).toHaveLength(3))
    const created = useProjectsStore.getState().projects[0].terminals[2]
    expect(created.tabs[0]).toMatchObject({
      type: 'claude',
      cwd: 'C:\\repo-feature',
      campaignId: 'OITO',
    })
    expect(useUiStore.getState().activeTerminal?.terminalId).toBe(created.id)
  })

  it('opens a new tab for a campaign whose checkout another campaign tab already uses', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    // PARADA and OITO list no worktree: both resume in the main checkout.
    openTerminal('C:\\repo', 'claude', 'PARADA')
    render(<CampaignsSection />)
    await expandSection()
    fireEvent.click(screen.getByRole('button', { name: 'Open campaign OITO' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Claude Code' }))
    await waitFor(() => expect(useProjectsStore.getState().projects[0].terminals).toHaveLength(2))
    const created = useProjectsStore.getState().projects[0].terminals[1]
    expect(created.tabs[0]).toMatchObject({
      type: 'claude',
      cwd: 'C:\\repo',
      campaignId: 'OITO',
      initialInput: expect.stringMatching(/^Retome a campanha OITO /),
    })
    expect(useUiStore.getState().activeTerminal?.terminalId).toBe(created.id)
    expect(activeRow()).toHaveTextContent('OITO')
  })

  it('continues the active campaign in its terminal; only the active row has Continue', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    const tagged = openTerminal('C:\\repo', 'claude', 'PARADA')
    const other = openTerminal('D:\\notes', 'shell')
    focusTerminal(tagged.id)
    render(<CampaignsSection />)
    await expandSection()
    expect(screen.getAllByRole('button', { name: /^Continue campaign/ })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Open campaign PARADA' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open campaign OITO' })).toBeInTheDocument()

    focusTerminal(other.id)
    fireEvent.click(screen.getByRole('button', { name: 'Continue campaign PARADA' }))
    expect(useUiStore.getState().activeTerminal?.terminalId).toBe(tagged.id)
    expect(useProjectsStore.getState().projects[0].terminals).toHaveLength(2)
  })

  it('opens a terminal for the remembered campaign when none is open, like Open', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    const projectId = useProjectsStore.getState().projects[0].id
    useTodosStore.setState({ activeCampaigns: { [projectId]: 'PARADA' } })
    render(<CampaignsSection />)
    await expandSection()
    expect(rowOrder()[0]).toBe('PARADA')

    fireEvent.click(screen.getByRole('button', { name: 'Continue campaign PARADA' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Codex' }))
    await waitFor(() => expect(useProjectsStore.getState().projects[0].terminals).toHaveLength(1))
    const [terminal] = useProjectsStore.getState().projects[0].terminals
    expect(terminal.tabs[0]).toMatchObject({ type: 'codex', cwd: 'C:\\repo', campaignId: 'PARADA' })
    expect(useUiStore.getState().activeTerminal?.terminalId).toBe(terminal.id)
  })

  it('opens the chosen agent in the campaign worktree once, then focuses it', async () => {
    const registry = withOito(exemplo, {
      worktrees: ['repo-gone', 'repo-feature'],
      handoff: 'docs/handoff.md',
    })
    fs.files.set(REGISTRY, JSON.stringify(registry))
    fs.handoff = 'C:\\repo\\docs\\handoff.md'
    render(<CampaignsSection />)
    await expandSection()
    const open = () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open campaign OITO' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Claude Code' }))
    }

    open()
    await waitFor(() => expect(useProjectsStore.getState().projects[0].terminals).toHaveLength(1))
    const [terminal] = useProjectsStore.getState().projects[0].terminals
    expect(terminal.cwd).toBe('C:\\repo-feature')
    // The worktree has no registry of its own: both paths point into the main checkout.
    expect(findRelativePath).toHaveBeenCalledWith('C:\\repo', 'docs/handoff.md')
    expect(terminal.tabs[0]).toMatchObject({
      type: 'claude',
      cwd: 'C:\\repo-feature',
      campaignId: 'OITO',
      initialInput:
        'Retome a campanha OITO (Uma de oito feitas: 12,5% arredonda para 13) pelo registro ' +
        `${REGISTRY} e pelo handoff C:\\repo\\docs\\handoff.md.`,
    })
    expect(useUiStore.getState().activeTerminal?.terminalId).toBe(terminal.id)
    // Its tab is focused now, so OITO became the active campaign and continues there.
    expect(rowOrder()[0]).toBe('OITO')

    act(() => useUiStore.setState({ activeTerminal: null }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue campaign OITO' }))
    await waitFor(() => expect(useUiStore.getState().activeTerminal?.terminalId).toBe(terminal.id))
    expect(useProjectsStore.getState().projects[0].terminals).toHaveLength(1)
  })

  it('publishes only the newest reload when reads finish out of order', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    let finishOld: (text: string) => void = () => {}
    vi.mocked(readTextFile).mockImplementationOnce(
      () => new Promise<string>((resolve) => (finishOld = resolve)),
    )
    render(<CampaignsSection />)
    await waitFor(() => expect(readTextFile).toHaveBeenCalledTimes(1))

    const edited = structuredClone(exemplo)
    edited.campanhas[0].titulo = 'Newest'
    fs.files.set(REGISTRY, JSON.stringify(edited))
    act(() => fs.onChange?.(REGISTRY))
    await expandSection()
    expect(await screen.findByText('Newest')).toBeInTheDocument()

    await act(async () => finishOld(JSON.stringify(exemplo)))
    expect(screen.getByText('Newest')).toBeInTheDocument()
    expect(screen.queryByText(exemplo.campanhas[0].titulo)).not.toBeInTheDocument()
  })

  it('retries a failed watch when the window regains focus, so a registry created later shows up', async () => {
    // `.workflow` does not exist yet, so the watch on it fails.
    vi.mocked(watchFile).mockRejectedValueOnce(new Error('directory not found'))
    const { container } = render(<CampaignsSection />)
    await waitFor(() => expect(readTextFile).toHaveBeenCalledTimes(1))
    expect(container).toBeEmptyDOMElement()

    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    act(() => window.dispatchEvent(new Event('focus')))
    expect(await screen.findByRole('button', { name: /Campaigns/ })).toBeInTheDocument()
    expect(watchFile).toHaveBeenCalledTimes(2)

    // Once watched, coming back to the window costs nothing.
    act(() => window.dispatchEvent(new Event('focus')))
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(watchFile).toHaveBeenCalledTimes(2)
    expect(readTextFile).toHaveBeenCalledTimes(2)
  })

  it('lists the validation errors instead of campaigns when the registry is invalid', async () => {
    const broken = structuredClone(exemplo)
    broken.campanhas[0].tarefas[0].estado = 'feita'
    fs.files.set(REGISTRY, JSON.stringify(broken))
    render(<CampaignsSection />)
    await expandSection()
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid campaign registry')
    expect(screen.getByText('BASE-01: invalid state "feita"')).toBeInTheDocument()
    expect(screen.queryByText('OITO')).not.toBeInTheDocument()
  })
})
