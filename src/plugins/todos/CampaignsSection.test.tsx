import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import exemplo from '../../lib/__fixtures__/campanhas.exemplo.json'
import { parseCampaigns } from '../../lib/campaigns'
import { EMPTY_PROJECTS_FILE, type SubTab } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useUiStore } from '../../stores/uiStore'

const OTHER_REPO = vi.hoisted(() => 'C:\\other')

const fs = vi.hoisted(() => ({
  files: new Map<string, string>(),
  onChange: null as ((path: string) => void) | null,
  handoff: null as string | null,
  /** What find_relative_path returns per path; anything else gets `handoff`. */
  found: new Map<string, string>(),
}))

/** The orchestrator snapshot the board and the Todo tab receive, and its live event. */
const orchestrator = vi.hoisted(() => ({
  jobs: [] as Array<{ task?: string | null; status: string; cwd: string }>,
  emit: null as ((snapshot: { jobs: unknown[] }) => void) | null,
}))

vi.mock('../../lib/terminalLifecycle', () => ({ cleanupPtys: vi.fn() }))
vi.mock('../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/tauri')>()),
  worktreeCheckouts: vi.fn(async (path: string) =>
    path === OTHER_REPO
      ? { main: OTHER_REPO, worktrees: [{ path: OTHER_REPO, branch: 'dev', lastCommitMs: null }] }
      : {
          main: 'C:\\repo',
          worktrees: [
            { path: 'C:\\repo', branch: 'dev', lastCommitMs: null },
            { path: 'C:\\repo-feature', branch: 'feature', lastCommitMs: null },
          ],
        },
  ),
  readTextFile: vi.fn(async (path: string) => {
    const text = fs.files.get(path)
    if (text === undefined) throw new Error('file not found')
    return text
  }),
  watchFile: vi.fn(async () => {}),
  unwatchFile: vi.fn(async () => {}),
  // Every listener hears a change, as the app event reaches them all.
  listenFileChanged: vi.fn(async (handler: (path: string) => void) => {
    const previous = fs.onChange
    fs.onChange = previous
      ? (path) => {
          previous(path)
          handler(path)
        }
      : handler
    return () => {}
  }),
  findRelativePath: vi.fn(async (_cwd: string, path: string) => fs.found.get(path) ?? fs.handoff),
  // The files directly in a folder, as the list_directory command returns them.
  listDirectory: vi.fn(async (folder: string) => {
    const entries = [...fs.files.keys()]
      .filter(
        (path) => path.startsWith(`${folder}\\`) && !path.slice(folder.length + 1).includes('\\'),
      )
      .map((path) => ({ name: path.slice(folder.length + 1), path, is_dir: false, size: 1 }))
    if (entries.length === 0) throw new Error('directory not found')
    return entries
  }),
  orchestratorJobs: vi.fn(async () => ({ jobs: orchestrator.jobs })),
  listenOrchestratorJobs: vi.fn(async (handler: (snapshot: { jobs: unknown[] }) => void) => {
    orchestrator.emit = handler
    return () => {}
  }),
  // The write command's contract: replace the file only while it is still the text read.
  campaignRegistryWrite: vi.fn(async (path: string, expected: string, content: string) => {
    if (fs.files.get(path) !== expected) throw 'conflict'
    fs.files.set(path, content)
    return content
  }),
}))

import {
  campaignRegistryWrite,
  findRelativePath,
  listDirectory,
  readTextFile,
  unwatchFile,
  watchFile,
  worktreeCheckouts,
} from '../../lib/tauri'
import { CampaignsSection } from './CampaignsSection'
import { campaignLiveStatus, useCampaignView, useTaskWorkers } from './campaignView'
import { TODO_SETTINGS_MODAL_ID } from './manifest'
import { resetTodosStoreForTests, useTodosStore } from './store'
import { TodoSettingsModal } from './TodoSettingsModal'
import { TodoSidebar } from './TodoSidebar'

const REGISTRY = 'C:\\repo\\.workflow\\campanhas.json'

/** The section as the Todo tab mounts it. */
function Section() {
  const view = useCampaignView()
  return (
    <CampaignsSection view={view} workers={useTaskWorkers(view.registry)} onSelect={() => {}} />
  )
}

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
  fs.found.clear()
  orchestrator.jobs = []
  orchestrator.emit = null
  resetTodosStoreForTests()
  useUiStore.setState({ activeTerminal: null, activeView: 'workspace' })
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
/** A group header of the Campaigns map, named and counted, or null when the group is hidden. */
const group = (name: 'Active' | 'Open' | 'Finished') =>
  screen.queryByRole('button', { name: new RegExp(`^${name} \\d+$`) })
/** The project's agent terminals, without the panes opened next to them. */
const agentTerminals = () =>
  useProjectsStore
    .getState()
    .projects[0].terminals.filter((terminal) => (terminal.kind ?? 'terminal') === 'terminal')

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

/** A task as the registry file holds it now, and as the fixture had it. */
const task = (id: string) =>
  (JSON.parse(fs.files.get(REGISTRY)!) as typeof exemplo).campanhas
    .flatMap((campaign) => campaign.tarefas)
    .find((item) => item.id === id)
const original = (id: string) =>
  exemplo.campanhas.flatMap((campaign) => campaign.tarefas).find((item) => item.id === id)
const lastToast = () => useUiStore.getState().toasts.at(-1)

/** The script edits the registry, and the panel has read it again. */
async function editRegistry(edit: (data: typeof exemplo) => void) {
  const data = JSON.parse(fs.files.get(REGISTRY)!) as typeof exemplo
  edit(data)
  fs.files.set(REGISTRY, JSON.stringify(data))
  const reads = vi.mocked(readTextFile).mock.calls.length
  act(() => fs.onChange?.(REGISTRY))
  await waitFor(() => expect(vi.mocked(readTextFile).mock.calls.length).toBeGreaterThan(reads))
  await act(async () => {})
}

describe('CampaignsSection', () => {
  it('renders nothing when the main checkout has no registry', async () => {
    const { container } = render(<Section />)
    await waitFor(() => expect(fs.onChange).not.toBeNull())
    expect(container).toBeEmptyDOMElement()
  })

  it('starts collapsed, lists campaigns with progress and situation, and follows file edits', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    render(<Section />)
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
    edited.campanhas[1].titulo = 'Renamed by the script'
    fs.files.set(REGISTRY, JSON.stringify(edited))
    act(() => fs.onChange?.(REGISTRY))
    expect(await screen.findByText('Renamed by the script')).toBeInTheDocument()
  })

  it('shows up in the Todo tab after the user list', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    useTodosStore.setState({ listSource: 'mine' })
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
    render(<Section />)
    await expandSection()
    // PARADA has a tab opened for it: it is in Active, above the open ones.
    expect(rowOrder()).toEqual(['PARADA', 'OITO', 'ABERTA', 'DEPOIS', 'NOTURNA'])
    expect(activeRow()).toBeNull()

    // The tab opened for PARADA wins, although it sits in the main checkout.
    focusTerminal(tagged.id)
    expect(rowOrder()).toEqual(['PARADA', 'OITO', 'ABERTA', 'DEPOIS', 'NOTURNA'])
    expect(activeRow()).toHaveTextContent('PARADA')

    // Any other terminal counts by the worktree its cwd is in; OITO leads the Open group.
    focusTerminal(inWorktree.id)
    expect(rowOrder()[1]).toBe('OITO')
    expect(activeRow()).toHaveTextContent('OITO')

    // With no campaign terminal focused, the last active campaign of the project stays first.
    act(() => useUiStore.setState({ activeTerminal: null }))
    expect(rowOrder()[1]).toBe('OITO')
    expect(useTodosStore.getState().activeCampaigns).toEqual({
      [useProjectsStore.getState().projects[0].id]: 'OITO',
    })

    // Continue never takes over a terminal opened by hand: it offers the agents and starts a tab
    // tagged for OITO, even though a Claude tab already runs in its worktree.
    fireEvent.click(screen.getByRole('button', { name: 'Continue campaign OITO' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Claude Code' }))
    await waitFor(() => expect(agentTerminals()).toHaveLength(3))
    const created = agentTerminals()[2]
    expect(created.tabs[0]).toMatchObject({
      type: 'claude',
      cwd: 'C:\\repo-feature',
      campaignId: 'OITO',
    })
    expect(useUiStore.getState().activeTerminal?.terminalId).toBe(created.id)
  })

  it('groups the map into Active, Open and Finished, where a finished campaign always goes', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    const projectId = useProjectsStore.getState().projects[0].id
    // The selected campaign is finished: it goes to Finished all the same.
    useTodosStore.setState({ activeCampaigns: { [projectId]: 'BASE' } })
    // PARADA has a tab open for it, DEPOIS a live worker.
    openTerminal('C:\\repo', 'claude', 'PARADA')
    orchestrator.jobs = [{ task: 'DEPOIS-01', status: 'queued', cwd: 'C:\\repo' }]
    render(<Section />)
    await expandSection()
    await waitFor(() => expect(group('Active')).toHaveTextContent('2'))
    expect(screen.getByRole('button', { name: /Campaigns/ })).toHaveTextContent('6')
    // ABERTA has every task done but is not fully decomposed: it stays open.
    expect(rowOrder()).toEqual(['DEPOIS', 'PARADA', 'OITO', 'ABERTA', 'NOTURNA'])
    expect(group('Active')).toHaveAttribute('aria-expanded', 'true')
    expect(group('Open')).toHaveAttribute('aria-expanded', 'true')
    expect(group('Open')).toHaveTextContent('3')
    expect(group('Finished')).toHaveAttribute('aria-expanded', 'false')
    expect(group('Finished')).toHaveTextContent('1')

    fireEvent.click(group('Finished')!)
    expect(rowOrder()).toEqual(['DEPOIS', 'PARADA', 'OITO', 'ABERTA', 'NOTURNA', 'BASE'])
    expect(activeRow()).toHaveTextContent('BASE')
    fireEvent.click(group('Open')!)
    expect(rowOrder()).toEqual(['DEPOIS', 'PARADA', 'BASE'])
    fireEvent.click(group('Open')!)

    // The script finishes PARADA's last task: it moves to Finished on its own.
    const edited = structuredClone(exemplo)
    edited.campanhas[5].tarefas[0].estado = 'concluída'
    fs.files.set(REGISTRY, JSON.stringify(edited))
    act(() => fs.onChange?.(REGISTRY))
    await waitFor(() =>
      expect(rowOrder()).toEqual(['DEPOIS', 'OITO', 'ABERTA', 'NOTURNA', 'BASE', 'PARADA']),
    )

    // Once its worker settles, nothing is active and the group is hidden.
    act(() => orchestrator.emit?.({ jobs: [] }))
    expect(group('Active')).toBeNull()
    expect(rowOrder()).toEqual(['OITO', 'ABERTA', 'DEPOIS', 'NOTURNA', 'BASE', 'PARADA'])
  })

  it('nests Active, Open and Finished under Campaigns as lighter sub-groups that hold their rows', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    openTerminal('C:\\repo', 'claude', 'PARADA')
    render(<Section />)
    await expandSection()
    fireEvent.click(group('Finished')!)
    const campaigns = screen.getByRole('button', { name: /^Campaigns/ })
    expect(campaigns.parentElement).not.toHaveAttribute('data-variant')

    const members = {
      Active: ['PARADA'],
      Open: ['OITO', 'ABERTA', 'DEPOIS', 'NOTURNA'],
      Finished: ['BASE'],
    }
    for (const [name, ids] of Object.entries(members)) {
      const header = group(name as keyof typeof members)!
      expect(header.parentElement).toHaveAttribute('data-variant', 'sub')
      const box = screen.getByRole('group', { name })
      expect(box).toContainElement(header)
      expect(
        within(box)
          .getAllByText(IDS)
          .map((element) => element.textContent),
      ).toEqual(ids)
      expect(campaigns.closest('section')).toContainElement(box)
    }
  })

  it('shows an active campaign running only while its tab works or a worker runs one of its tasks', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    const terminal = openTerminal('C:\\repo', 'claude', 'PARADA')
    const projectId = useProjectsStore.getState().projects[0].id
    useProjectsStore.getState().setSubTabPtyId(projectId, terminal.id, terminal.tabs[0].id, 'pty-p')
    useTerminalsStore.getState().registerPty('pty-p')
    const setStatus = (status: 'working' | 'waiting') =>
      act(() => useTerminalsStore.getState().setStatus('pty-p', status))
    render(<Section />)
    await expandSection()
    const row = () => screen.getByText('PARADA').closest('[data-status]')
    expect(row()).toHaveAttribute('data-status', 'stopped')
    expect(row()).toHaveTextContent('Stopped')

    setStatus('working')
    expect(row()).toHaveAttribute('data-status', 'working')
    expect(row()).toHaveTextContent('Running')
    setStatus('waiting')
    expect(row()).toHaveAttribute('data-status', 'stopped')

    // A queued worker keeps it active but not running; a running one runs it.
    act(() =>
      orchestrator.emit?.({ jobs: [{ task: 'PARADA-01', status: 'queued', cwd: 'C:\\repo' }] }),
    )
    expect(row()).toHaveAttribute('data-status', 'stopped')
    act(() =>
      orchestrator.emit?.({ jobs: [{ task: 'PARADA-01', status: 'running', cwd: 'C:\\repo' }] }),
    )
    expect(row()).toHaveAttribute('data-status', 'working')

    // Outside Active, a task left in progress with nothing live is not shown as running.
    const oito = screen.getByText('OITO').closest('[data-lane]')
    expect(oito).toHaveAttribute('data-lane', 'interrupted')
    expect(oito).not.toHaveAttribute('data-status')
    expect(oito).toHaveTextContent('In progress, 4 ready')
    useTerminalsStore.getState().reset()
  })

  it('opens a campaign as a planner next to its own orchestration board', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    render(<Section />)
    await expandSection()
    fireEvent.click(screen.getByRole('button', { name: 'Open campaign OITO' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Codex' }))
    await waitFor(() => expect(agentTerminals()).toHaveLength(1))

    const [terminal] = agentTerminals()
    const project = useProjectsStore.getState().projects[0]
    const board = project.terminals.find((item) => item.kind === 'orchestrator')
    expect(board).toMatchObject({ cwd: 'C:\\repo' })
    expect(project.paneGroups).toEqual([
      expect.objectContaining({ kind: 'orchestration', paneIds: [terminal.id, board!.id] }),
    ])
    expect(useProjectsStore.getState().preferences.enabledFeatures.orchestrator).toBe(true)
    expect(useUiStore.getState().activeTerminal?.terminalId).toBe(terminal.id)

    // Continuing focuses that tab: no second agent, no second board.
    act(() => useUiStore.setState({ activeTerminal: null }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue campaign OITO' }))
    expect(useUiStore.getState().activeTerminal?.terminalId).toBe(terminal.id)
    expect(useProjectsStore.getState().projects[0].terminals).toHaveLength(2)
  })

  it('opens a new tab for a campaign whose checkout another campaign tab already uses', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    // PARADA and OITO list no worktree: both resume in the main checkout.
    openTerminal('C:\\repo', 'claude', 'PARADA')
    render(<Section />)
    await expandSection()
    fireEvent.click(screen.getByRole('button', { name: 'Open campaign OITO' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Claude Code' }))
    await waitFor(() => expect(agentTerminals()).toHaveLength(2))
    const created = agentTerminals()[1]
    expect(created.tabs[0]).toMatchObject({
      type: 'claude',
      cwd: 'C:\\repo',
      campaignId: 'OITO',
      initialInput: expect.stringMatching(/^Retome a campanha OITO /),
    })
    // Open keeps the user's own permission mode; only night tabs are started in auto mode.
    expect(created.tabs[0].extraArgs).toBeUndefined()
    expect(useUiStore.getState().activeTerminal?.terminalId).toBe(created.id)
    expect(activeRow()).toHaveTextContent('OITO')
  })

  it('closes the agent menu on Escape, and gives the focus back to its button', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    // Already Active through its worker, its row stays where it is once its tab opens.
    orchestrator.jobs = [{ task: 'DEPOIS-01', status: 'queued', cwd: 'C:\\repo' }]
    render(<Section />)
    await expandSection()
    await waitFor(() => expect(group('Active')).not.toBeNull())
    const open = screen.getByRole('button', { name: 'Open campaign DEPOIS' })
    const focusCodex = () => {
      fireEvent.click(open)
      const codex = screen.getByRole('menuitem', { name: 'Codex' })
      codex.focus()
      return codex
    }

    fireEvent.keyDown(focusCodex(), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(open).toHaveFocus()

    fireEvent.click(focusCodex())
    expect(screen.queryByRole('menu')).toBeNull()
    expect(open).toHaveFocus()
    await waitFor(() => expect(agentTerminals()).toHaveLength(1))
  })

  it('continues the active campaign in its terminal; only the active row has Continue', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    const tagged = openTerminal('C:\\repo', 'claude', 'PARADA')
    const other = openTerminal('D:\\notes', 'shell')
    focusTerminal(tagged.id)
    render(<Section />)
    await expandSection()
    expect(screen.getAllByRole('button', { name: /^Continue campaign/ })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Open campaign PARADA' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open campaign OITO' })).toBeInTheDocument()

    focusTerminal(other.id)
    fireEvent.click(screen.getByRole('button', { name: 'Continue campaign PARADA' }))
    expect(useUiStore.getState().activeTerminal?.terminalId).toBe(tagged.id)
    expect(useProjectsStore.getState().projects[0].terminals).toHaveLength(2)
  })

  it('continues a campaign whose tab sits in a disabled terminal of another grid, from Home', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    const projectId = useProjectsStore.getState().projects[0].id
    const tagged = openTerminal('C:\\repo', 'claude', 'PARADA')
    const store = useProjectsStore.getState()
    const shown = store.createProjectGrid(projectId, 'Shown')!
    const other = store.createProjectGrid(projectId, 'Other')!
    store.moveTerminalToGrid(projectId, tagged.id, other)
    store.openProjectGrid(projectId, shown)
    store.setTerminalDisabled(projectId, tagged.id, true)
    useTodosStore.setState({ activeCampaigns: { [projectId]: 'PARADA' } })
    useUiStore.getState().setActiveView('home')
    const visible = () =>
      useProjectsStore
        .getState()
        .workspace.containers.some((container) => container.paneIds.includes(tagged.id))
    expect(visible()).toBe(false)
    render(<Section />)
    await expandSection()
    // Its tab makes it Active, so Continue must reach that tab instead of offering the agents.
    expect(group('Active')).toHaveTextContent('1')

    fireEvent.click(screen.getByRole('button', { name: 'Continue campaign PARADA' }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(agentTerminals()).toHaveLength(1)
    expect(agentTerminals()[0].disabled).toBe(false)
    expect(useUiStore.getState().activeTerminal?.terminalId).toBe(tagged.id)
    expect(visible()).toBe(true)
    expect(useUiStore.getState().activeView).toBe('workspace')
  })

  it('opens a terminal for the remembered campaign when none is open, like Open', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    const projectId = useProjectsStore.getState().projects[0].id
    useTodosStore.setState({ activeCampaigns: { [projectId]: 'PARADA' } })
    render(<Section />)
    await expandSection()
    expect(rowOrder()[0]).toBe('PARADA')

    fireEvent.click(screen.getByRole('button', { name: 'Continue campaign PARADA' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Codex' }))
    await waitFor(() => expect(agentTerminals()).toHaveLength(1))
    const [terminal] = agentTerminals()
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
    render(<Section />)
    await expandSection()
    const open = () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open campaign OITO' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Claude Code' }))
    }

    open()
    await waitFor(() => expect(agentTerminals()).toHaveLength(1))
    const [terminal] = agentTerminals()
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
    expect(agentTerminals()).toHaveLength(1)
  })

  it('publishes only the newest reload when reads finish out of order', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    let finishOld: (text: string) => void = () => {}
    vi.mocked(readTextFile).mockImplementationOnce(
      () => new Promise<string>((resolve) => (finishOld = resolve)),
    )
    render(<Section />)
    await waitFor(() => expect(readTextFile).toHaveBeenCalledTimes(1))

    const edited = structuredClone(exemplo)
    edited.campanhas[1].titulo = 'Newest'
    fs.files.set(REGISTRY, JSON.stringify(edited))
    act(() => fs.onChange?.(REGISTRY))
    await expandSection()
    expect(await screen.findByText('Newest')).toBeInTheDocument()

    await act(async () => finishOld(JSON.stringify(exemplo)))
    expect(screen.getByText('Newest')).toBeInTheDocument()
    expect(screen.queryByText(exemplo.campanhas[1].titulo)).not.toBeInTheDocument()
  })

  it('retries a failed watch when the window regains focus, so a registry created later shows up', async () => {
    // `.workflow` does not exist yet, so the watch on it fails.
    vi.mocked(watchFile).mockRejectedValueOnce(new Error('directory not found'))
    const { container } = render(<Section />)
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
    render(<Section />)
    await expandSection()
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid campaign registry')
    expect(screen.getByText('BASE-01: invalid state "feita"')).toBeInTheDocument()
    expect(screen.queryByText('OITO')).not.toBeInTheDocument()
  })
})

describe('Todo list source', () => {
  const projectId = () => useProjectsStore.getState().projects[0].id
  const source = () => screen.getByRole('button', { name: 'List source' })
  /** Task ids in the order the main list shows them. */
  const listed = () =>
    [...document.querySelectorAll('[data-task]')].map((row) => row.getAttribute('data-task'))
  const row = (id: string) => document.querySelector(`[data-task="${id}"]`) as HTMLElement

  beforeEach(() => useUiStore.setState({ toasts: [], notifications: [] }))

  it('opens on the active campaign, with its tabs and progress', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    useTodosStore.setState({ activeCampaigns: { [projectId()]: 'OITO' } })
    render(<TodoSidebar />)
    await waitFor(() => expect(source()).toHaveTextContent('OITO'))
    expect(screen.queryByText('Nothing on your list')).not.toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveTextContent('1 / 8')

    fireEvent.click(screen.getByRole('tab', { name: 'Active' }))
    expect(listed()).toEqual([
      'OITO-02',
      'OITO-03',
      'OITO-04',
      'OITO-05',
      'OITO-08',
      'OITO-06',
      'OITO-07',
    ])
    fireEvent.click(screen.getByRole('tab', { name: 'Completed' }))
    expect(listed()).toEqual(['OITO-01'])
    fireEvent.click(screen.getByRole('tab', { name: 'All' }))
    expect(listed()).toHaveLength(8)
    expect(row('OITO-03')).toHaveTextContent('pronta sem dependência')
  })

  it('counts an undecomposed campaign as +?, and opens on the first open one when none is active', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    render(<TodoSidebar />)
    // BASE is done; OITO is the first open campaign by priority.
    await waitFor(() => expect(source()).toHaveTextContent('OITO'))

    fireEvent.click(source())
    fireEvent.click(screen.getByRole('option', { name: 'ABERTA' }))
    expect(source()).toHaveTextContent('ABERTA')
    expect(screen.getByRole('progressbar')).toHaveTextContent('1 / 1+?')
    expect(listed()).toEqual(['ABERTA-01'])
  })

  it('switches to another campaign or to My todos, and the Campaigns map selects too', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    useTodosStore.getState().createTodo('Personal one')
    render(<TodoSidebar />)
    await waitFor(() => expect(source()).toHaveTextContent('OITO'))
    // Each list stays pure: no personal todo among campaign tasks.
    expect(screen.queryByText('Personal one')).not.toBeInTheDocument()

    fireEvent.click(source())
    fireEvent.click(screen.getByRole('option', { name: 'PARADA' }))
    expect(listed()).toEqual(['PARADA-01'])

    fireEvent.click(source())
    fireEvent.click(screen.getByRole('option', { name: 'My todos' }))
    expect(source()).toHaveTextContent('My todos')
    expect(screen.getByText('Personal one')).toBeInTheDocument()
    expect(listed()).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: /Campaigns/ }))
    fireEvent.click(screen.getByRole('button', { name: /Espera a campanha ABERTA inteira/ }))
    expect(source()).toHaveTextContent('DEPOIS')
    expect(listed()).toEqual(['DEPOIS-01'])
  })

  it('adds a task to the selected campaign with the next id, through the registry write', async () => {
    const text = JSON.stringify(exemplo)
    fs.files.set(REGISTRY, text)
    render(<TodoSidebar />)
    const input = await screen.findByPlaceholderText('Add a task to OITO…')

    fireEvent.change(input, { target: { value: '  Nova tarefa  ' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(listed()).toContain('OITO-09'))
    // The exact text read is what the write expects to replace.
    expect(campaignRegistryWrite).toHaveBeenCalledWith(REGISTRY, text, expect.any(String))
    expect(task('OITO-09')).toEqual({
      id: 'OITO-09',
      titulo: 'Nova tarefa',
      estado: 'proposta',
      depende_de: [],
      origem: 'USER',
    })
    expect(row('OITO-09')).toHaveTextContent('Nova tarefa')
    expect(input).toHaveValue('')
    expect(useTodosStore.getState().todos).toEqual([])

    // A title the campaign already has is refused, naming the task; nothing is written.
    fireEvent.change(input, { target: { value: 'PROPOSTA' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(lastToast()?.body).toBe('OITO already has this task: OITO-06'))
    expect(campaignRegistryWrite).toHaveBeenCalledTimes(1)
    expect(input).toHaveValue('PROPOSTA')
  })

  it('checks a task done for the user, and undo restores it from the toast or a second click', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    render(<TodoSidebar />)
    await waitFor(() => expect(row('OITO-03')).not.toBeNull())

    fireEvent.click(within(row('OITO-03')).getByRole('button', { name: 'Mark complete' }))
    await waitFor(() =>
      expect(task('OITO-03')).toMatchObject({
        estado: 'concluída',
        resultado: 'marcada no Alethe',
      }),
    )
    await waitFor(() => expect(lastToast()?.body).toBe('OITO-03 marked done.'))
    await act(async () => lastToast()?.actions?.[0].run())
    await waitFor(() => expect(task('OITO-03')).toEqual(original('OITO-03')))

    await waitFor(() =>
      expect(within(row('OITO-03')).getByRole('button', { name: 'Mark complete' })).toBeEnabled(),
    )
    fireEvent.click(within(row('OITO-03')).getByRole('button', { name: 'Mark complete' }))
    await waitFor(() => expect(task('OITO-03')?.estado).toBe('concluída'))
    await waitFor(() =>
      expect(within(row('OITO-03')).getByRole('button', { name: 'Reopen task' })).toBeEnabled(),
    )
    fireEvent.click(within(row('OITO-03')).getByRole('button', { name: 'Reopen task' }))
    await waitFor(() => expect(task('OITO-03')).toEqual(original('OITO-03')))
    // A task done elsewhere has no previous state here to restore.
    expect(within(row('OITO-01')).getByRole('button')).toBeDisabled()
  })

  it('undo puts the state back but keeps a result written since the check', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    render(<TodoSidebar />)
    await waitFor(() => expect(row('OITO-03')).not.toBeNull())
    fireEvent.click(within(row('OITO-03')).getByRole('button', { name: 'Mark complete' }))
    await waitFor(() => expect(lastToast()?.body).toBe('OITO-03 marked done.'))

    await editRegistry((data) => {
      Object.assign(data.campanhas[1].tarefas[2], { resultado: 'verificado no build' })
    })
    await act(async () => lastToast()?.actions?.[0].run())
    await waitFor(() => expect(task('OITO-03')?.estado).toBe('pronta'))
    expect(task('OITO-03')).toEqual({ ...original('OITO-03'), resultado: 'verificado no build' })
  })

  it('shows a check as soon as the write lands, before the worktrees are read again', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    render(<TodoSidebar />)
    await waitFor(() => expect(row('OITO-03')).not.toBeNull())
    // Reading the worktrees runs git: 0.2 to 0.4 s per read on Windows (ACH-0001).
    const checkouts = await worktreeCheckouts('C:\\repo')
    let readWorktrees: () => void = () => {}
    vi.mocked(worktreeCheckouts).mockImplementationOnce(
      () => new Promise((resolve) => (readWorktrees = () => resolve(checkouts))),
    )
    // The command formats the file its own way (serde writes 0.000001 as 1e-6) and returns it.
    vi.mocked(campaignRegistryWrite).mockImplementationOnce(async (path, expected, content) => {
      if (fs.files.get(path) !== expected) throw 'conflict'
      const written = `${JSON.stringify(JSON.parse(content), null, 4)}\n`
      fs.files.set(path, written)
      return written
    })

    fireEvent.click(within(row('OITO-03')).getByRole('button', { name: 'Mark complete' }))
    await waitFor(() =>
      expect(within(row('OITO-03')).getByRole('button', { name: 'Reopen task' })).toBeEnabled(),
    )
    expect(task('OITO-03')?.estado).toBe('concluída')
    // Undone before that read ends: the undo starts from the text the command wrote.
    fireEvent.click(within(row('OITO-03')).getByRole('button', { name: 'Reopen task' }))
    await waitFor(() => expect(task('OITO-03')).toEqual(original('OITO-03')))
    await act(async () => readWorktrees())
  })

  it('keeps a check and its undo on the project it was made in, across a switch to another', async () => {
    const other = `${OTHER_REPO}\\.workflow\\campanhas.json`
    // Both registries have an OITO-03.
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    fs.files.set(other, JSON.stringify(exemplo))
    const first = projectId()
    const second = useProjectsStore
      .getState()
      .createProject({ name: 'Other', defaultCwd: OTHER_REPO }).id
    useProjectsStore.setState({ activeProjectId: first })
    let finish: () => void = () => {}
    vi.mocked(campaignRegistryWrite).mockImplementationOnce(
      (path, _expected, content) =>
        new Promise<string>((resolve) => {
          finish = () => {
            fs.files.set(path, content)
            resolve(content)
          }
        }),
    )
    render(<TodoSidebar />)
    await waitFor(() => expect(row('OITO-03')).not.toBeNull())
    fireEvent.click(within(row('OITO-03')).getByRole('button', { name: 'Mark complete' }))
    await waitFor(() => expect(campaignRegistryWrite).toHaveBeenCalledTimes(1))

    // The user moves to the other project while the write is pending.
    act(() => useProjectsStore.setState({ activeProjectId: second }))
    await act(async () => finish())
    await waitFor(() => expect(lastToast()?.body).toBe('OITO-03 marked done.'))
    expect(task('OITO-03')?.estado).toBe('concluída')
    await waitFor(() =>
      expect(within(row('OITO-03')).getByRole('button', { name: 'Mark complete' })).toBeEnabled(),
    )

    await act(async () => lastToast()?.actions?.[0].run())
    await waitFor(() => expect(task('OITO-03')).toEqual(original('OITO-03')))
    expect(fs.files.get(other)).toBe(JSON.stringify(exemplo))
  })

  it('checks campaign titles in code points, not UTF-16 units', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    render(<TodoSidebar />)
    const input = await screen.findByPlaceholderText('Add a task to OITO…')
    // 140 emoji are 280 UTF-16 units: a maxLength would cut them short.
    expect(input).not.toHaveAttribute('maxlength')
    fireEvent.change(input, { target: { value: '😀'.repeat(140) } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(listed()).toContain('OITO-09'))

    fireEvent.change(input, { target: { value: 'a'.repeat(141) } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() =>
      expect(lastToast()?.body).toBe(
        'A task title has 1 to 140 characters, with no line break or control character.',
      ),
    )
    expect(campaignRegistryWrite).toHaveBeenCalledTimes(1)
  })

  it('refuses a write over a registry changed since it was read, reloads and asks to retry', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    render(<TodoSidebar />)
    await waitFor(() => expect(row('OITO-03')).not.toBeNull())
    // The script wrote, and the panel has not seen it yet.
    const edited = structuredClone(exemplo)
    edited.campanhas[1].tarefas[2].titulo = 'Changed by the script'
    fs.files.set(REGISTRY, JSON.stringify(edited))

    fireEvent.click(within(row('OITO-03')).getByRole('button', { name: 'Mark complete' }))
    await waitFor(() =>
      expect(lastToast()?.body).toBe(
        'The registry changed since it was read. The list was reloaded; try again.',
      ),
    )
    expect(await screen.findByText('Changed by the script')).toBeInTheDocument()
    expect(fs.files.get(REGISTRY)).toBe(JSON.stringify(edited))
  })

  it('keeps the personal list as it was in a project without a registry', async () => {
    render(<TodoSidebar />)
    await waitFor(() => expect(fs.onChange).not.toBeNull())
    expect(screen.queryByRole('button', { name: 'List source' })).not.toBeInTheDocument()
    expect(screen.getByText('My todos')).toBeInTheDocument()
    const input = screen.getByPlaceholderText('Add a task…')
    fireEvent.change(input, { target: { value: 'Mine' } })
    fireEvent.submit(input.closest('form')!)
    expect(useTodosStore.getState().todos.map((todo) => todo.title)).toEqual(['Mine'])
    expect(screen.getByText('Mine')).toBeInTheDocument()
    expect(campaignRegistryWrite).not.toHaveBeenCalled()
  })

  it('opens on My todos when the settings say so, and the settings store that choice', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    useUiStore.setState({ openModal: TODO_SETTINGS_MODAL_ID })
    render(<TodoSettingsModal />)
    expect(screen.getByText('Folder for your personal todos')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'My todos' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(useTodosStore.getState().listSource).toBe('mine'))
    cleanup()

    render(<TodoSidebar />)
    await waitFor(() => expect(source()).toHaveTextContent('My todos'))
    expect(screen.getByText('Nothing on your list')).toBeInTheDocument()
  })

  it('shows the live workers of the active campaign on its row and on its task rows', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    useTodosStore.setState({ activeCampaigns: { [projectId()]: 'OITO' } })
    orchestrator.jobs = [
      { task: 'OITO-02', status: 'running', cwd: 'C:\\repo-feature' },
      { task: 'OITO-02', status: 'blocked', cwd: 'C:\\repo' },
      { task: 'OITO-03', status: 'queued', cwd: 'C:\\repo\\.alethe\\worktrees\\job-03' },
      { task: 'OITO-05', status: 'done', cwd: 'C:\\repo' },
      { task: 'OITO-06', status: 'running', cwd: 'C:\\other' },
      { task: 'BASE-01', status: 'running', cwd: 'C:\\repo' },
      { task: null, status: 'running', cwd: 'C:\\repo' },
    ]
    render(<TodoSidebar />)
    await waitFor(() => expect(row('OITO-02')).toHaveTextContent('2 running'))
    expect(row('OITO-03')).toHaveTextContent('1 queued')
    for (const id of ['OITO-05', 'OITO-06']) {
      expect(row(id)).not.toHaveTextContent(/running|queued/)
    }
    await expandSection()
    expect(activeRow()).toHaveTextContent('2 running · 1 queued')
    fireEvent.click(screen.getByRole('button', { name: /^Finished/ }))
    expect(screen.getByText('BASE').closest('[data-lane]')).not.toHaveTextContent('running')

    // The board's event updates the counts; a settled worker leaves them.
    act(() =>
      orchestrator.emit?.({
        jobs: [{ task: 'OITO-03', status: 'running', cwd: 'C:\\repo', summary: 'streaming' }],
      }),
    )
    expect(activeRow()).toHaveTextContent('1 running')
    expect(activeRow()).not.toHaveTextContent('queued')
    expect(row('OITO-02')).not.toHaveTextContent('running')
    expect(row('OITO-03')).toHaveTextContent('1 running')
  })
})

describe('Night card', () => {
  const NIGHTS = 'C:\\repo\\.workflow\\local\\noites'
  const diary = (date: string, entradas: unknown[]) => JSON.stringify({ data: date, entradas })
  const entry = (tarefa: string, resultado: string, evidencia = '') => ({
    tarefa,
    resultado,
    resumo: `${tarefa} resumo`,
    evidencia,
    hora: '03:41',
  })
  const card = () => screen.queryByRole('button', { name: /^Night of/ })

  it('is hidden without a diary', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    render(<TodoSidebar />)
    await waitFor(() => expect(listDirectory).toHaveBeenCalledWith(NIGHTS))
    await act(async () => {})
    expect(card()).toBeNull()
  })

  it('shows the latest diary on one line with its non-zero counts, and its entries when opened', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    fs.files.set(`${NIGHTS}\\2026-10-02.json`, diary('2026-10-02', [entry('OLD-01', 'ok')]))
    fs.files.set(
      `${NIGHTS}\\2026-10-03.json`,
      diary('2026-10-03', [
        entry('MOTOR-01', 'aguarda-voce', 'docs/motor.md'),
        entry('MOTOR-02', 'ok', 'a1b2c3d'),
        entry('MOTOR-03', 'ok'),
        entry('MOTOR-04', 'parou'),
        { tarefa: 'MOTOR-05', resultado: 'talvez' },
      ]),
    )
    fs.handoff = 'C:\\repo-feature\\docs\\motor.md'
    render(<TodoSidebar />)
    const toggle = await screen.findByRole('button', { name: /^Night of 10\/03/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveTextContent('2 ok')
    expect(toggle).toHaveTextContent('1 waiting on you')
    expect(toggle).toHaveTextContent('1 stopped')
    expect(toggle).not.toHaveTextContent('failed')
    expect(screen.queryByText('MOTOR-01')).toBeNull()
    // Above the list.
    expect(toggle.compareDocumentPosition(document.querySelector('[data-task]')!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )

    fireEvent.click(toggle)
    await screen.findByRole('button', { name: 'docs/motor.md' })
    const entries = document.querySelectorAll('[data-lane] > [role="img"]')
    expect([...entries].map((dot) => dot.getAttribute('aria-label'))).toEqual([
      'waiting on you',
      'ok',
      'ok',
      'stopped',
    ])
    expect(screen.getByText('MOTOR-01 resumo')).toBeInTheDocument()
    expect(screen.queryByText('MOTOR-05')).toBeNull()
    // A commit is plain text; a path opens through the file pane.
    expect(screen.getByText('a1b2c3d').tagName).toBe('SPAN')
    fireEvent.click(screen.getByRole('button', { name: 'docs/motor.md' }))
    await waitFor(() =>
      expect(useProjectsStore.getState().projects[0].terminals.at(-1)).toMatchObject({
        filePath: 'C:\\repo-feature\\docs\\motor.md',
      }),
    )
    expect(findRelativePath).toHaveBeenCalledWith('C:\\repo', 'docs/motor.md')
  })

  it('watches the folder and every diary, so fixing a malformed newest one shows it', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    const older = `${NIGHTS}\\2026-10-02.json`
    const newest = `${NIGHTS}\\2026-10-03.json`
    fs.files.set(older, diary('2026-10-02', [entry('OLD-01', 'falhou')]))
    fs.files.set(newest, '{"data": "2026-10-03", "entradas": [')
    const { unmount } = render(<TodoSidebar />)
    expect(await screen.findByRole('button', { name: /^Night of 10\/02/ })).toHaveTextContent(
      '1 failed',
    )
    const watchedNights = () =>
      new Set(
        vi
          .mocked(watchFile)
          .mock.calls.map(([path]) => path)
          .filter((path) => path.startsWith(NIGHTS)),
      )
    expect(watchedNights()).toEqual(new Set([NIGHTS, newest, older]))

    // The script fixes the newest diary: its own change event reloads the card.
    fs.files.set(newest, diary('2026-10-03', [entry('MOTOR-01', 'ok')]))
    act(() => fs.onChange?.(newest))
    expect(await screen.findByRole('button', { name: /^Night of 10\/03/ })).toHaveTextContent(
      '1 ok',
    )

    // A new night: the folder's event lists it again, and the new diary is watched too.
    const next = `${NIGHTS}\\2026-10-04.json`
    fs.files.set(next, diary('2026-10-04', [entry('MOTOR-02', 'ok'), entry('MOTOR-03', 'ok')]))
    act(() => fs.onChange?.(NIGHTS))
    expect(await screen.findByRole('button', { name: /^Night of 10\/04/ })).toHaveTextContent(
      '2 ok',
    )
    expect(watchedNights()).toEqual(new Set([NIGHTS, newest, older, next]))

    unmount()
    const unwatched = vi.mocked(unwatchFile).mock.calls.map(([path]) => path)
    expect(unwatched).toEqual(expect.arrayContaining([NIGHTS, newest, older, next]))
  })

  it('links evidence only when it resolves inside one of the checkouts', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    fs.files.set(
      `${NIGHTS}\\2026-10-03.json`,
      diary('2026-10-03', [
        entry('MOTOR-01', 'ok', '../outside/private.md'),
        entry('MOTOR-02', 'ok', 'C:\\secret\\notes.md'),
        entry('MOTOR-03', 'ok', '\\\\server\\share\\notes.md'),
        entry('MOTOR-04', 'ok', 'docs/ok.md'),
        entry('MOTOR-05', 'ok', 'C:\\repo-feature\\docs\\abs.md'),
      ]),
    )
    // find_relative_path joins without any containment check.
    fs.found.set('../outside/private.md', 'C:\\repo\\..\\outside\\private.md')
    render(<TodoSidebar />)
    fireEvent.click(await screen.findByRole('button', { name: /^Night of 10\/03/ }))

    expect(await screen.findByRole('button', { name: 'docs/ok.md' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'C:\\repo-feature\\docs\\abs.md' })).toBeTruthy()
    for (const text of [
      '../outside/private.md',
      'C:\\secret\\notes.md',
      '\\\\server\\share\\notes.md',
    ]) {
      expect(screen.getByText(text).tagName, text).toBe('SPAN')
    }

    // Not found anywhere, a path in the repository still opens, relative to the main checkout.
    fireEvent.click(screen.getByRole('button', { name: 'docs/ok.md' }))
    expect(useProjectsStore.getState().projects[0].terminals.at(-1)).toMatchObject({
      filePath: 'C:\\repo\\docs\\ok.md',
    })
  })

  describe('an entry waiting on you', () => {
    /** The button that opens an entry's actions, or null when it has none. */
    const actions = (id: string) => screen.queryByRole('button', { name: new RegExp(`^${id} `) })
    /** Picks `item` from the entry's menu once a write in flight lets it. */
    const choose = async (id: string, item: string) => {
      fireEvent.click(actions(id)!)
      const choice = within(screen.getByRole('menu')).getByRole('menuitem', { name: item })
      await waitFor(() => expect(choice).toBeEnabled())
      fireEvent.click(choice)
    }

    beforeEach(() => useUiStore.setState({ toasts: [], notifications: [], linkViewerUrl: null }))

    it('is concluded or put back in the queue only by your click', async () => {
      fs.files.set(REGISTRY, JSON.stringify(exemplo))
      fs.files.set(
        `${NIGHTS}\\2026-10-03.json`,
        diary('2026-10-03', [
          entry('OITO-07', 'aguarda-voce', 'docs/oito.md'),
          entry('PARADA-01', 'aguarda-voce'),
          entry('NOTURNA-02', 'aguarda-voce'),
          entry('OITO-03', 'ok', 'docs/ok.md'),
        ]),
      )
      render(<TodoSidebar />)
      fireEvent.click(await screen.findByRole('button', { name: /^Night of/ }))
      await waitFor(() => expect(actions('OITO-07')).not.toBeNull())
      // Other results have no actions, and reading the diary writes nothing.
      expect(actions('OITO-03')).toBeNull()
      expect(campaignRegistryWrite).not.toHaveBeenCalled()

      // Your Gate 2: done, with the night's evidence, and an undo.
      await choose('OITO-07', 'Conclude (Gate 2)')
      await waitFor(() =>
        expect(task('OITO-07')).toMatchObject({ estado: 'concluída', evidencia: 'docs/oito.md' }),
      )
      expect(screen.queryByRole('menu')).toBeNull()
      await waitFor(() => expect(lastToast()?.body).toBe('OITO-07 marked done.'))
      await act(async () => lastToast()?.actions?.[0].run())
      await waitFor(() => expect(task('OITO-07')).toEqual(original('OITO-07')))

      // Without evidence, its summary stands for it.
      await choose('PARADA-01', 'Conclude (Gate 2)')
      await waitFor(() =>
        expect(task('PARADA-01')).toMatchObject({
          estado: 'concluída',
          evidencia: 'PARADA-01 resumo',
        }),
      )

      // Back to the queue: ready for the next night, nothing else changed.
      await waitFor(() => expect(lastToast()?.body).toBe('PARADA-01 marked done.'))
      await choose('NOTURNA-02', 'Back to the queue')
      await waitFor(() =>
        expect(task('NOTURNA-02')).toEqual({ ...original('NOTURNA-02'), estado: 'pronta' }),
      )
    })

    it('undo after a conclusion keeps evidence an agent wrote since', async () => {
      fs.files.set(REGISTRY, JSON.stringify(exemplo))
      fs.files.set(
        `${NIGHTS}\\2026-10-03.json`,
        diary('2026-10-03', [entry('OITO-07', 'aguarda-voce', 'docs/oito.md')]),
      )
      render(<TodoSidebar />)
      fireEvent.click(await screen.findByRole('button', { name: /^Night of/ }))
      await waitFor(() => expect(actions('OITO-07')).not.toBeNull())
      await choose('OITO-07', 'Conclude (Gate 2)')
      await waitFor(() => expect(lastToast()?.body).toBe('OITO-07 marked done.'))

      // An agent records other evidence; the task stays done, and the panel reloads.
      await editRegistry((data) => {
        Object.assign(data.campanhas[1].tarefas[6], { evidencia: 'PR #60' })
      })
      await act(async () => lastToast()?.actions?.[0].run())
      await waitFor(() => expect(task('OITO-07')?.estado).toBe('bloqueada'))
      expect(task('OITO-07')).toEqual({ ...original('OITO-07'), evidencia: 'PR #60' })
    })

    it('closes on Escape and gives the focus back to its entry, or to the card once it is gone', async () => {
      fs.files.set(REGISTRY, JSON.stringify(exemplo))
      fs.files.set(
        `${NIGHTS}\\2026-10-03.json`,
        diary('2026-10-03', [entry('OITO-07', 'aguarda-voce', 'docs/oito.md')]),
      )
      fs.found.set('docs/oito.md', 'C:\\repo\\docs\\oito.md')
      render(<TodoSidebar />)
      const card = await screen.findByRole('button', { name: /^Night of/ })
      fireEvent.click(card)
      await waitFor(() => expect(actions('OITO-07')).not.toBeNull())
      const trigger = actions('OITO-07')!
      /** Opens the menu and moves the focus onto `name`, as the keyboard would. */
      const focusItem = async (name: string) => {
        fireEvent.click(trigger)
        const item = await screen.findByRole('menuitem', { name })
        await waitFor(() => expect(item).toBeEnabled())
        item.focus()
        return item
      }

      fireEvent.keyDown(await focusItem('Open evidence'), { key: 'Escape' })
      expect(screen.queryByRole('menu')).toBeNull()
      expect(trigger).toHaveFocus()

      fireEvent.click(await focusItem('Open evidence'))
      expect(screen.queryByRole('menu')).toBeNull()
      expect(trigger).toHaveFocus()

      // The registry the write returns no longer lists the task: its entry loses the actions.
      vi.mocked(campaignRegistryWrite).mockImplementationOnce(async (path, _expected, content) => {
        const data = JSON.parse(content) as typeof exemplo
        data.campanhas[1].tarefas = data.campanhas[1].tarefas.filter(
          (item) => item.id !== 'OITO-07',
        )
        const written = JSON.stringify(data)
        fs.files.set(path, written)
        return written
      })
      fireEvent.click(await focusItem('Conclude (Gate 2)'))
      await waitFor(() => expect(actions('OITO-07')).toBeNull())
      await waitFor(() => expect(card).toHaveFocus())
    })

    it('opens its evidence and continues its campaign in the terminal', async () => {
      fs.files.set(REGISTRY, JSON.stringify(exemplo))
      fs.files.set(
        `${NIGHTS}\\2026-10-03.json`,
        diary('2026-10-03', [
          entry('OITO-07', 'aguarda-voce', 'docs/oito.md'),
          entry('PARADA-01', 'aguarda-voce', 'src/parada.ts'),
          entry('NOTURNA-02', 'aguarda-voce', 'a1b2c3d'),
        ]),
      )
      fs.found.set('docs/oito.md', 'C:\\repo-feature\\docs\\oito.md')
      fs.found.set('src/parada.ts', 'C:\\repo\\src\\parada.ts')
      const tagged = openTerminal('C:\\repo', 'claude', 'PARADA')
      render(<TodoSidebar />)
      fireEvent.click(await screen.findByRole('button', { name: /^Night of/ }))
      await waitFor(() => expect(actions('OITO-07')).not.toBeNull())

      // Markdown opens in the viewer, any other file in a pane, as from a terminal link.
      await choose('OITO-07', 'Open evidence')
      expect(useUiStore.getState().linkViewerUrl).toBe('C:\\repo-feature\\docs\\oito.md')
      await choose('PARADA-01', 'Open evidence')
      expect(useProjectsStore.getState().projects[0].terminals.at(-1)).toMatchObject({
        filePath: 'C:\\repo\\src\\parada.ts',
      })
      // A commit is not a path: nothing to open.
      fireEvent.click(actions('NOTURNA-02')!)
      expect(screen.queryByRole('menuitem', { name: 'Open evidence' })).toBeNull()
      fireEvent.click(actions('NOTURNA-02')!)

      // A campaign with its tab open continues there.
      focusTerminal(useProjectsStore.getState().projects[0].terminals.at(-1)!.id)
      await choose('PARADA-01', 'Continue in the terminal')
      expect(useUiStore.getState().activeTerminal?.terminalId).toBe(tagged.id)

      // One without offers the agents, as Open does.
      await choose('OITO-07', 'Continue in the terminal')
      fireEvent.click(screen.getByRole('menuitem', { name: 'Codex' }))
      await waitFor(() =>
        expect(agentTerminals().find((item) => item.tabs[0].campaignId === 'OITO')).toBeDefined(),
      )
      expect(
        agentTerminals().find((item) => item.tabs[0].campaignId === 'OITO')!.tabs[0],
      ).toMatchObject({ type: 'codex', cwd: 'C:\\repo' })
      expect(campaignRegistryWrite).not.toHaveBeenCalled()
    })
  })
})

describe('Findings card', () => {
  const FILE = 'C:\\repo\\.workflow\\achados.json'
  const finding = (id: string, fields: Record<string, unknown> = {}) => ({
    id,
    data: '2026-10-03',
    tipo: 'bug',
    titulo: `${id} title`,
    origem: 'MOTOR-01',
    detalhe: '',
    estado: 'novo',
    ...fields,
  })
  const file = (...achados: unknown[]) => JSON.stringify({ versao: 1, achados })
  const card = () => screen.queryByRole('button', { name: /^Findings/ })
  /** The card's header, once it shows `count` findings. */
  const findCard = async (count: number) =>
    screen.findByRole('button', { name: new RegExp(`^Findings ${count}$`) })

  it('is hidden without the file or without new findings', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    render(<TodoSidebar />)
    await waitFor(() => expect(watchFile).toHaveBeenCalledWith(FILE))
    expect(card()).toBeNull()
  })

  it('counts new findings, collapsed, and lists them as plain text when opened', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    fs.files.set(
      FILE,
      file(
        finding('ACH-0001', { tipo: 'risco', data: '2026-10-02' }),
        finding('ACH-0002', {
          tipo: 'ideia',
          detalhe: 'docs/x.md',
          titulo: '<b>bold</b> [a](http://x)',
        }),
        finding('ACH-0003', { estado: 'descartado' }),
        finding('ACH-0004', { tipo: 'divida', origem: '' }),
        { id: 'ACH-0005', tipo: 'nope' },
      ),
    )
    render(<TodoSidebar />)
    const toggle = await findCard(3)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('ACH-0001 title')).toBeNull()

    fireEvent.click(toggle)
    const rows = [...document.querySelectorAll('[data-finding]')]
    expect(rows.map((row) => row.getAttribute('data-finding'))).toEqual([
      'ACH-0002',
      'ACH-0004',
      'ACH-0001',
    ])
    expect(rows[0]).toHaveAttribute('title', 'docs/x.md')
    expect(rows[0].querySelector('[role="img"]')).toHaveAttribute('aria-label', 'idea')
    expect(rows[1].querySelector('[role="img"]')).toHaveAttribute('aria-label', 'debt')
    expect(rows[2].querySelector('[role="img"]')).toHaveAttribute('aria-label', 'risk')
    expect(screen.getByText('<b>bold</b> [a](http://x)')).toBeInTheDocument()
    // The title, then the finding's own id, its type, the task it came from, and its date.
    expect(rows[0]).toHaveTextContent('ACH-0002 · idea · MOTOR-01 · 10/03')
    expect(rows[1]).toHaveTextContent('ACH-0004 title')
    expect(rows[1]).toHaveTextContent('ACH-0004 · debt · — · 10/03')
    expect(rows[2]).toHaveTextContent('ACH-0001 · risk · MOTOR-01 · 10/02')
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('refreshes on a file change, appears when the file is created, and hides when all are triaged', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    const { unmount } = render(<TodoSidebar />)
    await waitFor(() => expect(watchFile).toHaveBeenCalledWith(FILE))
    // Absent file: the folder is watched too, and its event reports the new file.
    expect(watchFile).toHaveBeenCalledWith('C:\\repo\\.workflow')
    expect(card()).toBeNull()

    fs.files.set(FILE, file(finding('ACH-0001')))
    act(() => fs.onChange?.(FILE))
    expect(await findCard(1)).toBeInTheDocument()

    fs.files.set(FILE, file(finding('ACH-0001'), finding('ACH-0002')))
    act(() => fs.onChange?.(FILE))
    expect(await findCard(2)).toBeInTheDocument()

    fs.files.set(
      FILE,
      file(
        finding('ACH-0001', { estado: 'descartado' }),
        finding('ACH-0002', { estado: 'virou-tarefa' }),
      ),
    )
    act(() => fs.onChange?.(FILE))
    await waitFor(() => expect(card()).toBeNull())

    unmount()
    const unwatched = vi.mocked(unwatchFile).mock.calls.map(([path]) => path)
    expect(unwatched).toEqual(expect.arrayContaining([FILE, 'C:\\repo\\.workflow']))
  })
})

describe('Modo noite', () => {
  const projectId = () => useProjectsStore.getState().projects[0].id

  it('is off by default and saves the project’s window and limits from the settings', async () => {
    useUiStore.setState({ openModal: TODO_SETTINGS_MODAL_ID })
    render(<TodoSettingsModal />)
    const enable = screen.getByRole('checkbox', { name: /Run this project/ })
    expect(enable).not.toBeChecked()
    expect(screen.getByText(/Alethe must stay open and the computer awake/)).toBeInTheDocument()

    fireEvent.click(enable)
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '22:30' } })
    fireEvent.change(screen.getByLabelText('End'), { target: { value: '05:00' } })
    fireEvent.change(screen.getByLabelText('Minutes per task'), { target: { value: '60' } })
    fireEvent.change(screen.getByLabelText('Tasks per night'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(useTodosStore.getState().nightSettings[projectId()]).toEqual({
        enabled: true,
        start: '22:30',
        end: '05:00',
        maxMinutesPerTask: 60,
        maxTasks: 3,
      }),
    )
  })

  it('leaves Modo noite alone when other settings are saved', async () => {
    useUiStore.setState({ openModal: TODO_SETTINGS_MODAL_ID })
    render(<TodoSettingsModal />)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(useUiStore.getState().openModal).toBeNull())
    expect(useTodosStore.getState().nightSettings).toEqual({})
  })

  it('shows the running task with its elapsed time, then why the night ended until noon', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 3, 23, 42))
    try {
      const night = {
        night: '2026-10-03',
        started: 5,
        failures: 0,
        stopped: 'max' as const,
        attempted: [],
      }
      const running = {
        projectId: projectId(),
        campaignId: 'OITO',
        taskId: 'OITO-02',
        terminalId: 't',
        tabId: 'tab',
        startedAt: new Date(2026, 9, 3, 23, 0).getTime(),
        deadline: new Date(2026, 9, 4, 0, 30).getTime(),
      }
      useTodosStore.setState({ nightRun: { current: running, nights: {} } })
      render(<TodoSidebar />)
      expect(await screen.findByText('Night running: OITO-02 · 00:42')).toBeInTheDocument()

      // Started although Claude's usage could not be read.
      act(() =>
        useTodosStore.setState({
          nightRun: { current: { ...running, quotaUnread: true }, nights: {} },
        }),
      )
      expect(
        screen.getByText('Night running: OITO-02 · 00:42 · quota not read'),
      ).toBeInTheDocument()

      act(() =>
        useTodosStore.setState({ nightRun: { current: null, nights: { [projectId()]: night } } }),
      )
      expect(screen.getByText('Night over: task limit')).toBeInTheDocument()

      act(() =>
        useTodosStore.setState({
          nightRun: { current: null, nights: { [projectId()]: { ...night, stopped: 'diary' } } },
        }),
      )
      expect(screen.getByText('Night over: diary not written')).toBeInTheDocument()

      // The night of the 2nd ended at noon today.
      act(() =>
        useTodosStore.setState({
          nightRun: { current: null, nights: { [projectId()]: { ...night, night: '2026-10-02' } } },
        }),
      )
      expect(screen.queryByText(/Night over/)).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Watch references', () => {
  const FILE = 'C:\\repo\\.workflow\\achados.json'
  const FOLDER = 'C:\\repo\\.workflow'
  const one = JSON.stringify({
    achados: [
      { id: 'A-1', data: '2026-10-03', tipo: 'bug', titulo: 'T', origem: '', estado: 'novo' },
    ],
  })
  const calls = (mock: typeof watchFile, path: string) =>
    vi.mocked(mock).mock.calls.filter(([p]) => p === path).length

  // Every registration stays pending until `settle`, as a slow backend would.
  async function remountWhilePending(path: string) {
    const pending: Array<() => void> = []
    vi.mocked(watchFile).mockImplementation((watched: string) =>
      watched === path ? new Promise<void>((resolve) => pending.push(resolve)) : Promise.resolve(),
    )
    try {
      fs.files.set(REGISTRY, JSON.stringify(exemplo))
      fs.files.set(FILE, one)
      const first = render(<TodoSidebar />)
      await waitFor(() => expect(calls(watchFile, path)).toBe(1))
      first.unmount()
      // Nothing may be released while the registration is still pending.
      expect(calls(unwatchFile, path)).toBe(0)
      render(<TodoSidebar />)
      await waitFor(() => expect(calls(watchFile, path)).toBe(2))
      await act(async () => {
        pending.forEach((resolve) => resolve())
      })
      await act(async () => {})
      expect(calls(watchFile, path) - calls(unwatchFile, path)).toBe(1)
    } finally {
      vi.mocked(watchFile).mockImplementation(async () => {})
    }
  }

  it('keeps one reference to the findings file after a remount', async () => {
    await remountWhilePending(FILE)
  })

  it('keeps one reference to the night folder after a remount', async () => {
    const nights = 'C:\\repo\\.workflow\\local\\noites'
    fs.files.set(`${nights}\\2026-10-03.json`, JSON.stringify({ data: '2026-10-03', entradas: [] }))
    await remountWhilePending(nights)
  })

  it('watches the folder only while the file is absent', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    render(<TodoSidebar />)
    await waitFor(() => expect(calls(watchFile, FOLDER)).toBe(1))

    fs.files.set(FILE, one)
    act(() => fs.onChange?.(FILE))
    await screen.findByRole('button', { name: 'Findings 1' })
    expect(calls(unwatchFile, FOLDER)).toBe(1)
    expect(calls(unwatchFile, FILE)).toBe(0)

    fs.files.delete(FILE)
    act(() => fs.onChange?.(FILE))
    await waitFor(() => expect(calls(watchFile, FOLDER)).toBe(2))
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Findings/ })).toBeNull())
  })

  it('renders at most 200 findings and counts the rest', async () => {
    const many = Array.from({ length: 205 }, (_, index) => ({
      id: `A-${String(index).padStart(4, '0')}`,
      data: '2026-10-03',
      tipo: 'ideia',
      titulo: `T${index}`,
      origem: '',
      estado: 'novo',
    }))
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    fs.files.set(FILE, JSON.stringify({ achados: many }))
    render(<TodoSidebar />)
    fireEvent.click(await screen.findByRole('button', { name: 'Findings 205' }))
    expect(document.querySelectorAll('[data-finding]')).toHaveLength(200)
    expect(screen.getByText('+5 more')).toBeInTheDocument()
  })
})

describe('campaignLiveStatus', () => {
  const { campaigns } = parseCampaigns(JSON.stringify(exemplo))!
  const tab = (campaignId: string | undefined, ptyId: string | null) =>
    ({ campaignId, ptyId }) as SubTab

  it('keeps the campaigns with a tab or a live worker: working while one of them runs', () => {
    const live = campaignLiveStatus(
      campaigns,
      [
        { tabs: [tab('PARADA', 'p1'), tab('OITO', 'p2'), tab(undefined, 'p3')] },
        { tabs: [tab('OITO', null)] },
      ],
      { p1: { status: 'waiting' }, p2: { status: 'working' }, p3: { status: 'working' } },
      new Map([
        ['DEPOIS-01', { running: 0, queued: 1 }],
        ['NOTURNA-02', { running: 1, queued: 0 }],
      ]),
    )
    expect(Object.fromEntries(live)).toEqual({
      OITO: 'working',
      DEPOIS: 'stopped',
      NOTURNA: 'working',
      PARADA: 'stopped',
    })
  })
})

describe('campaign dots', () => {
  const css = readFileSync(resolve('src/plugins/todos/CampaignsSection.module.css'), 'utf8')
  const rule = (selector: string) =>
    css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`))?.[1]

  it('blink once every 1.5 s while the campaign works, never when stopped or with reduced motion', () => {
    const working = rule(".campaign[data-status='working'] .dot")
    expect(working).toContain('background: var(--status-working)')
    const keyframes = /animation: ([\w-]+) 1\.5s /.exec(working ?? '')?.[1]
    expect(keyframes).toBeDefined()
    expect(css).toContain(`@keyframes ${keyframes} {`)
    expect(rule(".campaign[data-status='stopped'] .dot")).not.toContain('animation')
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toMatch(/\.campaign\[data-status='working'\] \.dot[^{]*\{[^}]*animation: none/)
  })
})
