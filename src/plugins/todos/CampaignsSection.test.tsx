import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import exemplo from '../../lib/__fixtures__/campanhas.exemplo.json'
import { EMPTY_PROJECTS_FILE } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'

const OTHER_REPO = vi.hoisted(() => 'C:\\other')

const fs = vi.hoisted(() => ({
  files: new Map<string, string>(),
  onChange: null as ((path: string) => void) | null,
  handoff: null as string | null,
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
  listenFileChanged: vi.fn(async (handler: (path: string) => void) => {
    fs.onChange = handler
    return () => {}
  }),
  findRelativePath: vi.fn(async () => fs.handoff),
  // The write command's contract: replace the file only while it is still the text read.
  campaignRegistryWrite: vi.fn(async (path: string, expected: string, content: string) => {
    if (fs.files.get(path) !== expected) throw 'conflict'
    fs.files.set(path, content)
  }),
}))

import { campaignRegistryWrite, findRelativePath, readTextFile, watchFile } from '../../lib/tauri'
import { CampaignsSection } from './CampaignsSection'
import { useCampaignView } from './campaignView'
import { TODO_SETTINGS_MODAL_ID } from './manifest'
import { resetTodosStoreForTests, useTodosStore } from './store'
import { TodoSettingsModal } from './TodoSettingsModal'
import { TodoSidebar } from './TodoSidebar'

const REGISTRY = 'C:\\repo\\.workflow\\campanhas.json'

/** The section as the Todo tab mounts it. */
function Section() {
  return <CampaignsSection view={useCampaignView()} onSelect={() => {}} />
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
    edited.campanhas[0].titulo = 'Renamed by the script'
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
    render(<Section />)
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

  it('opens a terminal for the remembered campaign when none is open, like Open', async () => {
    fs.files.set(REGISTRY, JSON.stringify(exemplo))
    const projectId = useProjectsStore.getState().projects[0].id
    useTodosStore.setState({ activeCampaigns: { [projectId]: 'PARADA' } })
    render(<Section />)
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
    render(<Section />)
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
    render(<Section />)
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
  const task = (id: string) =>
    (JSON.parse(fs.files.get(REGISTRY)!) as typeof exemplo).campanhas
      .flatMap((campaign) => campaign.tarefas)
      .find((item) => item.id === id)
  const original = (id: string) =>
    exemplo.campanhas.flatMap((campaign) => campaign.tarefas).find((item) => item.id === id)
  const lastToast = () => useUiStore.getState().toasts.at(-1)

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
        new Promise<void>((resolve) => {
          finish = () => {
            fs.files.set(path, content)
            resolve()
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
})
