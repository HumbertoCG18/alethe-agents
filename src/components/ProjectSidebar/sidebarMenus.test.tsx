import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Group, Project, Terminal } from '../../lib/types'
import type { MenuItem } from './ContextMenu'
import { createSidebarMenus, type SidebarMenuDeps } from './sidebarMenus'

const askConfirm = vi.hoisted(() => vi.fn<(message: string) => Promise<boolean>>())

vi.mock('../../lib/dialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/dialog')>()),
  askConfirm,
}))

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  askConfirm.mockReset()
  // What tauri-plugin-dialog injects: an async confirm whose Promise is always truthy.
  vi.stubGlobal(
    'confirm',
    vi.fn(async () => false),
  )
})
afterEach(() => vi.unstubAllGlobals())

function setup(overrides: Partial<SidebarMenuDeps> = {}) {
  const actions = {
    deleteTerminalWithWorktreeCleanup: vi.fn(async () => {}),
    deleteProject: vi.fn(),
    deleteGroup: vi.fn(),
    createOrchestratorPane: vi.fn(),
  }
  const deps = {
    t: ((key: string) => key) as SidebarMenuDeps['t'],
    graphifyEnabled: false,
    orchestratorEnabled: false,
    browserEnabled: false,
    groups: [],
    openPaneSets: {},
    actions: actions as unknown as SidebarMenuDeps['actions'],
    openModal: vi.fn(),
    setActiveView: vi.fn(),
    setActiveTerminal: vi.fn(),
    setFocusedTerminal: vi.fn(),
    requestPaneFocus: vi.fn(),
    openMarkdownSidebar: vi.fn(),
    ...overrides,
  } satisfies SidebarMenuDeps
  return { menus: createSidebarMenus(deps), actions }
}

function click(items: MenuItem[], label: string) {
  const item = items.find((entry) => entry.kind === 'item' && entry.label === label)
  if (!item || item.kind !== 'item') throw new Error(`missing menu item ${label}`)
  item.onClick()
}

const terminal = {
  id: 'term-1',
  name: 'Shell',
  kind: 'terminal',
  activeTabId: 'tab-1',
  tabs: [{ id: 'tab-1', type: 'shell', name: 'Shell' }],
} as unknown as Terminal
const project = { id: 'proj-1', name: 'App', terminals: [terminal] } as unknown as Project
const group = { id: 'group-1', name: 'Team', projectIds: ['proj-1'] } as unknown as Group

describe('project menu', () => {
  it('opens the orchestrator in the checkout the project picked, not its first folder', () => {
    const { menus, actions } = setup({ orchestratorEnabled: true })
    const onWorktree = { ...project, defaultCwd: 'C:\repo-night', checkoutPath: 'C:\repo' }

    click(menus.projectMenu(onWorktree), 'menu.addOrchestrator')

    expect(actions.createOrchestratorPane).toHaveBeenCalledWith('proj-1', 'C:\repo')
  })
})

describe('sidebar menu confirmations', () => {
  it.each([
    {
      name: 'delete terminal',
      open: (menus: ReturnType<typeof createSidebarMenus>) =>
        click(menus.terminalMenu('proj-1', terminal), 'ui.sidebar.deleteTerminal'),
      action: 'deleteTerminalWithWorktreeCleanup' as const,
      args: ['proj-1', 'term-1'],
    },
    {
      name: 'delete project',
      open: (menus: ReturnType<typeof createSidebarMenus>) =>
        click(menus.projectMenu(project), 'ui.sidebar.deleteProject'),
      action: 'deleteProject' as const,
      args: ['proj-1'],
    },
    {
      name: 'delete group and projects',
      open: (menus: ReturnType<typeof createSidebarMenus>) =>
        click(menus.groupMenu(group), 'ui.sidebar.deleteGroupAndProjects'),
      action: 'deleteGroup' as const,
      args: ['group-1', 'cascade'],
    },
  ])('$name: cancel does nothing, confirm proceeds', async ({ open, action, args }) => {
    const cancelled = setup()
    askConfirm.mockResolvedValue(false)
    open(cancelled.menus)
    await flush()
    expect(cancelled.actions[action]).not.toHaveBeenCalled()

    const confirmed = setup()
    askConfirm.mockResolvedValue(true)
    open(confirmed.menus)
    await vi.waitFor(() => expect(confirmed.actions[action]).toHaveBeenCalledWith(...args))
  })
})
