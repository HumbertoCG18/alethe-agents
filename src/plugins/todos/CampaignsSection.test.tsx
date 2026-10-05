import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import exemplo from '../../lib/__fixtures__/campanhas.exemplo.json'
import { isoDay, parseCampaigns } from '../../lib/campaigns'
import { EMPTY_PROJECTS_FILE, type SubTab } from '../../lib/types'
import { useCampaignStepsStore } from '../../stores/campaignStepsStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { useSessionStore } from '../../stores/sessionStore'
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
/** The session store's change event, as the backend sends it. */
const sessionEvents = vi.hoisted(() => ({
  emit: (_change: { provider: string; cwd: string; sessionId: string; revision: number }) => {},
}))

const orchestrator = vi.hoisted(() => ({
  jobs: [] as Array<{ id?: string; task?: string | null; status: string; cwd: string }>,
  emit: null as ((snapshot: { jobs: unknown[] }) => void) | null,
}))

/** Yes or no to the native confirmation; no unless a test says otherwise, as a failed dialog. */
const askConfirm = vi.hoisted(() => vi.fn(async (_message: string, _options?: unknown) => false))

vi.mock('../../lib/terminalLifecycle', () => ({ cleanupPtys: vi.fn() }))
vi.mock('../../lib/dialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/dialog')>()),
  askConfirm,
}))
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
  openInFileExplorer: vi.fn(async () => {}),
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
  writePty: vi.fn(async () => {}),
  recordFrontendError: vi.fn(async () => {}),
  // No session to read unless a test gives one.
  sessionRead: vi.fn(async () => ({
    sessionId: null,
    revision: 0,
    unchanged: false,
    events: [],
    title: null,
  })),
  sessionSubscribe: vi.fn(async () => {}),
  sessionUnsubscribe: vi.fn(async () => {}),
  listenSessionChanged: vi.fn(async (handler: typeof sessionEvents.emit) => {
    sessionEvents.emit = handler
    return () => {}
  }),
  ensureTodoTemplate: vi.fn(async () => {}),
  // The backend finishes a cancelled worker at once: the next snapshot shows it cancelled.
  orchestratorCancel: vi.fn(async (jobId: string) => {
    orchestrator.jobs = orchestrator.jobs.map((job) =>
      job.id === jobId ? { ...job, status: 'cancelled' } : job,
    )
    return null
  }),
}))

import {
  campaignRegistryWrite,
  ensureTodoTemplate,
  findRelativePath,
  listDirectory,
  openInFileExplorer,
  orchestratorCancel,
  orchestratorJobs,
  readTextFile,
  recordFrontendError,
  sessionRead,
  sessionSubscribe,
  unwatchFile,
  watchFile,
  worktreeCheckouts,
  writePty,
} from '../../lib/tauri'
import { cleanupPtys } from '../../lib/terminalLifecycle'
import { CampaignsSection } from './CampaignsSection'
import {
  campaignLiveStatus,
  logRegistryProblem,
  openCampaign,
  resumeCampaign,
  useCampaignView,
  useTaskJobs,
  useTaskWorkers,
} from './campaignView'
import { TODO_SETTINGS_MODAL_ID } from './manifest'
import { resetTodosStoreForTests, useTodosStore } from './store'
import { TodoSettingsModal } from './TodoSettingsModal'
import { TodoSidebar } from './TodoSidebar'

const REGISTRY = 'C:\\repo\\.workflow\\campanhas.json'

/** The section as the Todo tab mounts it. */
function Section() {
  const view = useCampaignView()
  return <CampaignsSection view={view} workers={useTaskWorkers(view.registry, useTaskJobs())} />
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
const group = (name: 'Started' | 'Not started') =>
  screen.queryByRole('button', { name: new RegExp(`^${name} \\d+$`) })
/** The project's agent terminals, without the panes opened next to them. */
const agentTerminals = () =>
  useProjectsStore
    .getState()
    .projects[0].terminals.filter((terminal) => (terminal.kind ?? 'terminal') === 'terminal')

function openTerminal(cwd: string, type: 'shell' | 'claude' | 'codex', campaignId?: string) {
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

  it('shows up in the Overview tab after Active, and not in Personal', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    render(<TodoSidebar />)
    const toggle = await screen.findByRole('button', { name: /^Campaigns/ })
    expect(screen.getByRole('button', { name: /^Active/ }).compareDocumentPosition(toggle)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )

    fireEvent.click(screen.getByRole('tab', { name: /^Personal/ }))
    expect(screen.getByText('Nothing on your list')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Campaigns/ })).toBeNull()
  })

  it('puts the campaign of the focused terminal first, highlighted, and follows the focus', async () => {
    const registry = structuredClone(exemplo)
    Object.assign(registry.campanhas[4], { worktrees: ['repo-feature'] })
    fs.files.set(REGISTRY, JSON.stringify(registry))
    const projectId = useProjectsStore.getState().projects[0].id
    const tagged = openTerminal('C:\\repo', 'shell', 'PARADA')
    const inWorktree = openTerminal('C:\\repo-feature', 'claude')
    render(<Section />)
    await expandSection()
    // PARADA has a tab opened for it: it is Active, so the map leaves it out.
    expect(rowOrder()).toEqual(['OITO', 'ABERTA', 'DEPOIS', 'NOTURNA'])
    expect(activeRow()).toBeNull()

    // The tab opened for PARADA wins, although it sits in the main checkout.
    focusTerminal(tagged.id)
    expect(useTodosStore.getState().activeCampaigns).toEqual({ [projectId]: 'PARADA' })
    expect(activeRow()).toBeNull()

    // Any other terminal counts by the worktree its cwd is in; NOTURNA leads Not started.
    focusTerminal(inWorktree.id)
    expect(rowOrder()).toEqual(['OITO', 'ABERTA', 'NOTURNA', 'DEPOIS'])
    expect(activeRow()).toHaveTextContent('NOTURNA')

    // With no campaign terminal focused, the last active campaign of the project stays first.
    act(() => useUiStore.setState({ activeTerminal: null }))
    expect(rowOrder()).toEqual(['OITO', 'ABERTA', 'NOTURNA', 'DEPOIS'])
    expect(useTodosStore.getState().activeCampaigns).toEqual({ [projectId]: 'NOTURNA' })

    // Continue never takes over a terminal opened by hand: it offers the agents and starts a tab
    // tagged for NOTURNA, even though a Claude tab already runs in its worktree.
    fireEvent.click(screen.getByRole('button', { name: 'Continue campaign NOTURNA' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Claude Code' }))
    await waitFor(() => expect(agentTerminals()).toHaveLength(3))
    const created = agentTerminals()[2]
    expect(created.tabs[0]).toMatchObject({
      type: 'claude',
      cwd: 'C:\\repo-feature',
      campaignId: 'NOTURNA',
    })
    expect(useUiStore.getState().activeTerminal?.terminalId).toBe(created.id)
  })

  it('groups the map into Started and Not started, leaving out live and finished campaigns', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    // PARADA and BASE have a tab open for them, DEPOIS a live worker.
    openTerminal('C:\\repo', 'claude', 'PARADA')
    openTerminal('C:\\repo', 'shell', 'BASE')
    orchestrator.jobs = [{ task: 'DEPOIS-01', status: 'queued', cwd: 'C:\\repo' }]
    render(<Section />)
    await expandSection()
    // Live, PARADA and DEPOIS are Active; BASE is finished, under Completed.
    await waitFor(() => expect(rowOrder()).toEqual(['OITO', 'ABERTA', 'NOTURNA']))
    expect(screen.getByRole('button', { name: /Campaigns/ })).toHaveTextContent('3')
    // Started: OITO has a task done and one in progress, ABERTA a task done (it is not fully
    // decomposed, so it stays open). NOTURNA has neither.
    expect(group('Started')).toHaveTextContent('2')
    expect(group('Started')).toHaveAttribute('aria-expanded', 'true')
    expect(group('Not started')).toHaveTextContent('1')
    fireEvent.click(group('Not started')!)
    expect(rowOrder()).toEqual(['OITO', 'ABERTA'])
    fireEvent.click(group('Not started')!)

    // Once its worker settles, DEPOIS is back in the map, not started.
    act(() => orchestrator.emit?.({ jobs: [] }))
    expect(group('Not started')).toHaveTextContent('2')
    expect(
      within(screen.getByRole('group', { name: 'Not started' }))
        .getAllByText(IDS)
        .map((element) => element.textContent),
    ).toEqual(['DEPOIS', 'NOTURNA'])
  })

  it('nests Started and Not started under Campaigns as lighter sub-groups that hold their rows', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    openTerminal('C:\\repo', 'claude', 'PARADA')
    render(<Section />)
    await expandSection()
    const campaigns = screen.getByRole('button', { name: /^Campaigns/ })
    expect(campaigns.parentElement).not.toHaveAttribute('data-variant')

    const members = {
      Started: ['OITO', 'ABERTA'],
      'Not started': ['DEPOIS', 'NOTURNA'],
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

  it('shows a finished campaign running only while its tab works or a worker runs one of its tasks', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    const terminal = openTerminal('C:\\repo', 'claude', 'BASE')
    const projectId = useProjectsStore.getState().projects[0].id
    useProjectsStore.getState().setSubTabPtyId(projectId, terminal.id, terminal.tabs[0].id, 'pty-b')
    useTerminalsStore.getState().registerPty('pty-b')
    const setStatus = (status: 'working' | 'waiting') =>
      act(() => useTerminalsStore.getState().setStatus('pty-b', status))
    render(<TodoSidebar />)
    fireEvent.click(await screen.findByRole('button', { name: /^Completed/ }))
    const row = () => screen.getByText('BASE').closest('[data-status]')
    expect(row()).toHaveAttribute('data-status', 'stopped')
    expect(row()).toHaveTextContent('Stopped')

    setStatus('working')
    expect(row()).toHaveAttribute('data-status', 'working')
    expect(row()).toHaveTextContent('Running')
    setStatus('waiting')
    expect(row()).toHaveAttribute('data-status', 'stopped')

    // A queued worker keeps it live but not running; a running one runs it.
    act(() =>
      orchestrator.emit?.({ jobs: [{ task: 'BASE-01', status: 'queued', cwd: 'C:\\repo' }] }),
    )
    expect(row()).toHaveAttribute('data-status', 'stopped')
    act(() =>
      orchestrator.emit?.({ jobs: [{ task: 'BASE-01', status: 'running', cwd: 'C:\\repo' }] }),
    )
    expect(row()).toHaveAttribute('data-status', 'working')

    // With nothing live for it, a task left in progress is not shown as running.
    fireEvent.click(screen.getByRole('button', { name: /^Campaigns/ }))
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

    // Open, it is Active: it leaves the map.
    await waitFor(() => expect(screen.queryByText('OITO')).toBeNull())
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
    await waitFor(() => expect(screen.queryByText('OITO')).toBeNull())
  })

  it('closes the agent menu on Escape, and gives the focus back to its button', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    render(<Section />)
    await expandSection()
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

  it('offers Continue only on the active row; a campaign with a tab has no row in the map', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    const projectId = useProjectsStore.getState().projects[0].id
    useTodosStore.setState({ activeCampaigns: { [projectId]: 'OITO' } })
    openTerminal('C:\\repo', 'claude', 'PARADA')
    render(<Section />)
    await expandSection()
    expect(screen.getAllByRole('button', { name: /^Continue campaign/ })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Continue campaign OITO' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open campaign DEPOIS' })).toBeInTheDocument()
    expect(screen.queryByText('PARADA')).toBeNull()
  })

  it('goes to a campaign tab in a disabled terminal of another grid, from Home', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    const projectId = useProjectsStore.getState().projects[0].id
    const tagged = openTerminal('C:\\repo', 'claude', 'PARADA')
    const store = useProjectsStore.getState()
    const shown = store.createProjectGrid(projectId, 'Shown')!
    const other = store.createProjectGrid(projectId, 'Other')!
    store.moveTerminalToGrid(projectId, tagged.id, other)
    store.openProjectGrid(projectId, shown)
    store.setTerminalDisabled(projectId, tagged.id, true)
    useUiStore.getState().setActiveView('home')
    const visible = () =>
      useProjectsStore
        .getState()
        .workspace.containers.some((container) => container.paneIds.includes(tagged.id))
    expect(visible()).toBe(false)
    render(<TodoSidebar />)
    // Its tab makes it live, so it is Active, where Go to tab reaches that tab.
    const parada = await screen.findByRole('group', { name: 'PARADA' })

    fireEvent.click(within(parada).getByRole('button', { name: 'Go to tab' }))
    await waitFor(() => expect(agentTerminals()[0].disabled).toBe(false))
    expect(agentTerminals()).toHaveLength(1)
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
    // Not started, it leads its group.
    expect(within(screen.getByRole('group', { name: 'Not started' })).getAllByText(IDS)[0]).toBe(
      screen.getByText('PARADA'),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Continue campaign PARADA' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Codex' }))
    await waitFor(() => expect(agentTerminals()).toHaveLength(1))
    const [terminal] = agentTerminals()
    expect(terminal.tabs[0]).toMatchObject({ type: 'codex', cwd: 'C:\\repo', campaignId: 'PARADA' })
    expect(useUiStore.getState().activeTerminal?.terminalId).toBe(terminal.id)
  })

  it('opens the chosen agent in the campaign worktree, after which it leaves the map', async () => {
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
        'Retome a campanha OITO («Uma de oito feitas: 12,5% arredonda para 13») pelo registro ' +
        `${REGISTRY} e pelo handoff «C:\\repo\\docs\\handoff.md».`,
    })
    expect(useUiStore.getState().activeTerminal?.terminalId).toBe(terminal.id)
    // Its tab makes it Active: it leaves the map.
    await waitFor(() => expect(rowOrder()).not.toContain('OITO'))
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

describe('Opening a campaign beside an active one', () => {
  const projectId = () => useProjectsStore.getState().projects[0].id
  /** The fixture as the Todo tab reads it. */
  const registry = () => {
    const text = JSON.stringify(exemplo)
    return {
      ...parseCampaigns(text)!,
      projectId: projectId(),
      path: REGISTRY,
      main: 'C:\\repo',
      checkouts: {
        main: 'C:\\repo',
        worktrees: [{ path: 'C:\\repo', branch: 'dev', lastCommitMs: null }],
      },
      text,
    }
  }
  const named = (id: string) => registry().campaigns.find((campaign) => campaign.id === id)!
  const BLOCKED = 'NOTURNA waits on OITO (OITO-02): the two cannot be active at once.'

  beforeEach(() => useUiStore.setState({ toasts: [], notifications: [] }))

  it('refuses from the map a campaign waiting on one with an open tab, and opens an unrelated one', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    // NOTURNA-01 waits on OITO-02, in progress.
    openTerminal('C:\\repo', 'claude', 'OITO')
    render(<Section />)
    await expandSection()
    fireEvent.click(screen.getByRole('button', { name: 'Open campaign NOTURNA' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Claude Code' }))
    await waitFor(() =>
      expect(lastToast()).toMatchObject({ title: 'Campaign NOTURNA not opened', body: BLOCKED }),
    )
    expect(agentTerminals()).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Open campaign PARADA' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Claude Code' }))
    await waitFor(() => expect(agentTerminals()).toHaveLength(2))
    expect(agentTerminals()[1].tabs[0].campaignId).toBe('PARADA')
    expect(useUiStore.getState().toasts).toHaveLength(1)
  })

  it('refuses one an open campaign waits on; the night and a campaign already open go through', async () => {
    openTerminal('C:\\repo', 'claude', 'NOTURNA')
    expect(await openCampaign(projectId(), named('OITO'), 'claude', registry())).toBeNull()
    expect(lastToast()).toMatchObject({ title: 'Campaign OITO not opened', body: BLOCKED })
    expect(agentTerminals()).toHaveLength(1)

    // The night scheduler is never refused.
    const oito = named('OITO')
    const night = oito.tasks.find((item) => item.id === 'OITO-08')!
    const opened = await openCampaign(projectId(), oito, 'claude', registry(), night)
    expect(agentTerminals()).toHaveLength(2)
    expect(agentTerminals()[1]).toMatchObject({ id: opened, tabs: [{ campaignId: 'OITO' }] })

    // With a tab of its own, OITO is focused there as before.
    act(() => useUiStore.setState({ activeTerminal: null }))
    expect(await openCampaign(projectId(), oito, 'claude', registry())).toBe(opened)
    expect(useUiStore.getState().activeTerminal?.terminalId).toBe(opened)
    expect(agentTerminals()).toHaveLength(2)
    expect(useUiStore.getState().toasts).toHaveLength(1)
  })

  it('refuses a campaign whose blocker opened while its handoff was looked up', async () => {
    let release: (path: string | null) => void = () => {}
    vi.mocked(findRelativePath).mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    )
    const noturna = { ...named('NOTURNA'), handoff: 'docs/handoff.md' }
    const opening = openCampaign(projectId(), noturna, 'claude', registry())
    openTerminal('C:\\repo', 'claude', 'OITO')
    release(null)
    expect(await opening).toBeNull()
    expect(lastToast()).toMatchObject({ title: 'Campaign NOTURNA not opened', body: BLOCKED })
    expect(agentTerminals()).toHaveLength(1)
  })

  it('continues on a tab of any agent that opened while its handoff was looked up', async () => {
    let release: (path: string | null) => void = () => {}
    vi.mocked(findRelativePath).mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    )
    const parada = { ...named('PARADA'), handoff: 'docs/handoff.md' }
    const resuming = resumeCampaign(projectId(), parada, registry(), parada.tasks[0])
    const codex = openTerminal('C:\\repo', 'codex', 'PARADA')
    release(null)
    await resuming
    expect(agentTerminals()).toHaveLength(1)
    expect(useUiStore.getState().activeTerminal?.terminalId).toBe(codex.id)
  })
})

describe('Active campaigns in the Todo tab', () => {
  const projectId = () => useProjectsStore.getState().projects[0].id
  /** A Claude Code tab opened for `campaignId` in `project`, which makes the campaign active. */
  const activate = (campaignId = 'OITO', project = projectId(), cwd = 'C:\\repo') =>
    useProjectsStore.getState().createTerminal(project, {
      name: campaignId,
      cwd,
      firstTab: { type: 'claude', cwd, campaignId },
    })
  /** Task ids in the order the main list shows them. */
  const listed = () =>
    [...document.querySelectorAll('[data-task]')].map((row) => row.getAttribute('data-task'))
  const row = (id: string) => document.querySelector(`[data-task="${id}"]`) as HTMLElement

  beforeEach(() => useUiStore.setState({ toasts: [], notifications: [] }))

  it('lists an active campaign with its progress, its done tasks collapsed at its end', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    activate()
    render(<TodoSidebar />)
    await waitFor(() => expect(row('OITO-03')).not.toBeNull())
    expect(screen.queryByText('Nothing on your list')).not.toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveTextContent('1 / 8')
    expect(listed()).toEqual([
      'OITO-02',
      'OITO-03',
      'OITO-04',
      'OITO-05',
      'OITO-08',
      'OITO-06',
      'OITO-07',
    ])
    fireEvent.click(screen.getByRole('button', { name: '1 done' }))
    expect(listed()).toHaveLength(8)
    expect(listed().at(-1)).toBe('OITO-01')
    expect(row('OITO-03')).toHaveTextContent('pronta sem dependência')
  })

  it('counts an undecomposed campaign as +?', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    activate('ABERTA')
    render(<TodoSidebar />)
    const aberta = await screen.findByRole('group', { name: 'ABERTA' })
    expect(within(aberta).getByRole('button', { name: /^ABERTA ·/ })).toHaveTextContent('1/1+?')
    expect(screen.getByRole('progressbar')).toHaveTextContent('1 / 1+?')
    expect(within(aberta).getByText('No tasks here.')).toBeInTheDocument()
    fireEvent.click(within(aberta).getByRole('button', { name: '1 done' }))
    expect(listed()).toEqual(['ABERTA-01'])
  })

  it('keeps campaign tasks and personal todos apart, each in its own tab', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    activate()
    useTodosStore.getState().createTodo('Personal one')
    render(<TodoSidebar />)
    await waitFor(() => expect(row('OITO-03')).not.toBeNull())
    expect(screen.queryByText('Personal one')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /^Personal/ }))
    expect(screen.getByText('Personal one')).toBeInTheDocument()
    expect(listed()).toEqual([])
  })

  it('adds a task to an active campaign with the next id, through the registry write', async () => {
    const text = JSON.stringify(exemplo)
    fs.files.set(REGISTRY, text)
    activate()
    render(<TodoSidebar />)
    const plus = async () =>
      fireEvent.click(await screen.findByRole('button', { name: 'Add a task to OITO…' }))
    const field = () => screen.getByPlaceholderText('Add a task to OITO…')
    await plus()

    fireEvent.change(field(), { target: { value: '  Nova tarefa  ' } })
    fireEvent.submit(field().closest('form')!)
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
    expect(useTodosStore.getState().todos).toEqual([])
    // Its task added, the field goes; it comes back empty.
    expect(screen.queryByPlaceholderText('Add a task to OITO…')).toBeNull()
    await plus()
    expect(field()).toHaveValue('')

    // A title the campaign already has is refused, naming the task; nothing is written.
    fireEvent.change(field(), { target: { value: 'PROPOSTA' } })
    fireEvent.submit(field().closest('form')!)
    await waitFor(() => expect(lastToast()?.body).toBe('OITO already has this task: OITO-06'))
    expect(campaignRegistryWrite).toHaveBeenCalledTimes(1)
    expect(field()).toHaveValue('PROPOSTA')
  })

  it('checks a task done for the user, and undo restores it from the toast or a second click', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    activate()
    render(<TodoSidebar />)
    await waitFor(() => expect(row('OITO-03')).not.toBeNull())
    // A task checked here joins the done ones: shown, to reopen it from its row.
    fireEvent.click(screen.getByRole('button', { name: '1 done' }))

    fireEvent.click(within(row('OITO-03')).getByRole('button', { name: 'Mark complete' }))
    await waitFor(() =>
      expect(task('OITO-03')).toMatchObject({
        estado: 'concluída',
        resultado: `marcada no Alethe em ${isoDay(new Date())}`,
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
    expect(within(row('OITO-01')).getByRole('button', { name: 'Done' })).toBeDisabled()
  })

  it('undo puts the state back but keeps a result written since the check', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    activate()
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
    activate()
    render(<TodoSidebar />)
    await waitFor(() => expect(row('OITO-03')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '1 done' }))
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
    activate('OITO', first)
    activate('OITO', second, OTHER_REPO)
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

  it('shows the add field on Ctrl+N for one task: added, or left on Escape, it goes', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    activate()
    render(<TodoSidebar />)
    const field = () => screen.queryByPlaceholderText('Add a task to OITO…')
    await screen.findByRole('group', { name: 'OITO' })
    expect(field()).toBeNull()
    expect(listed()).toContain('OITO-03')

    fireEvent.keyDown(window, { key: 'n', ctrlKey: true })
    await waitFor(() => expect(field()).toHaveFocus())
    fireEvent.change(field()!, { target: { value: 'Nova tarefa' } })
    fireEvent.submit(field()!.closest('form')!)
    await waitFor(() => expect(listed()).toContain('OITO-09'))
    expect(field()).toBeNull()
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true })
    await waitFor(() => expect(field()).toHaveFocus())
    fireEvent.keyDown(field()!, { key: 'Escape' })
    expect(field()).toBeNull()
  })

  it('keeps a field shown by Ctrl+N to its project, not to the next one', async () => {
    const other = `${OTHER_REPO}\\.workflow\\campanhas.json`
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    fs.files.set(other, JSON.stringify(exemplo))
    const first = projectId()
    const second = useProjectsStore
      .getState()
      .createProject({ name: 'Other', defaultCwd: OTHER_REPO }).id
    useProjectsStore.setState({ activeProjectId: first })
    activate('OITO', first)
    activate('OITO', second, OTHER_REPO)
    render(<TodoSidebar />)
    const field = () => screen.queryByPlaceholderText('Add a task to OITO…')
    await screen.findByRole('group', { name: 'OITO' })

    fireEvent.keyDown(window, { key: 'n', ctrlKey: true })
    await waitFor(() => expect(field()).toHaveFocus())
    fireEvent.change(field()!, { target: { value: 'rascunho' } })

    act(() => useProjectsStore.setState({ activeProjectId: second }))
    await screen.findByRole('group', { name: 'OITO' })
    expect(field()).toBeNull()

    // Ctrl+N there shows that project's field.
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true })
    await waitFor(() => expect(field()).toHaveFocus())
  })

  it('checks campaign titles in code points, not UTF-16 units', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    activate()
    render(<TodoSidebar />)
    const plus = async () =>
      fireEvent.click(await screen.findByRole('button', { name: 'Add a task to OITO…' }))
    const field = () => screen.getByPlaceholderText('Add a task to OITO…')
    await plus()
    // 140 emoji are 280 UTF-16 units: a maxLength would cut them short.
    expect(field()).not.toHaveAttribute('maxlength')
    fireEvent.change(field(), { target: { value: '😀'.repeat(140) } })
    fireEvent.submit(field().closest('form')!)
    await waitFor(() => expect(listed()).toContain('OITO-09'))

    await plus()
    fireEvent.change(field(), { target: { value: 'a'.repeat(141) } })
    fireEvent.submit(field().closest('form')!)
    await waitFor(() =>
      expect(lastToast()?.body).toBe(
        'A task title has 1 to 140 characters, with no line break or control character.',
      ),
    )
    expect(campaignRegistryWrite).toHaveBeenCalledTimes(1)
  })

  it('refuses a write over a registry changed since it was read, reloads and asks to retry', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    activate()
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
    expect(screen.getByText(/no campaign registry/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: /^Personal/ }))
    const input = screen.getByPlaceholderText('Add a task…')
    fireEvent.change(input, { target: { value: 'Mine' } })
    fireEvent.submit(input.closest('form')!)
    expect(useTodosStore.getState().todos.map((todo) => todo.title)).toEqual(['Mine'])
    expect(screen.getByText('Mine')).toBeInTheDocument()
    expect(campaignRegistryWrite).not.toHaveBeenCalled()
  })

  it('asks for no list source in the settings: your own list is the Personal tab', () => {
    useUiStore.setState({ openModal: TODO_SETTINGS_MODAL_ID })
    render(<TodoSettingsModal />)
    expect(screen.getByText('Folder for your personal todos')).toBeInTheDocument()
    expect(screen.queryByText('List source')).toBeNull()
    act(() => useUiStore.getState().closeModal())
  })

  it('shows the live workers of an active campaign in its header and on its task rows', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
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
    // Its workers make OITO active.
    await waitFor(() => expect(row('OITO-02')).toHaveTextContent('2 running'))
    expect(row('OITO-03')).toHaveTextContent('1 queued')
    for (const id of ['OITO-05', 'OITO-06']) {
      expect(row(id)).not.toHaveTextContent(/running|queued/)
    }
    const oito = screen.getByRole('group', { name: 'OITO' })
    expect(within(oito).getByRole('button', { name: /^OITO ·/ })).toHaveTextContent(
      '2 running · 1 queued',
    )
    fireEvent.click(screen.getByRole('button', { name: /^Completed/ }))
    // A finished campaign shows that a worker is live for it, but not its counts.
    const base = screen.getByText('BASE').closest('[data-status]')
    expect(base).toHaveTextContent('Running')
    expect(base).not.toHaveTextContent('running')

    // The board's event updates the counts; a settled worker leaves them.
    act(() =>
      orchestrator.emit?.({
        jobs: [{ task: 'OITO-03', status: 'running', cwd: 'C:\\repo', summary: 'streaming' }],
      }),
    )
    // In its header and on OITO-03's row.
    expect(within(oito).getAllByText('1 running')).toHaveLength(2)
    expect(oito).not.toHaveTextContent('queued')
    expect(row('OITO-02')).not.toHaveTextContent('running')
    expect(row('OITO-03')).toHaveTextContent('1 running')
  })
})

describe('Campaign controls', () => {
  const projectId = () => useProjectsStore.getState().projects[0].id
  /** A control, in `campaign`'s own subsection when given. */
  const button = (name: string | RegExp, campaign?: string) =>
    (campaign ? within(screen.getByRole('group', { name: campaign })) : screen).queryByRole(
      'button',
      { name },
    )
  /** Shows the Todo tab once `campaign` is active: a tab or a worker is live for it. */
  async function openControls(campaign = 'OITO') {
    render(<TodoSidebar />)
    await screen.findByRole('group', { name: campaign })
  }
  /** A terminal opened for `campaignId`, its first tab on `ptyId` in `status`. */
  function agentTab(campaignId: string, ptyId: string, status: 'working' | 'waiting') {
    const terminal = openTerminal('C:\\repo', 'claude', campaignId)
    useProjectsStore.getState().setSubTabPtyId(projectId(), terminal.id, terminal.tabs[0].id, ptyId)
    useTerminalsStore.getState().registerPty(ptyId)
    useTerminalsStore.getState().setStatus(ptyId, status)
    return terminal
  }
  const terminalById = (id: string) =>
    useProjectsStore.getState().projects[0].terminals.find((terminal) => terminal.id === id)

  beforeEach(() => {
    useUiStore.setState({ toasts: [], notifications: [] })
    useTerminalsStore.getState().reset()
  })
  afterEach(() => useTerminalsStore.getState().reset())

  it('sits in its campaign subsection, under its header and above its tasks', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    agentTab('OITO', 'pty-o', 'waiting')
    await openControls()
    const oito = screen.getByRole('group', { name: 'OITO' })
    const goTo = button('Go to tab', 'OITO')!
    const follows = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(follows(within(oito).getByRole('button', { name: /^OITO ·/ }), goTo)).toBe(true)
    expect(follows(goTo, oito.querySelector('[data-task]')!)).toBe(true)
    expect(within(oito).queryByPlaceholderText('Add a task to OITO…')).toBeNull()
    // Not running: no Pause.
    expect(button('Pause campaign')).toBeNull()
  })

  it('continues from the task in progress in a new Claude Code tab, next to its board', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    // Active through a queued worker only: it has no tab yet.
    orchestrator.jobs = [{ id: 'job-q', task: 'OITO-03', status: 'queued', cwd: 'C:\\repo' }]
    await openControls()
    fireEvent.click(button('Continue campaign')!)
    await waitFor(() => expect(agentTerminals()).toHaveLength(1))

    const [terminal] = agentTerminals()
    expect(terminal.tabs[0]).toMatchObject({
      type: 'claude',
      campaignId: 'OITO',
      initialInput: `Retome a campanha OITO pela tarefa OITO-02 («em andamento»), pelo registro ${REGISTRY}.`,
    })
    const board = useProjectsStore
      .getState()
      .projects[0].terminals.find((item) => item.kind === 'orchestrator')
    expect(useProjectsStore.getState().projects[0].paneGroups).toEqual([
      expect.objectContaining({ kind: 'orchestration', paneIds: [terminal.id, board!.id] }),
    ])
    expect(useUiStore.getState().activeTerminal?.terminalId).toBe(terminal.id)
    expect(writePty).not.toHaveBeenCalled()
  })

  it('else from the first ready task with nothing unmet, with its handoff', async () => {
    const registry = withOito(structuredClone(exemplo), { handoff: 'docs/handoff.md' })
    for (const item of registry.campanhas.find((campaign) => campaign.id === 'OITO')!.tarefas) {
      // Nothing in progress, and OITO-03 waits on a blocked task: OITO-04 comes next.
      if (item.id === 'OITO-02') Object.assign(item, { estado: 'bloqueada' })
      if (item.id === 'OITO-03') Object.assign(item, { depende_de: ['OITO-07'] })
    }
    fs.files.set(REGISTRY, JSON.stringify(registry))
    fs.handoff = 'C:\\repo\\docs\\handoff.md'
    orchestrator.jobs = [{ id: 'job-q', task: 'OITO-05', status: 'queued', cwd: 'C:\\repo' }]
    await openControls()
    fireEvent.click(button('Continue campaign')!)
    await waitFor(() => expect(agentTerminals()).toHaveLength(1))
    expect(agentTerminals()[0].tabs[0].initialInput).toBe(
      'Retome a campanha OITO pela tarefa OITO-04 («pronta, depende de outra campanha»), ' +
        `pelo registro ${REGISTRY} e pelo handoff «C:\\repo\\docs\\handoff.md».`,
    )
  })

  it('once Continue has opened its tab, offers Go to tab in its place', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    orchestrator.jobs = [{ id: 'job-q', task: 'OITO-03', status: 'queued', cwd: 'C:\\repo' }]
    await openControls()
    fireEvent.click(button('Continue campaign')!)
    await waitFor(() => expect(button('Go to tab', 'OITO')).toBeEnabled())
    expect(button('Continue campaign')).toBeNull()
    expect(button('Cancel campaign')).toBeEnabled()
    expect(writePty).not.toHaveBeenCalled()
  })

  it('with nothing ready, continues from its first open task and tells the agent why it waits', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    // DEPOIS-01 is ready, but its campaign waits for ABERTA; a queued worker makes DEPOIS active.
    orchestrator.jobs = [{ id: 'job-d', task: 'DEPOIS-01', status: 'queued', cwd: 'C:\\repo' }]
    await openControls('DEPOIS')
    expect(button('Continue campaign')).toBeEnabled()
    fireEvent.click(button('Continue campaign')!)
    await waitFor(() => expect(agentTerminals()).toHaveLength(1))
    expect(agentTerminals()[0].tabs[0].initialInput).toMatch(
      /^Retome a campanha DEPOIS pela tarefa DEPOIS-01 \(«.*»\), hoje pronta, esperando ABERTA, pelo registro /,
    )
  })

  it('cannot continue a campaign with every task done, and says so', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    // ABERTA's only task is done, but more are still to be found: it is not finished. A worker
    // makes it active without a tab.
    orchestrator.jobs = [{ id: 'job-a', task: 'ABERTA-01', status: 'queued', cwd: 'C:\\repo' }]
    await openControls('ABERTA')
    expect(button('Continue campaign')).toBeDisabled()
    expect(screen.getByText('Every task is done')).toBeInTheDocument()
  })

  it('pauses by sending Esc to each of its working tabs, leaving its workers alone', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    orchestrator.jobs = [{ id: 'job-1', task: 'OITO-03', status: 'running', cwd: 'C:\\repo' }]
    agentTab('OITO', 'pty-a', 'working')
    agentTab('OITO', 'pty-b', 'waiting')
    agentTab('PARADA', 'pty-c', 'working')
    await openControls()
    expect(button('Continue campaign', 'OITO')).toBeNull()
    expect(button('Cancel campaign', 'OITO')).toBeEnabled()

    fireEvent.click(button('Pause campaign', 'OITO')!)
    await waitFor(() => expect(writePty).toHaveBeenCalledTimes(1))
    expect(writePty).toHaveBeenCalledWith('pty-a', '\x1b')
    expect(orchestratorCancel).not.toHaveBeenCalled()
    expect(askConfirm).not.toHaveBeenCalled()
  })

  it('cancels only once confirmed: interrupts, cancels its workers, closes its tabs and puts its tasks back', async () => {
    const text = JSON.stringify(exemplo)
    fs.files.set(REGISTRY, text)
    orchestrator.jobs = [
      { id: 'job-run', task: 'OITO-03', status: 'running', cwd: 'C:\\repo' },
      { id: 'job-queued', task: 'OITO-05', status: 'queued', cwd: 'C:\\repo-feature' },
      { id: 'job-blocked', task: 'OITO-05', status: 'blocked', cwd: 'C:\\repo' },
      { id: 'job-done', task: 'OITO-03', status: 'done', cwd: 'C:\\repo' },
      // Same id, another repository; and another campaign.
      { id: 'job-other-repo', task: 'OITO-03', status: 'running', cwd: OTHER_REPO },
      { id: 'job-parada', task: 'PARADA-01', status: 'running', cwd: 'C:\\repo' },
    ]
    const alone = agentTab('OITO', 'pty-a', 'working')
    const shared = agentTab('OITO', 'pty-b', 'waiting')
    useProjectsStore
      .getState()
      .createSubTab(projectId(), shared.id, { type: 'shell', cwd: 'C:\\repo' })
    const other = agentTab('PARADA', 'pty-c', 'working')
    await openControls()
    await waitFor(() => expect(button('Cancel campaign', 'OITO')).toBeEnabled())

    // No: nothing happens.
    fireEvent.click(button('Cancel campaign', 'OITO')!)
    await waitFor(() => expect(askConfirm).toHaveBeenCalledTimes(1))
    expect(askConfirm.mock.calls[0][0]).toContain('OITO')
    await act(async () => {})
    expect(writePty).not.toHaveBeenCalled()
    expect(orchestratorCancel).not.toHaveBeenCalled()
    expect(agentTerminals()).toHaveLength(3)
    expect(fs.files.get(REGISTRY)).toBe(text)

    // Yes, with the registry write held to see the controls wait for it.
    let release: () => void = () => {}
    const write = vi.mocked(campaignRegistryWrite).getMockImplementation()!
    vi.mocked(campaignRegistryWrite).mockImplementationOnce(
      (...args) =>
        new Promise((resolve, reject) => {
          release = () => void write(...args).then(resolve, reject)
        }),
    )
    askConfirm.mockResolvedValueOnce(true)
    fireEvent.click(button('Cancel campaign', 'OITO')!)
    await waitFor(() => expect(campaignRegistryWrite).toHaveBeenCalledTimes(1))
    expect(writePty).toHaveBeenCalledTimes(1)
    expect(writePty).toHaveBeenCalledWith('pty-a', '\x1b')
    expect(
      vi
        .mocked(orchestratorCancel)
        .mock.calls.map(([id]) => id)
        .sort(),
    ).toEqual(['job-blocked', 'job-queued', 'job-run'])
    // Its own terminal goes; the shared one keeps its other tab; the other campaign's stays.
    expect(terminalById(alone.id)).toBeUndefined()
    expect(terminalById(shared.id)?.tabs.map((tab) => tab.type)).toEqual(['shell'])
    expect(terminalById(other.id)).toBeDefined()
    expect(cleanupPtys).toHaveBeenCalledWith(['pty-a'])
    expect(cleanupPtys).toHaveBeenCalledWith(['pty-b'])
    // Its workers still show live until the board says otherwise, without its tabs: the controls
    // wait on the write.
    expect(button('Continue campaign', 'OITO')).toBeDisabled()
    expect(button('Cancel campaign', 'OITO')).toBeDisabled()

    await act(async () => release())
    await waitFor(() => expect(task('OITO-02')?.estado).toBe('pronta'))
    // Only the task in progress changed; nothing was concluded or deleted.
    expect(task('OITO-01')).toEqual(original('OITO-01'))
    expect(task('OITO-03')).toEqual(original('OITO-03'))
    expect(campaignRegistryWrite).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(lastToast()?.body).toBe(
        'Tabs closed: 2 · workers cancelled: 3 · tasks back to Ready: 1',
      ),
    )
    await waitFor(() => expect(button('Cancel campaign', 'OITO')).toBeEnabled())
  })

  /** OITO with these tasks set to these states. */
  const oitoWith = (states: Record<string, string>) => {
    const data = structuredClone(exemplo)
    for (const item of data.campanhas.flatMap((campaign) => campaign.tarefas)) {
      if (item.id in states) item.estado = states[item.id]
    }
    return JSON.stringify(data)
  }
  /** Answers yes to the confirmation and clicks Cancel. */
  const confirmCancel = () => {
    askConfirm.mockResolvedValueOnce(true)
    fireEvent.click(button('Cancel campaign')!)
  }

  it('runs one action at a time: a second click while one runs does nothing more', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    agentTab('OITO', 'pty-o', 'waiting')
    let answer: (agreed: boolean) => void = () => {}
    askConfirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => (answer = resolve)))
    await openControls()
    const cancel = button('Cancel campaign')!
    fireEvent.click(cancel)
    fireEvent.click(cancel)
    expect(cancel).toBeDisabled()
    await act(async () => answer(false))
    await waitFor(() => expect(cancel).toBeEnabled())
    expect(askConfirm).toHaveBeenCalledTimes(1)
  })

  it('cancels nothing when the workers cannot be listed', async () => {
    const text = JSON.stringify(exemplo)
    fs.files.set(REGISTRY, text)
    agentTab('OITO', 'pty-a', 'working')
    await openControls()
    await waitFor(() => expect(button('Cancel campaign')).toBeEnabled())
    vi.mocked(orchestratorJobs).mockRejectedValueOnce('orchestrator down')

    confirmCancel()
    await waitFor(() =>
      expect(lastToast()?.body).toBe(
        'Could not list the orchestration workers, so nothing was cancelled: orchestrator down',
      ),
    )
    expect(writePty).not.toHaveBeenCalled()
    expect(orchestratorCancel).not.toHaveBeenCalled()
    expect(agentTerminals()).toHaveLength(1)
    expect(campaignRegistryWrite).not.toHaveBeenCalled()
    expect(fs.files.get(REGISTRY)).toBe(text)
  })

  it('keeps in progress the tasks whose workers it could not cancel, and says which', async () => {
    fs.files.set(
      REGISTRY,
      oitoWith({ 'OITO-03': 'em execução', 'OITO-05': 'em execução', 'OITO-08': 'em execução' }),
    )
    orchestrator.jobs = [
      { id: 'job-refused', task: 'OITO-02', status: 'running', cwd: 'C:\\repo' },
      { id: 'job-stuck', task: 'OITO-03', status: 'running', cwd: 'C:\\repo' },
      { id: 'job-gone', task: 'OITO-05', status: 'queued', cwd: 'C:\\repo' },
    ]
    // Refused; accepted but still live in the next snapshot; and cancelled.
    vi.mocked(orchestratorCancel)
      .mockRejectedValueOnce('refused')
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(async () => {
        orchestrator.jobs = orchestrator.jobs.map((job) =>
          job.id === 'job-gone' ? { ...job, status: 'cancelled' } : job,
        )
        return null
      })
    await openControls()
    await waitFor(() => expect(button('Cancel campaign')).toBeEnabled())

    confirmCancel()
    await waitFor(() => expect(task('OITO-05')?.estado).toBe('pronta'))
    expect(task('OITO-08')?.estado).toBe('pronta')
    expect(task('OITO-02')?.estado).toBe('em execução')
    expect(task('OITO-03')?.estado).toBe('em execução')
    await waitFor(() =>
      expect(lastToast()?.body).toBe(
        'Tabs closed: 0 · workers cancelled: 1 · tasks back to Ready: 2. ' +
          'Workers still live on OITO-02, OITO-03: those tasks stay in progress.',
      ),
    )
  })

  it('puts tasks back from the registry on disk, even a change the list has not read yet', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    agentTab('OITO', 'pty-a', 'working')
    await openControls()
    await waitFor(() => expect(button('Cancel campaign')).toBeEnabled())
    // Written by the script, not yet reloaded: OITO-07 done, OITO-03 started.
    fs.files.set(REGISTRY, oitoWith({ 'OITO-07': 'concluída', 'OITO-03': 'em execução' }))

    confirmCancel()
    await waitFor(() => expect(task('OITO-02')?.estado).toBe('pronta'))
    expect(task('OITO-03')?.estado).toBe('pronta')
    expect(task('OITO-07')?.estado).toBe('concluída')
    expect(campaignRegistryWrite).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(lastToast()?.body).toBe(
        'Tabs closed: 1 · workers cancelled: 0 · tasks back to Ready: 2',
      ),
    )
  })

  it('retries a refused release once from the file as it is then, and reports a second refusal', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    agentTab('OITO', 'pty-a', 'working')
    agentTab('OITO', 'pty-b', 'working')
    await openControls()
    await waitFor(() => expect(button('Cancel campaign')).toBeEnabled())
    vi.mocked(campaignRegistryWrite).mockRejectedValueOnce('conflict')

    confirmCancel()
    await waitFor(() => expect(task('OITO-02')?.estado).toBe('pronta'))
    expect(campaignRegistryWrite).toHaveBeenCalledTimes(2)
    expect(useUiStore.getState().toasts.map((toast) => toast.body)).not.toContain(
      'The registry changed since it was read. The list was reloaded; try again.',
    )

    // Refused twice: reported, and the task stays in progress.
    cleanup()
    vi.clearAllMocks()
    useUiStore.setState({ toasts: [] })
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    agentTab('OITO', 'pty-c', 'working')
    await openControls()
    await waitFor(() => expect(button('Cancel campaign')).toBeEnabled())
    vi.mocked(campaignRegistryWrite)
      .mockRejectedValueOnce('conflict')
      .mockRejectedValueOnce('conflict')
    confirmCancel()
    await waitFor(() =>
      expect(useUiStore.getState().toasts.map((toast) => toast.body)).toContain(
        'The registry changed since it was read. The list was reloaded; try again.',
      ),
    )
    expect(campaignRegistryWrite).toHaveBeenCalledTimes(2)
    expect(task('OITO-02')?.estado).toBe('em execução')
  })

  it('keeps in progress a task whose new worker started while the old one was cancelled', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    orchestrator.jobs = [
      { id: 'old', task: 'OITO-02', status: 'running', cwd: 'C:\\repo' },
      // Another repository's worker on the same id never counts.
      { id: 'elsewhere', task: 'OITO-08', status: 'running', cwd: OTHER_REPO },
    ]
    vi.mocked(orchestratorCancel).mockImplementationOnce(async () => {
      orchestrator.jobs = [
        { id: 'old', task: 'OITO-02', status: 'cancelled', cwd: 'C:\\repo' },
        { id: 'new', task: 'OITO-02', status: 'running', cwd: 'C:\\repo-feature' },
        { id: 'elsewhere', task: 'OITO-08', status: 'running', cwd: OTHER_REPO },
      ]
      return null
    })
    agentTab('OITO', 'pty-a', 'working')
    await openControls()
    await waitFor(() => expect(button('Cancel campaign')).toBeEnabled())

    confirmCancel()
    await waitFor(() =>
      expect(lastToast()?.body).toBe(
        'Tabs closed: 1 · workers cancelled: 1 · tasks back to Ready: 0. ' +
          'Workers still live on OITO-02: those tasks stay in progress.',
      ),
    )
    expect(orchestratorCancel).toHaveBeenCalledTimes(1)
    expect(task('OITO-02')?.estado).toBe('em execução')
    expect(campaignRegistryWrite).not.toHaveBeenCalled()
  })

  it('gives every active campaign its own controls, one control running at a time', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    // DEPOIS is live through a queued worker, OITO and PARADA through their tabs.
    orchestrator.jobs = [{ id: 'job-d', task: 'DEPOIS-01', status: 'queued', cwd: 'C:\\repo' }]
    agentTab('OITO', 'pty-o', 'waiting')
    agentTab('PARADA', 'pty-p', 'working')
    await openControls()
    await waitFor(() => expect(screen.queryByRole('group', { name: 'DEPOIS' })).not.toBeNull())
    expect(button('Go to tab', 'OITO')).toBeEnabled()
    expect(button('Continue campaign', 'OITO')).toBeNull()
    expect(button('Continue campaign', 'DEPOIS')).toBeEnabled()
    expect(button('Pause campaign', 'PARADA')).toBeEnabled()

    // Each subsection collapses on its own.
    fireEvent.click(button(/^DEPOIS ·/, 'DEPOIS')!)
    expect(button('Continue campaign', 'DEPOIS')).toBeNull()

    // One control at a time, across the campaigns.
    let answer: (agreed: boolean) => void = () => {}
    askConfirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => (answer = resolve)))
    fireEvent.click(button('Cancel campaign', 'OITO')!)
    expect(button('Pause campaign', 'PARADA')).toBeDisabled()
    await act(async () => answer(false))
    await waitFor(() => expect(button('Pause campaign', 'PARADA')).toBeEnabled())
    fireEvent.click(button('Pause campaign', 'PARADA')!)
    await waitFor(() => expect(writePty).toHaveBeenCalledWith('pty-p', '\x1b'))
  })

  it('continues a campaign that waits on an active one only with a refusal toast', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    // NOTURNA-01 waits on OITO-02. NOTURNA is active through a queued worker, without a tab.
    orchestrator.jobs = [{ id: 'job-n', task: 'NOTURNA-01', status: 'queued', cwd: 'C:\\repo' }]
    agentTab('OITO', 'pty-o', 'waiting')
    await openControls('NOTURNA')
    fireEvent.click(button('Continue campaign', 'NOTURNA')!)
    await waitFor(() =>
      expect(lastToast()).toMatchObject({
        title: 'Campaign NOTURNA not opened',
        body: 'NOTURNA waits on OITO (OITO-02): the two cannot be active at once.',
      }),
    )
    await waitFor(() => expect(button('Continue campaign', 'NOTURNA')).toBeEnabled())
    expect(useUiStore.getState().toasts).toHaveLength(1)
    expect(agentTerminals()).toHaveLength(1)
    expect(writePty).not.toHaveBeenCalled()
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

  // The card is in the Night tab; Pending, in Tasks, lists the entries waiting on you.
  beforeEach(() => useTodosStore.setState({ tab: 'night' }))

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
        entry('OITO-07', 'aguarda-voce', 'docs/motor.md'),
        entry('MOTOR-02', 'ok', 'a1b2c3d'),
        entry('MOTOR-03', 'ok'),
        entry('MOTOR-04', 'parou'),
        { tarefa: 'MOTOR-05', resultado: 'talvez' },
      ]),
    )
    fs.handoff = 'C:\\repo-feature\\docs\\motor.md'
    render(<TodoSidebar />)
    const toggle = await screen.findByRole('button', { name: /^Night of 10\/03/ })
    expect(toggle).toHaveTextContent('2 ok')
    expect(toggle).toHaveTextContent('1 waiting on you')
    expect(toggle).toHaveTextContent('1 stopped')
    expect(toggle).not.toHaveTextContent('failed')
    // Collapsed at first, even with an entry waiting on you: Pending lists that one in Tasks.
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('OITO-07 resumo')).toBeNull()

    fireEvent.click(toggle)
    await screen.findByRole('button', { name: 'docs/motor.md' })
    const entries = document.querySelectorAll('[data-lane] > [role="img"]')
    expect([...entries].map((dot) => dot.getAttribute('aria-label'))).toEqual([
      'waiting on you',
      'ok',
      'ok',
      'stopped',
    ])
    expect(screen.getByText('OITO-07 resumo')).toBeInTheDocument()
    expect(screen.queryByText('MOTOR-05')).toBeNull()
    // A commit is plain text; a path opens as the menu's Open evidence does, Markdown in the viewer.
    expect(screen.getByText('a1b2c3d').tagName).toBe('SPAN')
    fireEvent.click(screen.getByRole('button', { name: 'docs/motor.md' }))
    await waitFor(() =>
      expect(useUiStore.getState().linkViewerUrl).toBe('C:\\repo-feature\\docs\\motor.md'),
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

  /** Clicks each evidence link: none may reach the disk, and each says it was not found. */
  async function refused(evidences: string[]) {
    const panes = useProjectsStore.getState().projects[0].terminals.length
    for (const text of evidences) {
      fireEvent.click(screen.getByRole('button', { name: text }))
      await waitFor(() => expect(lastToast()?.body, text).toBe(`Evidence not found: ${text}`))
    }
    expect(findRelativePath).not.toHaveBeenCalled()
    expect(vi.mocked(listDirectory).mock.calls.every(([path]) => path === NIGHTS)).toBe(true)
    expect(openInFileExplorer).not.toHaveBeenCalled()
    expect(useUiStore.getState().linkViewerUrl).toBeNull()
    expect(useProjectsStore.getState().projects[0].terminals).toHaveLength(panes)
  }

  it('opens evidence only inside the checkouts, never asking the disk about another path', async () => {
    useUiStore.setState({ linkViewerUrl: null })
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

    // Anything that looks like a path is a link; one outside the checkouts opens nothing.
    expect(await screen.findByRole('button', { name: 'docs/ok.md' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'C:\\repo-feature\\docs\\abs.md' })).toBeTruthy()
    await refused(['../outside/private.md', 'C:\\secret\\notes.md', '\\\\server\\share\\notes.md'])

    // Not found anywhere, a path in the repository opens nothing broken either.
    const panes = useProjectsStore.getState().projects[0].terminals.length
    fireEvent.click(screen.getByRole('button', { name: 'docs/ok.md' }))
    await waitFor(() => expect(lastToast()?.body).toBe('Evidence not found: docs/ok.md'))
    expect(findRelativePath).toHaveBeenCalledWith('C:\\repo', 'docs/ok.md')
    expect(useProjectsStore.getState().projects[0].terminals).toHaveLength(panes)
  })

  it('refuses a rooted path without a drive, which Windows would resolve on the current drive', async () => {
    useUiStore.setState({ linkViewerUrl: null })
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    fs.files.set(
      `${NIGHTS}\\2026-10-03.json`,
      diary('2026-10-03', [
        entry('MOTOR-01', 'ok', '\\Windows\\win.ini'),
        entry('MOTOR-02', 'ok', '/etc/passwd'),
        entry('MOTOR-03', 'ok', 'C:Windows\\win.ini'),
      ]),
    )
    fs.handoff = 'C:\\Windows\\win.ini'
    render(<TodoSidebar />)
    fireEvent.click(await screen.findByRole('button', { name: /^Night of 10\/03/ }))
    await screen.findByRole('button', { name: '\\Windows\\win.ini' })
    await refused(['\\Windows\\win.ini', '/etc/passwd', 'C:Windows\\win.ini'])
  })

  it('looks evidence up when clicked: one removed since the card showed it opens nothing', async () => {
    useUiStore.setState({ linkViewerUrl: null })
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    fs.files.set(
      `${NIGHTS}\\2026-10-03.json`,
      diary('2026-10-03', [entry('MOTOR-01', 'ok', 'src/gone.ts')]),
    )
    fs.found.set('src/gone.ts', 'C:\\repo\\src\\gone.ts')
    render(<TodoSidebar />)
    fireEvent.click(await screen.findByRole('button', { name: /^Night of 10\/03/ }))
    const link = await screen.findByRole('button', { name: 'src/gone.ts' })
    await act(async () => {})
    await act(async () => {})

    fs.found.delete('src/gone.ts')
    const panes = useProjectsStore.getState().projects[0].terminals.length
    fireEvent.click(link)
    await waitFor(() => expect(lastToast()?.body).toBe('Evidence not found: src/gone.ts'))
    expect(useProjectsStore.getState().projects[0].terminals).toHaveLength(panes)
  })

  it('opens a folder through its report, else in the file explorer, and names evidence found nowhere', async () => {
    useUiStore.setState({ toasts: [], notifications: [], linkViewerUrl: null })
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    // Each folder and its files; the report is the first of relatorio.md, README.md and
    // handoff.md, else its only Markdown file.
    const folders: Record<string, string[]> = {
      'docs/r/01-calibracao': ['notas.md', 'handoff.md', 'README.md', 'relatorio.md'],
      'docs/r/02': ['handoff.md', 'readme.md'],
      'docs/r/03': ['notas.md', 'handoff.md'],
      'docs/r/04': ['dados.csv', 'resumo.md'],
      'docs/r/05': ['a.md', 'b.md'],
      'docs/r/06': ['dados.csv'],
    }
    for (const [folder, names] of Object.entries(folders)) {
      const path = `C:\\repo\\${folder.replace(/\//g, '\\')}`
      fs.found.set(folder, path)
      for (const name of names) fs.files.set(`${path}\\${name}`, '')
    }
    // The real case: the project moved the night's reports to docs/reports/Feitos since.
    const moved = 'docs/reports/2026-10-03-piloto-noite/01-calibracao'
    fs.files.set(
      `${NIGHTS}\\2026-10-03.json`,
      diary('2026-10-03', [
        entry('OITO-07', 'aguarda-voce', moved),
        ...Object.keys(folders).map((folder, index) => entry(`MOTOR-0${index + 1}`, 'ok', folder)),
      ]),
    )
    render(<TodoSidebar />)
    fireEvent.click(await screen.findByRole('button', { name: /^Night of/ }))
    const viewer = () => useUiStore.getState().linkViewerUrl
    const link = async (evidence: string) =>
      fireEvent.click(await screen.findByRole('button', { name: evidence }))
    const panes = () => useProjectsStore.getState().projects[0].terminals.length
    const before = panes()

    // From the menu: a path found nowhere names itself in a toast, and no pane opens.
    fireEvent.click(await screen.findByRole('button', { name: /^OITO-07 / }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open evidence' }))
    await waitFor(() => expect(lastToast()?.body).toBe(`Evidence not found: ${moved}`))

    // From the entry's link: a folder opens its report in the viewer.
    await link('docs/r/01-calibracao')
    await waitFor(() => expect(viewer()).toBe('C:\\repo\\docs\\r\\01-calibracao\\relatorio.md'))
    await link('docs/r/02')
    await waitFor(() => expect(viewer()).toBe('C:\\repo\\docs\\r\\02\\readme.md'))
    await link('docs/r/03')
    await waitFor(() => expect(viewer()).toBe('C:\\repo\\docs\\r\\03\\handoff.md'))
    await link('docs/r/04')
    await waitFor(() => expect(viewer()).toBe('C:\\repo\\docs\\r\\04\\resumo.md'))
    // Without one report, the folder itself opens in the file explorer.
    await link('docs/r/05')
    await waitFor(() => expect(openInFileExplorer).toHaveBeenCalledWith('C:\\repo\\docs\\r\\05'))
    await link('docs/r/06')
    await waitFor(() =>
      expect(openInFileExplorer).toHaveBeenLastCalledWith('C:\\repo\\docs\\r\\06'),
    )
    expect(openInFileExplorer).toHaveBeenCalledTimes(2)
    expect(viewer()).toBe('C:\\repo\\docs\\r\\04\\resumo.md')
    expect(panes()).toBe(before)
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

    beforeEach(() => {
      useUiStore.setState({ toasts: [], notifications: [], linkViewerUrl: null })
      useTodosStore.setState({ tab: 'tasks' })
    })

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
        diary('2026-10-03', [
          entry('OITO-07', 'aguarda-voce', 'docs/oito.md'),
          entry('PARADA-01', 'aguarda-voce'),
        ]),
      )
      fs.found.set('docs/oito.md', 'C:\\repo\\docs\\oito.md')
      useTodosStore.setState({ tab: 'night' })
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

    it('leaves Pending once you decide, and the focus goes to Pending', async () => {
      const data = structuredClone(exemplo)
      Object.assign(data.campanhas[5].tarefas[0], { resultado: 'aguarda o Gate 2 do usuário' })
      fs.files.set(REGISTRY, JSON.stringify(data))
      fs.files.set(
        `${NIGHTS}\\2026-10-03.json`,
        diary('2026-10-03', [entry('OITO-07', 'aguarda-voce'), entry('OITO-03', 'ok')]),
      )
      render(<TodoSidebar />)
      const pending = () => screen.queryByRole('button', { name: /^Pending/ })
      await waitFor(() => expect(actions('OITO-07')).not.toBeNull())
      expect(pending()).toHaveTextContent('2')

      // Back in the queue it no longer waits on you: it leaves Pending, and the focus goes to
      // Pending, still there for the Gate 2 task.
      await choose('OITO-07', 'Back to the queue')
      await waitFor(() => expect(task('OITO-07')?.estado).toBe('pronta'))
      await waitFor(() => expect(pending()).toHaveTextContent('1'))
      expect(actions('OITO-07')).toBeNull()
      await waitFor(() => expect(pending()).toHaveFocus())

      // Waiting again, it is back in Pending, now alone there.
      await editRegistry((edited) => {
        Object.assign(edited.campanhas[1].tarefas[6], { estado: 'bloqueada' })
        delete (edited.campanhas[5].tarefas[0] as { resultado?: string }).resultado
      })
      await waitFor(() => expect(pending()).toHaveTextContent('1'))
      expect(pending()!.closest('section')).toContainElement(actions('OITO-07'))

      // The Night tab keeps the whole night.
      fireEvent.click(screen.getByRole('tab', { name: /^Night/ }))
      expect(screen.getByRole('button', { name: /^Night of/ })).toHaveTextContent(
        '1 waiting on you',
      )

      // Once concluded, nothing is pending: the focus goes to the Tasks tab, not to the page.
      fireEvent.click(screen.getByRole('tab', { name: /^Overview/ }))
      await waitFor(() => expect(actions('OITO-07')).not.toBeNull())
      await choose('OITO-07', 'Conclude (Gate 2)')
      await waitFor(() => expect(pending()).toBeNull())
      await waitFor(() => expect(screen.getByRole('tab', { name: /^Overview/ })).toHaveFocus())
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
      await waitFor(() => expect(actions('OITO-07')).not.toBeNull())

      // Markdown opens in the viewer, any other file in a pane, as from a terminal link.
      await choose('OITO-07', 'Open evidence')
      await waitFor(() =>
        expect(useUiStore.getState().linkViewerUrl).toBe('C:\\repo-feature\\docs\\oito.md'),
      )
      await choose('PARADA-01', 'Open evidence')
      await waitFor(() =>
        expect(useProjectsStore.getState().projects[0].terminals.at(-1)).toMatchObject({
          filePath: 'C:\\repo\\src\\parada.ts',
        }),
      )
      // A commit is not a path: nothing to open.
      fireEvent.click(actions('NOTURNA-02')!)
      expect(screen.queryByRole('menuitem', { name: 'Open evidence' })).toBeNull()
      fireEvent.click(actions('NOTURNA-02')!)

      // A campaign with its tab open continues there.
      focusTerminal(useProjectsStore.getState().projects[0].terminals.at(-1)!.id)
      await choose('PARADA-01', 'Continue in the terminal')
      expect(useUiStore.getState().activeTerminal?.terminalId).toBe(tagged.id)

      // One without opens Claude Code right away, as a planner next to its own board.
      await choose('OITO-07', 'Continue in the terminal')
      expect(screen.queryByRole('menu')).toBeNull()
      await waitFor(() =>
        expect(agentTerminals().find((item) => item.tabs[0].campaignId === 'OITO')).toBeDefined(),
      )
      const opened = agentTerminals().find((item) => item.tabs[0].campaignId === 'OITO')!
      expect(opened.tabs[0]).toMatchObject({ type: 'claude', cwd: 'C:\\repo' })
      const project = useProjectsStore.getState().projects[0]
      const board = project.terminals.find((item) => item.kind === 'orchestrator')
      expect(project.paneGroups).toEqual([
        expect.objectContaining({ kind: 'orchestration', paneIds: [opened.id, board!.id] }),
      ])
      expect(useUiStore.getState().activeTerminal?.terminalId).toBe(opened.id)
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

describe('Todo sections', () => {
  const NIGHTS = 'C:\\repo\\.workflow\\local\\noites'
  const FINDINGS = 'C:\\repo\\.workflow\\achados.json'
  const GATE_2 = 'aguarda o Gate 2 do usuário'
  const projectId = () => useProjectsStore.getState().projects[0].id
  /** Tonight's diary, with these task results. */
  const night = (...entries: Array<[string, string]>) =>
    fs.files.set(
      `${NIGHTS}\\2026-10-03.json`,
      JSON.stringify({
        data: '2026-10-03',
        entradas: entries.map(([tarefa, resultado]) => ({
          tarefa,
          resultado,
          resumo: `${tarefa} resumo`,
          evidencia: '',
          hora: '03:41',
        })),
      }),
    )
  /** The example registry with these `resultado`s. */
  const withResults = (results: Record<string, string>) => {
    const data = structuredClone(exemplo)
    for (const item of data.campanhas.flatMap((campaign) => campaign.tarefas)) {
      if (item.id in results) Object.assign(item, { resultado: results[item.id] })
    }
    return JSON.stringify(data)
  }
  const header = (name: RegExp) => screen.queryByRole('button', { name })
  const pending = () => header(/^Pending/)
  const gate2 = () => screen.queryByRole('group', { name: 'Waiting for your Gate 2' })
  const gate2Rows = () =>
    [...(gate2()?.querySelectorAll('[data-task]') ?? [])].map((row) =>
      row.getAttribute('data-task'),
    )

  beforeEach(() => useUiStore.setState({ toasts: [], notifications: [] }))

  it('puts Pending first, then Active, Findings, Campaigns and Completed; the night is in its tab', async () => {
    fs.files.set(REGISTRY, withResults({ 'OITO-07': GATE_2 }))
    fs.files.set(
      FINDINGS,
      JSON.stringify({
        achados: [
          { id: 'A-1', data: '2026-10-03', tipo: 'bug', titulo: 'T', origem: '', estado: 'novo' },
        ],
      }),
    )
    night(['OITO-03', 'ok'])
    render(<TodoSidebar />)
    await screen.findByRole('button', { name: /^Findings/ })
    await waitFor(() => expect(pending()).not.toBeNull())
    const order = [
      pending(),
      header(/^Active/),
      header(/^Findings/),
      header(/^Campaigns/),
      header(/^Completed/),
    ]
    order
      .slice(1)
      .forEach((next, index) =>
        expect(order[index]!.compareDocumentPosition(next!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING),
      )
    expect(pending()).toHaveAttribute('aria-expanded', 'true')
    expect(pending()).toHaveTextContent('waiting on you')
    expect(header(/^Findings/)).toHaveAttribute('aria-expanded', 'false')
    expect(header(/^Night of/)).toBeNull()

    // Nothing waits on you: Pending is hidden.
    await editRegistry((data) => {
      Object.assign(data.campanhas[1].tarefas[6], { resultado: 'aprovado' })
    })
    expect(pending()).toBeNull()
  })

  it('holds the night entries waiting on you and the tasks waiting for your Gate 2, counted together', async () => {
    fs.files.set(
      REGISTRY,
      withResults({
        'OITO-07': GATE_2,
        'PARADA-01': `${GATE_2} (PR #61)`,
        // In the night card already, done, back in the queue, or waiting on something else: not listed.
        'NOTURNA-02': GATE_2,
        'BASE-01': GATE_2,
        'OITO-04': GATE_2,
        // Done tonight with another result, which the Night tab shows: still waiting here.
        'OITO-06': GATE_2,
        'OITO-03': 'aguarda revisão',
      }),
    )
    night(
      ['NOTURNA-02', 'aguarda-voce'],
      ['OITO-02', 'aguarda-voce'],
      // Back in the queue, concluded, or gone from the registry: no longer waiting on you.
      ['DEPOIS-01', 'aguarda-voce'],
      ['OITO-01', 'aguarda-voce'],
      ['MOTOR-09', 'aguarda-voce'],
      ['OITO-03', 'ok'],
      ['OITO-06', 'ok'],
    )
    render(<TodoSidebar />)
    await waitFor(() => expect(pending()).toHaveTextContent('5'))
    const section = pending()!.closest('section')!
    expect(pending()).toHaveAttribute('aria-expanded', 'true')

    // The night's entries waiting on you are its rows, with their actions and their night's date.
    expect(header(/^Night of/)).toBeNull()
    const noturna = screen.getByRole('button', { name: /^NOTURNA-02 / })
    expect(section).toContainElement(noturna)
    expect(noturna).toHaveTextContent('night 10/03')
    expect(section).toContainElement(screen.getByRole('button', { name: /^OITO-02 / }))

    // Gate 2 tasks of any campaign, with their id, title and campaign.
    const box = gate2()!
    expect(section).toContainElement(box)
    expect(
      within(box).getByRole('button', { name: /^Waiting for your Gate 2/ }).parentElement,
    ).toHaveAttribute('data-variant', 'sub')
    expect(gate2Rows()).toEqual(['OITO-06', 'OITO-07', 'PARADA-01'])
    const row = box.querySelector('[data-task="OITO-07"]') as HTMLElement
    expect(within(row).getByText('bloqueada')).toBeInTheDocument()
    expect(within(row).getByText('OITO')).toBeInTheDocument()

    // Its box concludes it as the list's check does, with an undo.
    fireEvent.click(within(row).getByRole('button', { name: 'Mark complete' }))
    await waitFor(() =>
      expect(task('OITO-07')).toMatchObject({
        estado: 'concluída',
        resultado: `marcada no Alethe em ${isoDay(new Date())}`,
      }),
    )
    await waitFor(() => expect(lastToast()?.body).toBe('OITO-07 marked done.'))
    await waitFor(() => expect(gate2Rows()).toEqual(['OITO-06', 'PARADA-01']))
    expect(pending()).toHaveTextContent('4')
    await act(async () => lastToast()?.actions?.[0].run())
    await waitFor(() =>
      expect(task('OITO-07')).toEqual({ ...original('OITO-07'), resultado: GATE_2 }),
    )
    await waitFor(() => expect(gate2Rows()).toEqual(['OITO-06', 'OITO-07', 'PARADA-01']))

    // What the task already said stays, without the waiting note the check answers; undo puts it back.
    const other = box.querySelector('[data-task="PARADA-01"]') as HTMLElement
    fireEvent.click(within(other).getByRole('button', { name: 'Mark complete' }))
    await waitFor(() =>
      expect(task('PARADA-01')).toMatchObject({
        estado: 'concluída',
        resultado: `marcada no Alethe em ${isoDay(new Date())}; (PR #61)`,
      }),
    )
    await act(async () => lastToast()?.actions?.[0].run())
    await waitFor(() =>
      expect(task('PARADA-01')).toEqual({
        ...original('PARADA-01'),
        resultado: `${GATE_2} (PR #61)`,
      }),
    )

    fireEvent.click(pending()!)
    expect(gate2()).toBeNull()
    expect(screen.queryByRole('button', { name: /^NOTURNA-02 / })).toBeNull()
  })

  it('opens evidence from the checkout its campaign has at the click, not the one it had', async () => {
    const data = JSON.parse(withResults({ 'OITO-07': GATE_2 })) as typeof exemplo
    Object.assign(data.campanhas[1].tarefas[6], { evidencia: 'docs/report.md' })
    fs.files.set(REGISTRY, JSON.stringify(data))
    // In the feature worktree the lookup hangs until released.
    let release: (path: string) => void = () => {}
    const lookup = vi.mocked(findRelativePath)
    const usual = lookup.getMockImplementation()!
    lookup.mockImplementation((cwd, path) =>
      cwd === 'C:\\repo-feature'
        ? new Promise((resolve) => (release = resolve))
        : Promise.resolve(`${cwd}\\${path.replace(/\//g, '\\')}`),
    )
    useUiStore.setState({ linkViewerUrl: null })
    try {
      render(<TodoSidebar />)
      await waitFor(() => expect(gate2Rows()).toEqual(['OITO-07']))
      await act(async () => {})

      // The campaign moves to its feature worktree.
      await editRegistry((edited) => {
        Object.assign(edited.campanhas[1], { worktrees: ['repo-feature'] })
      })
      fireEvent.click(within(gate2()!).getByRole('button', { name: /^OITO-07 / }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Open evidence' }))
      await act(async () => {})
      expect(useUiStore.getState().linkViewerUrl).toBeNull()
      await act(async () => release('C:\\repo-feature\\docs\\report.md'))
      await waitFor(() =>
        expect(useUiStore.getState().linkViewerUrl).toBe('C:\\repo-feature\\docs\\report.md'),
      )
      expect(lookup).toHaveBeenLastCalledWith('C:\\repo-feature', 'docs/report.md')
    } finally {
      lookup.mockImplementation(usual)
    }
  })

  it('opens the actions of a task waiting for your Gate 2 from its row, as a night entry does', async () => {
    const data = JSON.parse(
      withResults({ 'OITO-07': GATE_2, 'NOTURNA-01': GATE_2, 'PARADA-01': GATE_2 }),
    ) as typeof exemplo
    Object.assign(data.campanhas[1].tarefas[6], { evidencia: 'docs/oito.md' })
    fs.files.set(REGISTRY, JSON.stringify(data))
    fs.found.set('docs/oito.md', 'C:\\repo\\docs\\oito.md')
    const tagged = openTerminal('C:\\repo', 'claude', 'PARADA')
    useUiStore.setState({ linkViewerUrl: null })
    render(<TodoSidebar />)
    await waitFor(() => expect(gate2Rows()).toEqual(['OITO-07', 'NOTURNA-01', 'PARADA-01']))
    const trigger = (id: string) =>
      within(gate2()!).getByRole('button', { name: new RegExp(`^${id} `) })
    const items = () =>
      within(screen.getByRole('menu'))
        .getAllByRole('menuitem')
        .map((item) => item.textContent)

    // Conclude, its evidence and Continue; Back to the queue only for a night task.
    fireEvent.click(trigger('OITO-07'))
    expect(screen.getByRole('menu', { name: 'Actions for OITO-07' })).toBeInTheDocument()
    expect(items()).toEqual(['Conclude (Gate 2)', 'Open evidence', 'Continue in the terminal'])
    const open = screen.getByRole('menuitem', { name: 'Open evidence' })
    open.focus()
    fireEvent.keyDown(open, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger('OITO-07')).toHaveFocus()

    fireEvent.click(trigger('OITO-07'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open evidence' }))
    expect(trigger('OITO-07')).toHaveFocus()
    await waitFor(() => expect(useUiStore.getState().linkViewerUrl).toBe('C:\\repo\\docs\\oito.md'))

    // No evidence, no Open evidence; Continue goes to the campaign's tab.
    fireEvent.click(trigger('PARADA-01'))
    expect(items()).toEqual(['Conclude (Gate 2)', 'Continue in the terminal'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Continue in the terminal' }))
    expect(useUiStore.getState().activeTerminal?.terminalId).toBe(tagged.id)

    // A night task goes back to the queue and leaves the group; the focus goes to its header.
    fireEvent.click(trigger('NOTURNA-01'))
    expect(items()).toEqual(['Conclude (Gate 2)', 'Continue in the terminal', 'Back to the queue'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Back to the queue' }))
    await waitFor(() => expect(task('NOTURNA-01')?.estado).toBe('pronta'))
    await waitFor(() => expect(gate2Rows()).toEqual(['OITO-07', 'PARADA-01']))
    await waitFor(() =>
      expect(
        within(gate2()!).getByRole('button', { name: /^Waiting for your Gate 2/ }),
      ).toHaveFocus(),
    )

    // Conclude records the task's own evidence, with an undo; the box still checks as before.
    fireEvent.click(trigger('OITO-07'))
    const conclude = screen.getByRole('menuitem', { name: 'Conclude (Gate 2)' })
    await waitFor(() => expect(conclude).toBeEnabled())
    fireEvent.click(conclude)
    await waitFor(() =>
      expect(task('OITO-07')).toMatchObject({
        estado: 'concluída',
        resultado: `marcada no Alethe em ${isoDay(new Date())}`,
        evidencia: 'docs/oito.md',
      }),
    )
    await waitFor(() => expect(lastToast()?.body).toBe('OITO-07 marked done.'))
    await waitFor(() => expect(gate2Rows()).toEqual(['PARADA-01']))
    const box = within(gate2()!).getByRole('button', { name: 'Mark complete' })
    await waitFor(() => expect(box).toBeEnabled())
    fireEvent.click(box)
    await waitFor(() => expect(task('PARADA-01')?.estado).toBe('concluída'))
  })

  describe('order', () => {
    /** The sections in the order shown, by the ids their headers carry. */
    const order = () =>
      [...document.querySelectorAll('[data-section]')].map((item) =>
        item.getAttribute('data-section'),
      )
    const DEFAULT = ['pending', 'active', 'findings', 'campaigns', 'completed']

    afterEach(() => act(() => useUiStore.getState().closeModal()))

    /** Every section on screen: Pending, Active, Findings, Campaigns and Completed. */
    async function renderAll(shown = DEFAULT) {
      fs.files.set(REGISTRY, withResults({ 'OITO-07': GATE_2 }))
      fs.files.set(
        FINDINGS,
        JSON.stringify({
          achados: [
            { id: 'A-1', data: '2026-10-03', tipo: 'bug', titulo: 'T', origem: '', estado: 'novo' },
          ],
        }),
      )
      night(['OITO-03', 'ok'])
      const view = render(
        <>
          <TodoSidebar />
          <TodoSettingsModal />
        </>,
      )
      await screen.findByRole('button', { name: /^Findings/ })
      await waitFor(() => expect(order()).toEqual(shown))
      return view
    }

    it('moves a section with Alt+Arrow keys on its header, keeps it per project, and the settings reset it', async () => {
      const { unmount } = await renderAll()
      const toggle = pending()!
      toggle.focus()

      fireEvent.keyDown(toggle, { key: 'ArrowDown', altKey: true })
      expect(order()).toEqual(['active', 'pending', 'findings', 'campaigns', 'completed'])
      await waitFor(() => expect(pending()).toHaveFocus())
      expect(pending()).toHaveAttribute('aria-expanded', 'true')
      fireEvent.keyDown(header(/^Findings/)!, { key: 'ArrowUp', altKey: true })
      expect(order()).toEqual(['active', 'findings', 'pending', 'campaigns', 'completed'])
      // The first goes no higher, the last no lower, and an arrow without Alt moves nothing.
      fireEvent.keyDown(header(/^Active/)!, { key: 'ArrowUp', altKey: true })
      fireEvent.keyDown(header(/^Completed/)!, { key: 'ArrowDown', altKey: true })
      fireEvent.keyDown(pending()!, { key: 'ArrowDown' })
      expect(order()).toEqual(['active', 'findings', 'pending', 'campaigns', 'completed'])
      expect(useTodosStore.getState().sectionOrder).toEqual({
        [projectId()]: ['active', 'findings', 'pending', 'campaigns', 'completed'],
      })
      // A click on a header still opens and closes it.
      fireEvent.click(pending()!)
      expect(pending()).toHaveAttribute('aria-expanded', 'false')

      // Kept across a remount.
      unmount()
      await renderAll(['active', 'findings', 'pending', 'campaigns', 'completed'])

      // The settings put the default order back.
      act(() => useUiStore.getState().openModal_(TODO_SETTINGS_MODAL_ID))
      const reset = await screen.findByRole('button', { name: 'Reset section order' })
      fireEvent.click(reset)
      await waitFor(() => expect(order()).toEqual(DEFAULT))
      expect(useTodosStore.getState().sectionOrder).toEqual({})
      expect(reset).toBeDisabled()
    })

    it('moves a section dragged by its header, while a click still opens and closes it', async () => {
      await renderAll()
      // jsdom has no layout: sections sit 100 px apart in the order shown, each 90 px tall under a
      // 26 px header.
      const rects = vi
        .spyOn(Element.prototype, 'getBoundingClientRect')
        .mockImplementation(function (this: Element) {
          const headers = [...document.querySelectorAll('[data-section]')]
          const header = this.matches('[data-section]')
            ? this
            : this.querySelector('[data-section]')
          const index = header ? headers.indexOf(header) : -1
          if (index < 0) return DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 })
          const height = header === this ? 26 : 90
          return DOMRect.fromRect({ x: 0, y: index * 100, width: 240, height })
        })
      // Nor pointer events: a mouse event with a pointer's primary flag stands in.
      class FakePointerEvent extends MouseEvent {
        isPrimary = true
        pointerId = 1
      }
      const view = document.defaultView as unknown as Record<string, unknown>
      const native = view.PointerEvent
      view.PointerEvent = FakePointerEvent
      try {
        // A press that moves less than the activation distance is a click.
        const findings = header(/^Findings/)!
        fireEvent.pointerDown(findings, { button: 0, clientX: 20, clientY: 213 })
        fireEvent.pointerMove(document, { clientX: 22, clientY: 216 })
        fireEvent.pointerUp(document, { clientX: 22, clientY: 216 })
        fireEvent.click(findings)
        expect(findings).toHaveAttribute('aria-expanded', 'true')
        expect(order()).toEqual(DEFAULT)

        // Findings, the third, goes up to the second place.
        fireEvent.pointerDown(findings, { button: 0, clientX: 20, clientY: 213 })
        fireEvent.pointerMove(document, { clientX: 20, clientY: 200 })
        fireEvent.pointerMove(document, { clientX: 20, clientY: 113 })
        fireEvent.pointerUp(document, { clientX: 20, clientY: 113 })
        // The click that ends a drag does not toggle the section.
        fireEvent.click(findings)
        expect(order()).toEqual(['pending', 'findings', 'active', 'campaigns', 'completed'])
        expect(findings).toHaveAttribute('aria-expanded', 'true')
      } finally {
        view.PointerEvent = native
        rects.mockRestore()
        // The sensor swallows clicks for 50 ms after a drag; the next test's must go through.
        await act(() => new Promise((resolve) => setTimeout(resolve, 60)))
      }
    })
  })

  it('shows each active campaign in Active with its rows, and Ctrl+N its add field', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    useTodosStore.getState().createTodo('Personal one')
    openTerminal('C:\\repo', 'claude', 'OITO')
    render(<TodoSidebar />)
    const field = () => screen.getByPlaceholderText('Add a task to OITO…')
    const active = await screen.findByRole('button', { name: /^Active/ })
    await waitFor(() => expect(active).toHaveTextContent('1'))
    expect(active).toHaveAttribute('aria-expanded', 'true')
    const section = active.closest('section')!
    expect(screen.queryByPlaceholderText('Add a task to OITO…')).toBeNull()
    expect(section).toContainElement(document.querySelector('[data-task="OITO-02"]') as HTMLElement)
    expect(screen.queryByRole('tablist', { name: 'Task filters' })).toBeNull()
    // The progress bar stays on top.
    expect(screen.getByRole('progressbar').closest('section')).toBeNull()

    fireEvent.click(active)
    expect(document.querySelector('[data-task]')).toBeNull()
    // Ctrl+N opens it again on its add field.
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true })
    await waitFor(() => expect(field()).toHaveFocus())

    // Personal keeps its add field on top, with no campaign header and no filters.
    fireEvent.click(screen.getByRole('tab', { name: /^Personal/ }))
    expect(header(/^Active/)).toBeNull()
    expect(screen.queryByRole('tablist', { name: 'Task filters' })).toBeNull()
    expect(screen.getByPlaceholderText('Add a task…').closest('section')).toBeNull()
    expect(screen.getByText('Personal one')).toBeInTheDocument()
  })
})

describe('Task detail', () => {
  const NIGHTS = 'C:\\repo\\.workflow\\local\\noites'
  const FINDINGS = 'C:\\repo\\.workflow\\achados.json'
  const projectId = () => useProjectsStore.getState().projects[0].id
  const row = (id: string) => document.querySelector(`[data-task="${id}"]`) as HTMLElement
  const toggle = (id: string) => within(row(id)).getByRole('button', { name: `Details of ${id}` })
  const detail = (id: string) => screen.queryByRole('group', { name: `Details of ${id}` })
  /** Each row of a detail as [label, its lines], or [label, its text] when it has no lines. */
  const rows = (id: string) =>
    within(detail(id)!)
      .queryAllByRole('term')
      .map((term) => {
        const value = term.nextElementSibling as HTMLElement
        const lines = [...value.querySelectorAll('[data-line]')].map((line) => line.textContent)
        return [term.textContent, lines.length > 0 ? lines : value.textContent]
      })

  /** OITO active, OITO-02 with something for every row of its detail; OITO waits for `waits`. */
  function seed(waits = ['BASE', 'ABERTA']) {
    const data = structuredClone(exemplo)
    Object.assign(data.campanhas[1], { depende_de: waits })
    Object.assign(data.campanhas[1].tarefas[1], {
      resultado: 'Parcial: falta o teste\nsegunda linha',
      evidencia: 'docs/oito-02.md',
      depende_de: ['NOTURNA-02'],
    })
    fs.files.set(REGISTRY, JSON.stringify(data))
    fs.found.set('docs/oito-02.md', 'C:\\repo\\docs\\oito-02.md')
    const job = (
      id: string,
      task: string,
      status: string,
      cwd: string,
      agent: string,
      model: string | null,
      seconds: number | null,
    ) => ({ id, task, status, cwd, agent, model, seconds })
    orchestrator.jobs = [
      job('j1', 'OITO-02', 'running', 'C:\\repo-feature', 'claude', 'sonnet', 190),
      job('j2', 'OITO-02', 'queued', 'C:\\repo', 'codex', null, null),
      job('j3', 'OITO-02', 'blocked', 'C:\\repo', 'codex', 'gpt-5', 30),
      job('j4', 'OITO-02', 'done', 'C:\\repo', 'claude', null, 600),
      job('j5', 'OITO-02', 'failed', 'C:\\repo', 'claude', null, 60),
      // Another repository's task with the same id, and another task: neither is listed.
      job('j6', 'OITO-02', 'running', 'C:\\other', 'opencode', null, 5),
      job('j7', 'OITO-03', 'running', 'C:\\repo', 'codex', 'other-task', 5),
    ] as typeof orchestrator.jobs
    const entry = (tarefa: string, resultado: string) => ({
      tarefa,
      resultado,
      resumo: `${tarefa} resumo`,
      evidencia: '',
      hora: '03:41',
    })
    fs.files.set(
      `${NIGHTS}\\2026-10-03.json`,
      JSON.stringify({
        data: '2026-10-03',
        entradas: [entry('OITO-02', 'falhou'), entry('OITO-03', 'ok')],
      }),
    )
    const finding = (id: string, origem: string, estado = 'novo') => ({
      id,
      data: '2026-10-03',
      tipo: 'bug',
      titulo: `${id} title`,
      origem,
      estado,
    })
    fs.files.set(
      FINDINGS,
      JSON.stringify({
        achados: [
          finding('A-1', 'OITO-02'),
          finding('A-2', 'OITO-03'),
          finding('A-3', 'OITO-02', 'triado'),
        ],
      }),
    )
    useTodosStore.setState({ activeCampaigns: { [projectId()]: 'OITO' } })
  }

  beforeEach(() => useUiStore.setState({ toasts: [], notifications: [], linkViewerUrl: null }))

  it('expands a task row into its result, evidence, waits, workers, night and findings', async () => {
    seed()
    render(<TodoSidebar />)
    await waitFor(() => expect(row('OITO-02')).toHaveTextContent('2 running'))
    await screen.findByRole('button', { name: /^Findings 2/ })
    // The night card is in the Night tab: wait for the diary its rows read.
    await waitFor(() => expect(readTextFile).toHaveBeenCalledWith(`${NIGHTS}\\2026-10-03.json`))
    await act(async () => {})
    expect(toggle('OITO-02')).toHaveAttribute('aria-expanded', 'false')
    expect(detail('OITO-02')).toBeNull()

    fireEvent.click(toggle('OITO-02'))
    expect(toggle('OITO-02')).toHaveAttribute('aria-expanded', 'true')
    expect(toggle('OITO-02')).toHaveAttribute('aria-controls', detail('OITO-02')!.id)
    expect(within(detail('OITO-02')!).getByText('T2 · Assisted')).toBeInTheDocument()
    expect(rows('OITO-02')).toEqual([
      ['Result', 'Parcial: falta o teste\nsegunda linha'],
      ['Evidence', 'docs/oito-02.mdOpen'],
      ['Waiting for', 'ABERTA, NOTURNA-02'],
      [
        'Workers',
        [
          'waiting on you: codex gpt-5 0 min',
          'running: claude sonnet 3 min',
          'queued: codex',
          'failed: claude 1 min',
          'finished: claude 10 min',
        ],
      ],
      ['Night', ['10/03 · failed · OITO-02 resumo']],
      ['Findings', ['A-1 · bug · A-1 title']],
    ])
    // Only the row's own task is expanded.
    expect(detail('OITO-03')).toBeNull()
  })

  it('leaves out the rows a task has nothing for', async () => {
    seed(['BASE'])
    render(<TodoSidebar />)
    await screen.findByRole('button', { name: /^Findings 2/ })
    // The night card is in the Night tab: wait for the diary its rows read.
    await waitFor(() => expect(readTextFile).toHaveBeenCalledWith(`${NIGHTS}\\2026-10-03.json`))
    await act(async () => {})
    await waitFor(() => expect(row('OITO-03')).toHaveTextContent('1 running'))
    fireEvent.click(toggle('OITO-05'))
    expect(within(detail('OITO-05')!).getByText('T1 · Assisted')).toBeInTheDocument()
    expect(rows('OITO-05')).toEqual([])

    fireEvent.click(toggle('OITO-03'))
    expect(rows('OITO-03')).toEqual([
      ['Workers', ['running: codex other-task 0 min']],
      ['Night', ['10/03 · ok · OITO-03 resumo']],
      ['Findings', ['A-2 · bug · A-2 title']],
    ])
  })

  it('opens the evidence through the shared opener, looked up at the click', async () => {
    seed()
    render(<TodoSidebar />)
    await waitFor(() => expect(row('OITO-02')).not.toBeNull())
    fireEvent.click(toggle('OITO-02'))
    const open = within(detail('OITO-02')!).getByRole('button', { name: 'Open docs/oito-02.md' })
    expect(findRelativePath).not.toHaveBeenCalledWith('C:\\repo', 'docs/oito-02.md')

    fireEvent.click(open)
    await waitFor(() =>
      expect(useUiStore.getState().linkViewerUrl).toBe('C:\\repo\\docs\\oito-02.md'),
    )
    expect(findRelativePath).toHaveBeenCalledWith('C:\\repo', 'docs/oito-02.md')

    // Evidence that is not a path is shown as text, with nothing to open.
    await editRegistry((data) => {
      Object.assign(data.campanhas[1].tarefas[1], { evidencia: 'checked by hand' })
    })
    expect(rows('OITO-02')[1]).toEqual(['Evidence', 'checked by hand'])
    expect(within(detail('OITO-02')!).queryByRole('button')).toBeNull()
  })

  it('keeps the checkbox concluding the task, and toggles from the keyboard', async () => {
    seed()
    render(<TodoSidebar />)
    await waitFor(() => expect(row('OITO-03')).not.toBeNull())
    const chevron = toggle('OITO-03')
    // A native button: in the tab order, Enter and Space press it.
    expect(chevron.tagName).toBe('BUTTON')
    expect(chevron).not.toHaveAttribute('tabindex')
    chevron.focus()
    expect(chevron).toHaveFocus()
    fireEvent.click(chevron)
    expect(detail('OITO-03')).not.toBeNull()
    expect(chevron).toHaveFocus()
    fireEvent.click(chevron)
    expect(detail('OITO-03')).toBeNull()
    expect(chevron).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(chevron)
    fireEvent.click(within(row('OITO-03')).getByRole('button', { name: 'Mark complete' }))
    await waitFor(() => expect(task('OITO-03')?.estado).toBe('concluída'))
  })

  it('expands a task waiting for your Gate 2 too, its title still opening its actions', async () => {
    seed()
    const data = JSON.parse(fs.files.get(REGISTRY)!) as typeof exemplo
    Object.assign(data.campanhas[5].tarefas[0], {
      resultado: 'aguarda o Gate 2 do usuário: revisar',
    })
    fs.files.set(REGISTRY, JSON.stringify(data))
    render(<TodoSidebar />)
    const gate2 = await screen.findByRole('group', { name: 'Waiting for your Gate 2' })

    fireEvent.click(within(gate2).getByRole('button', { name: 'Details of PARADA-01' }))
    expect(within(detail('PARADA-01')!).getByText('T1 · Any time')).toBeInTheDocument()
    expect(rows('PARADA-01')).toEqual([['Result', 'aguarda o Gate 2 do usuário: revisar']])
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(within(gate2).getByRole('button', { name: /^PARADA-01 / }))
    expect(screen.getByRole('menu', { name: 'Actions for PARADA-01' })).toBeInTheDocument()
  })

  it('wraps a long level in the meta line, keeping the window after it', async () => {
    seed()
    const level = `T2 ${'nível muito comprido '.repeat(12).trim()}`
    const data = JSON.parse(fs.files.get(REGISTRY)!) as typeof exemplo
    Object.assign(data.campanhas[1].tarefas[1], { nivel: level })
    fs.files.set(REGISTRY, JSON.stringify(data))
    render(<TodoSidebar />)
    await waitFor(() => expect(row('OITO-02')).not.toBeNull())
    fireEvent.click(toggle('OITO-02'))

    const meta = within(detail('OITO-02')!).getByText(`${level} · Assisted`)
    // Its own wrapping line, not the one-line `.meta` that clips what overflows.
    expect(meta.className).toMatch(/detailMeta/)
    expect(meta.className).not.toMatch(/(^|\s)_meta_/)
    const css = readFileSync(resolve('src/plugins/todos/TodoSidebar.module.css'), 'utf8')
    const rule = /\.detailMeta \{([^}]*)\}/.exec(css)?.[1]
    expect(rule).toContain('overflow-wrap: anywhere')
    expect(rule).not.toMatch(/nowrap|overflow: hidden/)
  })

  it('advances worker minutes by one clock while a job is live, and stops it after', async () => {
    /** The projected jobs, as `id:minutes`. */
    function Jobs() {
      return (
        <p>
          {useTaskJobs()
            .map((job) => `${job.id}:${job.minutes}`)
            .join(' ')}
        </p>
      )
    }
    const job = (id: string, status: string, seconds: number | null) =>
      ({
        id,
        task: 'OITO-02',
        status,
        cwd: 'C:\\repo',
        agent: 'claude',
        model: null,
        seconds,
      }) as (typeof orchestrator.jobs)[number]
    vi.useFakeTimers()
    try {
      orchestrator.jobs = [
        job('j1', 'running', 30),
        job('j2', 'done', 600),
        job('j3', 'queued', null),
      ]
      const { container, unmount } = render(<Jobs />)
      await act(async () => {})
      expect(container).toHaveTextContent('j1:0 j2:10 j3:null')
      expect(vi.getTimerCount()).toBe(1)

      // A silent worker: no event for five minutes, its minutes still go on; a settled one stays.
      await act(async () => vi.advanceTimersByTime(5 * 60_000))
      expect(container).toHaveTextContent('j1:5 j2:10 j3:null')

      // A new snapshot counts from its own seconds, on the same single clock.
      act(() => orchestrator.emit?.({ jobs: [job('j1', 'running', 400)] }))
      expect(container).toHaveTextContent('j1:6')
      expect(vi.getTimerCount()).toBe(1)

      // Nothing live: the clock stops, and the minutes stay as reported.
      act(() => orchestrator.emit?.({ jobs: [job('j1', 'done', 420)] }))
      expect(vi.getTimerCount()).toBe(0)
      await act(async () => vi.advanceTimersByTime(5 * 60_000))
      expect(container).toHaveTextContent('j1:7')

      act(() => orchestrator.emit?.({ jobs: [job('j4', 'blocked', 0)] }))
      expect(vi.getTimerCount()).toBe(1)
      unmount()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
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
      useTodosStore.setState({ nightRun: { current: running, nights: {} }, tab: 'night' })
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

describe('Todo tabs', () => {
  const NIGHTS = 'C:\\repo\\.workflow\\local\\noites'
  const GATE_2 = 'aguarda o Gate 2 do usuário'
  const projectId = () => useProjectsStore.getState().projects[0].id
  const tab = (name: RegExp) => screen.getByRole('tab', { name })
  const header = (name: RegExp) => screen.queryByRole('button', { name })
  /** An active campaign's subsection. */
  const active = (id: string) => screen.queryByRole('group', { name: id })
  const rows = (box: HTMLElement | null) =>
    [...(box?.querySelectorAll('[data-task]') ?? [])].map((row) => row.getAttribute('data-task'))
  const segments = () =>
    [...screen.getByRole('progressbar').querySelectorAll('[title]')].map((item) =>
      item.getAttribute('title'),
    )
  const withResults = (results: Record<string, string>) => {
    const data = structuredClone(exemplo)
    for (const item of data.campanhas.flatMap((campaign) => campaign.tarefas)) {
      if (item.id in results) Object.assign(item, { resultado: results[item.id] })
    }
    return JSON.stringify(data)
  }

  beforeEach(() => useUiStore.setState({ toasts: [], notifications: [] }))

  it('shows Overview, Night and Personal tabs and remembers the last one shown', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    useTodosStore.getState().createTodo('Personal one')
    render(<TodoSidebar />)
    await screen.findByRole('button', { name: /^Campaigns/ })
    expect(tab(/^Overview/)).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('button', { name: 'List source' })).toBeNull()
    expect(screen.queryByText('Personal one')).toBeNull()

    fireEvent.click(tab(/^Personal/))
    expect(tab(/^Personal/)).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Personal one')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Add a task…')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveTextContent('0 / 1')
    expect(header(/^Campaigns/)).toBeNull()
    expect(useTodosStore.getState().tab).toBe('personal')

    cleanup()
    render(<TodoSidebar />)
    expect(tab(/^Personal/)).toHaveAttribute('aria-selected', 'true')

    // A night running in this project shows on the Night tab.
    act(() =>
      useTodosStore.setState({
        nightRun: {
          current: {
            projectId: projectId(),
            campaignId: 'OITO',
            taskId: 'OITO-08',
            terminalId: null,
            tabId: null,
            startedAt: Date.now(),
            deadline: Date.now() + 60_000,
          },
          nights: {},
        },
      }),
    )
    expect(tab(/^Night/)).toHaveAccessibleName('Night Running')
    fireEvent.click(tab(/^Night/))
    expect(screen.getByRole('status')).toHaveTextContent('OITO-08')
  })

  it('shows a finished campaign only under Completed, even with its tab open', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    openTerminal('C:\\repo', 'claude', 'BASE')
    render(<TodoSidebar />)
    const map = await screen.findByRole('button', { name: /^Campaigns/ })
    expect(active('BASE')).toBeNull()
    expect(screen.getByText('No active campaign: open one from Campaigns.')).toBeInTheDocument()
    fireEvent.click(map)
    expect(screen.getByRole('group', { name: 'Started' })).toBeInTheDocument()
    expect(screen.queryByText('BASE')).toBeNull()

    const completed = header(/^Completed/)!
    expect(completed).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(completed)
    const row = screen.getByText('BASE').closest('[data-status]')!
    expect(row).toHaveAttribute('data-status', 'stopped')
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: /^BASE/ }))
    expect(screen.getByText('BASE-02')).toBeInTheDocument()
  })

  it('gives each active campaign its own subsection: controls, add field, open tasks and done ones', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    openTerminal('C:\\repo', 'claude', 'OITO')
    openTerminal('C:\\repo', 'claude', 'PARADA')
    render(<TodoSidebar />)
    await waitFor(() => expect(active('PARADA')).not.toBeNull())
    const oito = active('OITO')!
    expect(
      within(oito).getByRole('button', { name: /^OITO · Uma de oito feitas/ }),
    ).toHaveTextContent('1/8')
    expect(
      screen.getAllByRole('group').filter((box) => /^(OITO|PARADA)$/.test(box.ariaLabel ?? '')),
    ).toEqual([oito, active('PARADA')])
    expect(within(oito).getByRole('button', { name: 'Go to tab' })).toBeEnabled()
    expect(within(active('PARADA')!).getByRole('button', { name: 'Go to tab' })).toBeEnabled()
    expect(rows(oito)).toEqual([
      'OITO-02',
      'OITO-03',
      'OITO-04',
      'OITO-05',
      'OITO-08',
      'OITO-06',
      'OITO-07',
    ])
    expect(rows(active('PARADA'))).toEqual(['PARADA-01'])
    // Its done tasks wait, collapsed, at its end; no filter tabs.
    fireEvent.click(within(oito).getByRole('button', { name: '1 done' }))
    expect(rows(oito).at(-1)).toBe('OITO-01')
    expect(screen.queryByRole('tab', { name: 'All' })).toBeNull()
    // Its facts are the map row's, in its header's tooltip.
    expect(
      within(oito)
        .getByRole('button', { name: /^OITO ·/ })
        .getAttribute('title'),
    ).toMatch(/^Assisted · .* · In progress, 4 ready$/)

    // Each add field writes to its own campaign.
    fireEvent.click(
      within(active('PARADA')!).getByRole('button', { name: 'Add a task to PARADA…' }),
    )
    const field = within(active('PARADA')!).getByPlaceholderText('Add a task to PARADA…')
    fireEvent.change(field, { target: { value: 'Nova tarefa' } })
    fireEvent.submit(field.closest('form')!)
    await waitFor(() => expect(rows(active('PARADA'))).toContain('PARADA-02'))
    expect(within(oito).queryByPlaceholderText('Add a task to OITO…')).toBeNull()

    // Live campaigns leave the map.
    fireEvent.click(header(/^Campaigns/)!)
    const map = header(/^Campaigns/)!.closest('section')!
    expect(within(map).getByText('DEPOIS')).toBeInTheDocument()
    expect(within(map).queryByText('OITO')).toBeNull()
    expect(within(map).queryByText('PARADA')).toBeNull()
  })

  it('splits the progress bar into one segment per active campaign, with the summed count', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    openTerminal('C:\\repo', 'claude', 'OITO')
    openTerminal('C:\\repo', 'claude', 'PARADA')
    render(<TodoSidebar />)
    await waitFor(() => expect(segments()).toEqual(['OITO · 1/8', 'PARADA · 0/1']))
    expect(screen.getByRole('progressbar')).toHaveTextContent('1 / 9')
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1')
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '9')
  })

  it('covers the whole registry with one segment while no campaign is active', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    render(<TodoSidebar />)
    await screen.findByRole('button', { name: /^Campaigns/ })
    // BASE 2/2, OITO 1/8, ABERTA 1/1 (not decomposed), DEPOIS 0/1, NOTURNA 0/2, PARADA 0/1.
    expect(segments()).toEqual(['All campaigns · 4/15+?'])
    expect(screen.getByRole('progressbar')).toHaveTextContent('4 / 15+?')
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '4')
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '15')
  })

  it('lists a Gate 2 task and an undecided night entry only in Pending; the night card is in Night', async () => {
    fs.files.set(REGISTRY, withResults({ 'OITO-07': GATE_2 }))
    fs.files.set(
      `${NIGHTS}\\2026-10-03.json`,
      JSON.stringify({
        data: '2026-10-03',
        entradas: [
          {
            tarefa: 'OITO-06',
            resultado: 'aguarda-voce',
            resumo: 'resumo',
            evidencia: '',
            hora: '03:41',
          },
          { tarefa: 'OITO-03', resultado: 'ok', resumo: 'feito', evidencia: '', hora: '04:10' },
        ],
      }),
    )
    openTerminal('C:\\repo', 'claude', 'OITO')
    render(<TodoSidebar />)
    const pending = await screen.findByRole('button', { name: /^Pending/ })
    const section = pending.closest('section')!
    await waitFor(() => expect(within(section).getByText('night 10/03')).toBeInTheDocument())
    expect(within(section).getByRole('button', { name: /^OITO-06 / })).toBeInTheDocument()
    expect(document.querySelectorAll('[data-task="OITO-07"]')).toHaveLength(1)
    expect(section).toContainElement(document.querySelector('[data-task="OITO-07"]') as HTMLElement)
    expect(rows(active('OITO'))).not.toContain('OITO-06')
    expect(rows(active('OITO'))).not.toContain('OITO-07')
    expect(header(/^Night of/)).toBeNull()

    fireEvent.click(tab(/^Night/))
    expect(await screen.findByRole('button', { name: /^Night of 10\/03/ })).toBeInTheDocument()
    expect(header(/^Pending/)).toBeNull()
  })

  it('Ctrl+N goes to the add field of the active campaign, else to the personal composer', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    openTerminal('C:\\repo', 'claude', 'OITO')
    const parada = openTerminal('C:\\repo', 'claude', 'PARADA')
    focusTerminal(parada.id)
    render(<TodoSidebar />)
    await waitFor(() => expect(active('PARADA')).not.toBeNull())
    const field = (id: string) => screen.queryByPlaceholderText(`Add a task to ${id}…`)
    expect(field('PARADA')).toBeNull()

    // Even collapsed, the focused campaign's field opens for one task.
    fireEvent.click(within(active('PARADA')!).getByRole('button', { name: /^PARADA ·/ }))
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true })
    await waitFor(() => expect(field('PARADA')).toHaveFocus())
    expect(field('OITO')).toBeNull()
    fireEvent.keyDown(field('PARADA')!, { key: 'Escape' })
    expect(field('PARADA')).toBeNull()

    // Elsewhere, it opens Personal on its composer.
    fireEvent.click(tab(/^Night/))
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true })
    await waitFor(() => expect(screen.getByPlaceholderText('Add a task…')).toHaveFocus())
    expect(tab(/^Personal/)).toHaveAttribute('aria-selected', 'true')
  })

  it('keeps one campaign control at a time across a switch of tab', async () => {
    fs.files.set(REGISTRY, JSON.stringify(withOito(exemplo, { handoff: 'docs/handoff.md' })))
    orchestrator.jobs = [{ id: 'job-q', task: 'OITO-03', status: 'queued', cwd: 'C:\\repo' }]
    // The handoff lookup stays pending until released.
    let release: (path: string | null) => void = () => {}
    vi.mocked(findRelativePath).mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    )
    render(<TodoSidebar />)
    await waitFor(() => expect(active('OITO')).not.toBeNull())
    const resume = () => within(active('OITO')!).getByRole('button', { name: 'Continue campaign' })
    fireEvent.click(resume())
    await waitFor(() => expect(findRelativePath).toHaveBeenCalledTimes(1))

    // Leaving Overview and coming back while it runs keeps the controls held.
    fireEvent.click(tab(/^Night/))
    fireEvent.click(tab(/^Overview/))
    expect(resume()).toBeDisabled()
    fireEvent.click(resume())
    expect(findRelativePath).toHaveBeenCalledTimes(1)
    await act(async () => release(null))
    await waitFor(() => expect(agentTerminals()).toHaveLength(1))
  })

  it('goes to an active campaign tab without typing anything into it', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    const terminal = openTerminal('C:\\repo', 'claude', 'OITO')
    useProjectsStore
      .getState()
      .setSubTabPtyId(projectId(), terminal.id, terminal.tabs[0].id, 'pty-o')
    act(() => useUiStore.setState({ activeTerminal: null }))
    render(<TodoSidebar />)
    await waitFor(() => expect(active('OITO')).not.toBeNull())
    fireEvent.click(within(active('OITO')!).getByRole('button', { name: 'Go to tab' }))
    expect(useUiStore.getState().activeTerminal?.terminalId).toBe(terminal.id)
    expect(writePty).not.toHaveBeenCalled()
  })

  it('lists a task in Pending only there: Active and the map count it instead', async () => {
    fs.files.set(REGISTRY, withResults({ 'OITO-07': GATE_2, 'PARADA-01': GATE_2 }))
    openTerminal('C:\\repo', 'claude', 'OITO')
    render(<TodoSidebar />)
    await waitFor(() => expect(active('OITO')).not.toBeNull())
    expect(document.querySelectorAll('[data-task="OITO-07"]')).toHaveLength(1)
    expect(within(active('OITO')!).getByText('1 in Pending')).toBeInTheDocument()

    fireEvent.click(header(/^Campaigns/)!)
    const map = header(/^Campaigns/)!.closest('section')!
    fireEvent.click(within(map).getByRole('button', { name: /^PARADA/ }))
    expect(within(map).queryByText('PARADA-01')).toBeNull()
    expect(within(map).getByText('1 in Pending')).toBeInTheDocument()
  })

  it('keeps an add field draft across a switch of tab', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    openTerminal('C:\\repo', 'claude', 'OITO')
    render(<TodoSidebar />)
    const field = () => screen.getByPlaceholderText('Add a task to OITO…')
    fireEvent.click(await screen.findByRole('button', { name: 'Add a task to OITO…' }))
    fireEvent.change(field(), { target: { value: 'unsaved draft' } })

    fireEvent.click(tab(/^Night/))
    fireEvent.click(tab(/^Overview/))
    expect(field()).toHaveValue('unsaved draft')
  })
})

describe('Active campaign step', () => {
  const NIGHTS = 'C:\\repo\\.workflow\\local\\noites'
  const projectId = () => useProjectsStore.getState().projects[0].id
  /** An active campaign's subsection. */
  const active = (id: string) => screen.queryByRole('group', { name: id })
  const row = (id: string) => document.querySelector(`[data-task="${id}"]`) as HTMLElement
  /** A terminal opened for `campaignId`, its first tab on `ptyId` in `status`. */
  function agentTab(campaignId: string, ptyId: string, status: 'working' | 'waiting') {
    const terminal = openTerminal('C:\\repo', 'claude', campaignId)
    useProjectsStore.getState().setSubTabPtyId(projectId(), terminal.id, terminal.tabs[0].id, ptyId)
    useTerminalsStore.getState().registerPty(ptyId)
    useTerminalsStore.getState().setStatus(ptyId, status)
    return terminal
  }
  const withResults = (results: Record<string, string>) => {
    const data = structuredClone(exemplo)
    for (const item of data.campanhas.flatMap((campaign) => campaign.tarefas)) {
      if (item.id in results) Object.assign(item, { resultado: results[item.id] })
    }
    return JSON.stringify(data)
  }
  const night = (...entries: Array<[string, string]>) =>
    fs.files.set(
      `${NIGHTS}\\2026-10-03.json`,
      JSON.stringify({
        data: '2026-10-03',
        entradas: entries.map(([tarefa, resultado]) => ({
          tarefa,
          resultado,
          resumo: `${tarefa} resumo`,
          evidencia: '',
          hora: '03:41',
        })),
      }),
    )

  beforeEach(() => {
    useUiStore.setState({ toasts: [], notifications: [] })
    useTerminalsStore.getState().reset()
  })
  afterEach(() => useTerminalsStore.getState().reset())

  it('offers Go to tab and Cancel while a campaign has a tab, and Pause too while it works', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    agentTab('OITO', 'pty-o', 'waiting')
    render(<TodoSidebar />)
    await waitFor(() => expect(active('OITO')).not.toBeNull())
    const oito = active('OITO')!
    const control = (name: string) => within(oito).queryByRole('button', { name })
    expect(control('Go to tab')).toBeEnabled()
    expect(control('Cancel campaign')).toHaveTextContent(/^Cancel$/)
    expect(control('Cancel campaign')).toHaveAttribute('title', 'Cancel campaign')
    // Its conversation goes on in its tab: nothing to continue from here.
    expect(control('Continue campaign')).toBeNull()
    expect(control('Pause campaign')).toBeNull()

    act(() => useTerminalsStore.getState().setStatus('pty-o', 'working'))
    expect(control('Pause campaign')).toHaveTextContent(/^Pause$/)
    expect(control('Pause campaign')).toHaveAttribute('title', 'Pause campaign')
    // One row: Go to tab, Pause, Cancel.
    const line = control('Go to tab')!.parentElement!
    expect(
      within(line)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Go to tab', 'Pause', 'Cancel'])
  })

  it('offers Continue and Cancel to a campaign live through its workers alone', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    orchestrator.jobs = [{ id: 'job-d', task: 'DEPOIS-01', status: 'queued', cwd: 'C:\\repo' }]
    render(<TodoSidebar />)
    await waitFor(() => expect(active('DEPOIS')).not.toBeNull())
    const depois = active('DEPOIS')!
    const resume = within(depois).getByRole('button', { name: 'Continue campaign' })
    expect(resume).toHaveTextContent(/^Continue$/)
    expect(resume).toHaveAttribute('title', 'Continue campaign')
    expect(within(depois).getByRole('button', { name: 'Cancel campaign' })).toBeEnabled()
    expect(within(depois).queryByRole('button', { name: 'Go to tab' })).toBeNull()
  })

  it('shows the step of each open task, its registry result, under its title', async () => {
    const step = 'W-Y v3 aprovado no aceite 05/10; aguarda revisão da tabela A e Gate 1'
    fs.files.set(
      REGISTRY,
      withResults({
        'OITO-03': step,
        'OITO-01': 'feita e conferida',
        'OITO-07': 'aguarda o Gate 2 do usuário',
      }),
    )
    openTerminal('C:\\repo', 'claude', 'OITO')
    render(<TodoSidebar />)
    await waitFor(() => expect(row('OITO-03')).not.toBeNull())
    const line = within(row('OITO-03')).getByText(step)
    expect(line).toHaveAttribute('title', step)
    expect(row('OITO-02')).not.toHaveTextContent('aguarda')
    // A Gate 2 task's result is why it is in Pending, not a step; a done task has none.
    expect(within(row('OITO-07')).queryByText('aguarda o Gate 2 do usuário')).toBeNull()
    fireEvent.click(within(active('OITO')!).getByRole('button', { name: '1 done' }))
    expect(within(row('OITO-01')).queryByText('feita e conferida')).toBeNull()
  })

  it('keeps a subsection lean: its facts in its header tooltip, its add field behind +', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    orchestrator.jobs = [{ id: 'job-o', task: 'OITO-03', status: 'queued', cwd: 'C:\\repo' }]
    openTerminal('C:\\repo', 'claude', 'OITO')
    render(<TodoSidebar />)
    await waitFor(() => expect(active('OITO')).not.toBeNull())
    const oito = active('OITO')!
    const head = within(oito).getByRole('button', { name: /^OITO ·/ })
    expect(head.getAttribute('title')).toContain('Assisted')
    expect(head.getAttribute('title')).toContain('In progress, 4 ready')
    await waitFor(() => expect(head).toHaveTextContent('1 queued'))
    expect(within(oito).queryByRole('button', { name: 'Details' })).toBeNull()
    expect(screen.queryByRole('button', { name: /the add field$/ })).toBeNull()

    // The add field waits behind +, for one task.
    const field = () => within(oito).queryByPlaceholderText('Add a task to OITO…')
    expect(field()).toBeNull()
    fireEvent.click(within(oito).getByRole('button', { name: 'Add a task to OITO…' }))
    await waitFor(() => expect(field()).toHaveFocus())
    fireEvent.change(field()!, { target: { value: 'Nova tarefa' } })
    fireEvent.submit(field()!.closest('form')!)
    await waitFor(() => expect(row('OITO-09')).not.toBeNull())
    expect(field()).toBeNull()
    fireEvent.click(within(oito).getByRole('button', { name: 'Add a task to OITO…' }))
    await waitFor(() => expect(field()).toHaveFocus())
    fireEvent.keyDown(field()!, { key: 'Escape' })
    expect(field()).toBeNull()
  })

  it('fills the Night tab bar with the latest night tasks done now, over their count', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    // OITO-01 is done in the registry; OITO-03 is listed twice; MOTOR-09 is not in it.
    night(['OITO-01', 'ok'], ['OITO-03', 'falhou'], ['OITO-03', 'aguarda-voce'], ['MOTOR-09', 'ok'])
    openTerminal('C:\\repo', 'claude', 'OITO')
    useTodosStore.setState({ tab: 'night' })
    render(<TodoSidebar />)
    const bar = () => screen.queryByRole('progressbar')
    await waitFor(() => expect(bar()).toHaveTextContent('1 / 3'))
    expect(bar()!.querySelector('[title]')).toHaveAttribute('title', 'Night of 10/03 · 1/3')

    // Overview keeps its campaign segments.
    fireEvent.click(screen.getByRole('tab', { name: /^Overview/ }))
    expect(bar()!.querySelector('[title]')).toHaveAttribute('title', 'OITO · 1/8')
  })

  it('hides the Night tab bar without a diary', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    useTodosStore.setState({ tab: 'night' })
    render(<TodoSidebar />)
    await waitFor(() => expect(listDirectory).toHaveBeenCalledWith(NIGHTS))
    await act(async () => {})
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('reads a decided night entry by its task state now, not as waiting on you', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    // Done; back in the queue (ready); gone from the registry; and still waiting on you.
    night(
      ['OITO-01', 'aguarda-voce'],
      ['DEPOIS-01', 'aguarda-voce'],
      ['GONE-01', 'aguarda-voce'],
      ['OITO-07', 'aguarda-voce'],
    )
    useTodosStore.setState({ tab: 'night' })
    render(<TodoSidebar />)
    const card = await screen.findByRole('button', { name: /^Night of 10\/03/ })
    expect(card).toHaveTextContent('1 waiting on you')
    fireEvent.click(card)
    const entries = [...document.querySelectorAll('li[data-lane]')]
    expect(
      entries.map((entry) => [
        entry.getAttribute('data-lane'),
        entry.querySelector('[role="img"]')!.getAttribute('aria-label'),
      ]),
    ).toEqual([
      ['finished', 'Done'],
      ['queued', 'Ready'],
      ['interrupted', 'stopped'],
      ['queued', 'waiting on you'],
    ])
  })
})

describe('Task steps', () => {
  const projectId = () => useProjectsStore.getState().projects[0].id
  const row = (id: string) => document.querySelector(`[data-task="${id}"]`) as HTMLElement
  const T = (texto: string) => ({ texto, feito: true })
  const F = (texto: string) => ({ texto, feito: false })
  /** The example registry with these task fields. */
  const withTasks = (fields: Record<string, Record<string, unknown>>) => {
    const data = structuredClone(exemplo)
    for (const item of data.campanhas.flatMap((campaign) => campaign.tarefas)) {
      if (item.id in fields) Object.assign(item, fields[item.id])
    }
    return JSON.stringify(data)
  }
  const RESULT = 'W-Y v3 aprovado no aceite 05/10; aguarda revisão da tabela A e Gate 1'

  beforeEach(() => useCampaignStepsStore.setState({ byProject: {} }))

  it('reads an open task step line as done/total and its current step, its result in the tooltip', async () => {
    fs.files.set(
      REGISTRY,
      withTasks({
        'OITO-03': {
          resultado: RESULT,
          passos: [T('Ler o registro'), F('Medir a tabela A'), F('Comparar')],
        },
        'OITO-05': { passos: [T('Ler'), T('Medir')] },
        'OITO-06': { resultado: 'sem passos' },
      }),
    )
    openTerminal('C:\\repo', 'claude', 'OITO')
    render(<TodoSidebar />)
    await waitFor(() => expect(row('OITO-03')).not.toBeNull())
    const line = within(row('OITO-03')).getByText('1/3 · Medir a tabela A')
    expect(line).toHaveAttribute('title', RESULT)
    // All done, it reads total/total; without a result, the line is its own tooltip.
    expect(within(row('OITO-05')).getByText('2/2')).toHaveAttribute('title', '2/2')
    // Without steps, the result as before.
    expect(within(row('OITO-06')).getByText('sem passos')).toHaveAttribute('title', 'sem passos')
  })

  it('lists the steps in the task detail, the done ones marked and the current one set apart', async () => {
    fs.files.set(
      REGISTRY,
      withTasks({
        'OITO-03': { passos: [T('Ler o registro'), F('Medir a tabela A'), F('Comparar')] },
      }),
    )
    openTerminal('C:\\repo', 'claude', 'OITO')
    render(<TodoSidebar />)
    await waitFor(() => expect(row('OITO-03')).not.toBeNull())
    fireEvent.click(within(row('OITO-03')).getByRole('button', { name: 'Details of OITO-03' }))
    const detail = screen.getByRole('group', { name: 'Details of OITO-03' })
    const term = within(detail).getByText('Steps')
    const lines = [...term.nextElementSibling!.querySelectorAll('[data-line]')]
    expect(lines.map((item) => item.textContent)).toEqual([
      '1 of 3 done',
      '✓ Ler o registro',
      '→ Medir a tabela A',
      'Comparar',
    ])
    expect(lines[2]).toHaveAttribute('aria-current', 'step')
    expect(lines.filter((item) => item.hasAttribute('aria-current'))).toHaveLength(1)

    // A task without steps has no such row.
    fireEvent.click(within(row('OITO-02')).getByRole('button', { name: 'Details of OITO-02' }))
    const other = screen.getByRole('group', { name: 'Details of OITO-02' })
    expect(within(other).queryByText('Steps')).toBeNull()
  })

  it('publishes where each campaign is by its steps, for the terminal titles, until the registry goes', async () => {
    fs.files.set(
      REGISTRY,
      withTasks({
        'OITO-03': { passos: [T('a'), F('b'), F('c')] },
        'PARADA-01': { passos: [F('a')] },
      }),
    )
    render(<TodoSidebar />)
    await waitFor(() =>
      expect(useCampaignStepsStore.getState().byProject).toEqual({
        [projectId()]: { OITO: 'OITO-03 1/3' },
      }),
    )

    fs.files.delete(REGISTRY)
    act(() => fs.onChange?.(REGISTRY))
    await waitFor(() => expect(useCampaignStepsStore.getState().byProject).toEqual({}))
  })

  it('takes the step titles back once the Todo panel is gone, so none goes stale', async () => {
    fs.files.set(REGISTRY, withTasks({ 'OITO-03': { passos: [T('a'), F('b')] } }))
    const { unmount } = render(<TodoSidebar />)
    await waitFor(() =>
      expect(useCampaignStepsStore.getState().byProject[projectId()]).toEqual({
        OITO: 'OITO-03 1/2',
      }),
    )
    unmount()
    expect(useCampaignStepsStore.getState().byProject).toEqual({})
  })
})

describe('Todo settings and edits', () => {
  beforeEach(() => useUiStore.setState({ toasts: [], notifications: [] }))
  afterEach(() => act(() => useUiStore.getState().closeModal()))

  it('names each settings field by its label', () => {
    useUiStore.setState({ openModal: TODO_SETTINGS_MODAL_ID })
    render(<TodoSettingsModal />)
    expect(screen.getByLabelText('Folder for your personal todos')).toHaveAttribute(
      'placeholder',
      'Default app data folder',
    )
    for (const label of ['Focus (minutes)', 'Short break (minutes)', 'Long break (minutes)']) {
      expect(screen.getByLabelText(label)).toHaveAttribute('type', 'number')
    }
    // A section caption, not the name of its button.
    expect(screen.getByRole('button', { name: 'Reset to Alethe default Todo' })).toBeInTheDocument()
  })

  it('says in a toast why a folder could not be used, and stays open', async () => {
    vi.mocked(ensureTodoTemplate).mockRejectedValueOnce('access denied')
    useUiStore.setState({ openModal: TODO_SETTINGS_MODAL_ID })
    render(<TodoSettingsModal />)
    fireEvent.change(screen.getByLabelText('Folder for your personal todos'), {
      target: { value: 'D:\\todos' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(lastToast()).toMatchObject({
        title: 'Todo List settings',
        body: 'Could not create the Todo template: access denied',
      }),
    )
    expect(useUiStore.getState().openModal).toBe(TODO_SETTINGS_MODAL_ID)
  })

  it('names the field that renames a personal todo', () => {
    useTodosStore.setState({ tab: 'personal' })
    useTodosStore.getState().createTodo('Write the doc')
    render(<TodoSidebar />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit task' }))
    expect(screen.getByRole('textbox', { name: 'Edit task' })).toHaveValue('Write the doc')
  })
})

describe('Agent messages', () => {
  const projectId = () => useProjectsStore.getState().projects[0].id
  const active = (id: string) => screen.queryByRole('group', { name: id })
  const tail = vi.mocked(sessionRead)
  const setStatus = (status: 'working' | 'waiting' | 'stopped') =>
    act(() => useTerminalsStore.getState().setStatus('pty-OITO', status))
  /** A Claude tab opened for `campaignId`, on `sessionId` when given, its agent waiting. */
  function agentTab(campaignId: string, sessionId?: string) {
    const terminal = openTerminal('C:\\repo', 'claude', campaignId)
    const tab = terminal.tabs[0]
    const store = useProjectsStore.getState()
    store.setSubTabPtyId(projectId(), terminal.id, tab.id, `pty-${campaignId}`)
    if (sessionId) store.setSubTabSessionId(projectId(), terminal.id, tab.id, sessionId)
    useTerminalsStore.getState().registerPty(`pty-${campaignId}`)
    useTerminalsStore.getState().setStatus(`pty-${campaignId}`, 'waiting')
    return terminal
  }
  /** A read of session s-1 at `revision`, with these [role, text, asks a question] events. */
  const reply = (revision: number, ...events: Array<[string, string, boolean?]>) => ({
    sessionId: 's-1',
    revision,
    unchanged: false,
    events: events.map(([role, text, asks]) => ({
      role: role as 'user',
      text,
      ...(asks ? { questionSetId: 'q-1', questions: [{ id: 'scope' }] } : {}),
    })),
    title: null,
  })
  const unchanged = (revision: number) => ({
    sessionId: 's-1',
    revision,
    unchanged: true,
    events: [],
    title: null,
  })

  beforeEach(() => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    useUiStore.setState({ toasts: [], notifications: [] })
    useTerminalsStore.getState().reset()
    useSessionStore.setState({ sessions: {} })
  })
  afterEach(() => useTerminalsStore.getState().reset())

  it('shows the last answer of a campaign agent by its controls, in full in its tooltip', async () => {
    tail.mockResolvedValueOnce(
      reply(
        5,
        ['user', 'Mede a tabela A'],
        ['assistant', 'Medi a tabela A; falta o Gate 1.'],
        ['tool', 'Bash: ls'],
      ),
    )
    agentTab('OITO', 's-1')
    render(<TodoSidebar />)
    await waitFor(() => expect(active('OITO')).not.toBeNull())
    const line = await within(active('OITO')!).findByText('Agent: Medi a tabela A; falta o Gate 1.')
    expect(line).toHaveAttribute('title', 'Medi a tabela A; falta o Gate 1.')
    expect(tail).toHaveBeenCalledWith({ provider: 'claude', cwd: 'C:\\repo', sessionId: 's-1' })
  })

  it('reads nothing for a tab without a session, and shows no line', async () => {
    agentTab('OITO')
    render(<TodoSidebar />)
    await waitFor(() => expect(active('OITO')).not.toBeNull())
    await act(async () => {})
    expect(tail).not.toHaveBeenCalled()
    expect(sessionSubscribe).not.toHaveBeenCalled()
    expect(within(active('OITO')!).queryByText(/^Agent:/)).toBeNull()
  })

  it('lists a question the agent waits on in Pending, until a later message answers it', async () => {
    tail.mockResolvedValueOnce(
      reply(5, ['assistant', 'Preciso do escopo.'], ['question', 'Scope: Which scope?', true]),
    )
    const terminal = agentTab('OITO', 's-1')
    render(<TodoSidebar />)
    const question = await screen.findByText('Scope: Which scope?')
    expect(question).toHaveAttribute('title', 'Scope: Which scope?')
    const row = question.closest('li')!
    expect(within(row).getByText('OITO')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Pending/ }).closest('section')).toContainElement(
      row,
    )
    // Answering stays in the terminal: the row only goes there.
    act(() => useUiStore.setState({ activeTerminal: null }))
    fireEvent.click(within(row).getByRole('button', { name: 'Go to tab' }))
    expect(useUiStore.getState().activeTerminal?.terminalId).toBe(terminal.id)
    expect(writePty).not.toHaveBeenCalled()

    // Answered: once its agent has worked and stopped again, the row goes.
    tail.mockResolvedValueOnce(
      reply(
        9,
        ['question', 'Scope: Which scope?', true],
        ['user', 'Focused'],
        ['assistant', 'Feito.'],
      ),
    )
    setStatus('working')
    setStatus('waiting')
    await waitFor(() => expect(screen.queryByText('Scope: Which scope?')).toBeNull())
    expect(screen.queryByRole('button', { name: /^Pending/ })).toBeNull()
  })

  it('reads again once its agent stops working, passing the revision it last read', async () => {
    tail.mockResolvedValueOnce(reply(5, ['assistant', 'Primeira.']))
    agentTab('OITO', 's-1')
    render(<TodoSidebar />)
    await screen.findByText('Agent: Primeira.')
    expect(tail).toHaveBeenCalledTimes(1)

    setStatus('working')
    setStatus('working')
    expect(tail).toHaveBeenCalledTimes(1)
    tail.mockResolvedValueOnce(unchanged(5))
    setStatus('waiting')
    await waitFor(() => expect(tail).toHaveBeenCalledTimes(2))
    expect(tail).toHaveBeenLastCalledWith({
      provider: 'claude',
      cwd: 'C:\\repo',
      sessionId: 's-1',
      since: 5,
    })
    // Unchanged, its line stays; waiting to stopped is no new stop.
    expect(screen.getByText('Agent: Primeira.')).toBeInTheDocument()
    setStatus('stopped')
    await act(async () => {})
    expect(tail).toHaveBeenCalledTimes(2)
  })

  it('keeps the newer of two overlapping reads, and reads on from its revision', async () => {
    // The first read is still on its way when the agent stops and a second one starts.
    let first: (value: Awaited<ReturnType<typeof sessionRead>>) => void = () => {}
    tail.mockImplementationOnce(() => new Promise((resolve) => (first = resolve)))
    tail.mockResolvedValueOnce(
      reply(
        9,
        ['question', 'Scope: Which scope?', true],
        ['user', 'Focused'],
        ['assistant', 'Feito.'],
      ),
    )
    agentTab('OITO', 's-1')
    render(<TodoSidebar />)
    await waitFor(() => expect(tail).toHaveBeenCalledTimes(1))
    setStatus('working')
    setStatus('waiting')
    await screen.findByText('Agent: Feito.')

    // The older answer lands last: it is dropped, its question with it.
    await act(async () =>
      first(
        reply(5, ['assistant', 'Preciso do escopo.'], ['question', 'Scope: Which scope?', true]),
      ),
    )
    expect(screen.getByText('Agent: Feito.')).toBeInTheDocument()
    expect(screen.queryByText('Scope: Which scope?')).toBeNull()
    tail.mockResolvedValueOnce(unchanged(9))
    setStatus('working')
    setStatus('waiting')
    await waitFor(() => expect(tail).toHaveBeenCalledTimes(3))
    expect(tail).toHaveBeenLastCalledWith(expect.objectContaining({ since: 9 }))
  })

  it('shares what a session said between its tabs, also once a tab gets a new pty', async () => {
    tail.mockResolvedValueOnce(reply(5, ['assistant', 'Primeira.']))
    const first = agentTab('OITO', 's-1')
    render(<TodoSidebar />)
    await screen.findByText('Agent: Primeira.')

    // Its pty replaced, the session is the same one: it is not read again, and the line stays.
    act(() =>
      useProjectsStore
        .getState()
        .setSubTabPtyId(projectId(), first.id, first.tabs[0].id, 'pty-new'),
    )
    await act(async () => {})
    expect(tail).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Agent: Primeira.')).toBeInTheDocument()

    // Another tab on the same session, focused, shows it too, from the same read.
    const second = openTerminal('C:\\repo', 'claude', 'OITO')
    const store = useProjectsStore.getState()
    store.setSubTabPtyId(projectId(), second.id, second.tabs[0].id, 'pty-second')
    store.setSubTabSessionId(projectId(), second.id, second.tabs[0].id, 's-1')
    focusTerminal(second.id)
    await act(async () => {})
    expect(tail).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Agent: Primeira.')).toBeInTheDocument()
  })

  it('follows its session as the transcript changes, while its agent still works', async () => {
    tail.mockResolvedValueOnce(reply(5, ['assistant', 'Primeira.']))
    agentTab('OITO', 's-1')
    setStatus('working')
    render(<TodoSidebar />)
    await screen.findByText('Agent: Primeira.')

    tail.mockResolvedValueOnce(reply(8, ['assistant', 'Segunda.']))
    act(() =>
      sessionEvents.emit({ provider: 'claude', cwd: 'c:\\repo', sessionId: 's-1', revision: 8 }),
    )
    await screen.findByText('Agent: Segunda.')
    expect(tail).toHaveBeenLastCalledWith({
      provider: 'claude',
      cwd: 'C:\\repo',
      sessionId: 's-1',
      since: 5,
    })
  })
})

describe('Registry read failures', () => {
  const alert = () => screen.queryByRole('alert')
  const campaigns = () => screen.queryByRole('button', { name: /^Campaigns/ })

  it('says a project has no registry only when its file is missing', async () => {
    render(<TodoSidebar />)
    expect(await screen.findByText(/no campaign registry/)).toBeInTheDocument()
    expect(alert()).toBeNull()
    expect(recordFrontendError).not.toHaveBeenCalled()
  })

  it('names why git could not list the checkouts, logs it once, and Try again reads again', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    const failure = 'git_command_failed:fatal: not a git repository'
    vi.mocked(worktreeCheckouts).mockRejectedValueOnce(failure).mockRejectedValueOnce(failure)
    render(<TodoSidebar />)
    await waitFor(() =>
      expect(alert()).toHaveTextContent(`Could not read the campaign registry: ${failure}`),
    )
    expect(screen.queryByText(/no campaign registry/)).toBeNull()

    // The same failure again is not logged twice.
    fireEvent.click(within(alert()!).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(worktreeCheckouts).toHaveBeenCalledTimes(2))
    await act(async () => {})
    expect(recordFrontendError).toHaveBeenCalledTimes(1)
    expect(recordFrontendError).toHaveBeenCalledWith(
      expect.stringContaining(failure),
      null,
      'todo-registry',
    )

    fireEvent.click(within(alert()!).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(campaigns()).not.toBeNull())
    expect(alert()).toBeNull()
  })

  it('reads again on focus after a read that failed once its file was watched', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    vi.mocked(readTextFile).mockRejectedValueOnce('Access is denied. (os error 5)')
    render(<TodoSidebar />)
    await waitFor(() =>
      expect(alert()).toHaveTextContent(
        'Could not read the campaign registry: Access is denied. (os error 5)',
      ),
    )
    expect(watchFile).toHaveBeenCalledWith(REGISTRY)

    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(campaigns()).not.toBeNull())
    expect(alert()).toBeNull()
  })

  it('reports a repository without a main checkout, rather than no registry', async () => {
    vi.mocked(worktreeCheckouts).mockResolvedValueOnce({ main: null, worktrees: [] })
    render(<TodoSidebar />)
    await waitFor(() =>
      expect(alert()).toHaveTextContent(
        'Could not read the campaign registry: the repository has no main checkout',
      ),
    )
    expect(screen.queryByText(/no campaign registry/)).toBeNull()
  })

  it('reports a registry path that holds no file, rather than no registry', async () => {
    vi.mocked(readTextFile).mockRejectedValueOnce('not a file')
    render(<TodoSidebar />)
    await waitFor(() =>
      expect(alert()).toHaveTextContent('Could not read the campaign registry: not a file'),
    )
    expect(screen.queryByText(/no campaign registry/)).toBeNull()
  })

  it('logs a failure once until its registry reads fine, remembering the last 50 only', () => {
    logRegistryProblem('C:\\a', 'read: denied')
    logRegistryProblem('C:\\a', 'read: denied')
    expect(recordFrontendError).toHaveBeenCalledTimes(1)
    // Read fine, the project's failures are forgotten: the same one is logged again.
    logRegistryProblem('C:\\a', null)
    logRegistryProblem('C:\\a', 'read: denied')
    expect(recordFrontendError).toHaveBeenCalledTimes(2)

    vi.mocked(recordFrontendError).mockClear()
    for (let index = 0; index < 51; index += 1) logRegistryProblem(`C:\\p${index}`, 'read: x')
    expect(recordFrontendError).toHaveBeenCalledTimes(51)
    // The oldest went to make room: logged again; the newest is still remembered.
    logRegistryProblem('C:\\p0', 'read: x')
    logRegistryProblem('C:\\p50', 'read: x')
    expect(recordFrontendError).toHaveBeenCalledTimes(52)
  })

  it('reports a file that is not a registry, rather than no registry', async () => {
    fs.files.set(REGISTRY, '{"campanhas": ')
    render(<TodoSidebar />)
    await waitFor(() =>
      expect(alert()).toHaveTextContent(/^Could not read the campaign registry: .+/),
    )
    expect(screen.queryByText(/no campaign registry/)).toBeNull()

    cleanup()
    fs.files.set(REGISTRY, '{"versao": 1}')
    render(<TodoSidebar />)
    await waitFor(() =>
      expect(alert()).toHaveTextContent(
        'Could not read the campaign registry: it is not a campaign registry',
      ),
    )
  })
})

describe('Personal list', () => {
  const projectId = () => useProjectsStore.getState().projects[0].id
  /** The personal todos' titles in the order shown. */
  const titles = () =>
    [...document.querySelectorAll('[class*="todoTitleText"]')].map((item) => item.textContent)
  /** A shown todo's row. */
  const row = (title: string) => screen.getByTitle(title).closest('[draggable]') as HTMLElement

  beforeEach(() => useTodosStore.setState({ tab: 'personal' }))

  it('shows one list, open todos first with their project, the done ones collapsed at its end', () => {
    const store = useTodosStore.getState()
    store.createTodo('Loose one')
    store.createTodo('Write the doc', [], projectId())
    const done = store.createTodo('Finished one', [], projectId())!
    useTodosStore.getState().toggleTodo(done.id)
    render(<TodoSidebar />)

    // No filters, no section per project.
    expect(screen.queryByRole('tablist', { name: 'Task filters' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^No project/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^App \d/ })).toBeNull()
    expect(titles()).toEqual(['Loose one', 'Write the doc'])
    const chip = (title: string) =>
      within(row(title)).getByRole('button', { name: 'Link task to a project' })
    expect(chip('Write the doc')).toHaveTextContent('App')
    expect(chip('Loose one')).toHaveTextContent('No project')

    const doneGroup = screen.getByRole('button', { name: '1 done' })
    expect(doneGroup).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(doneGroup)
    expect(titles()).toEqual(['Loose one', 'Write the doc', 'Finished one'])
    expect(screen.getByRole('progressbar')).toHaveTextContent('1 / 3')
  })

  it('reorders open todos by dragging one onto another in the list', () => {
    const store = useTodosStore.getState()
    store.createTodo('First', [], projectId())
    store.createTodo('Second')
    store.createTodo('Third', [], projectId())
    render(<TodoSidebar />)
    expect(titles()).toEqual(['First', 'Second', 'Third'])

    const dataTransfer = { setData: () => {}, effectAllowed: '', dropEffect: '' }
    fireEvent.dragStart(row('Third'), { dataTransfer })
    fireEvent.dragOver(row('First'), { dataTransfer })
    fireEvent.drop(row('First'), { dataTransfer })
    expect(titles()).toEqual(['Third', 'First', 'Second'])
    expect(useTodosStore.getState().todos.map((todo) => todo.title)).toEqual([
      'Third',
      'First',
      'Second',
    ])
  })
})
