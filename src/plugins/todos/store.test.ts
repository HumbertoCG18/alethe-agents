import { beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_NIGHT_SETTINGS } from '../../lib/nightScheduler'
import type { PluginStorage } from '../../lib/plugins'
import type { TodoItem } from '../../lib/types'
import { hydrateTodos, orderedSections, resetTodosStoreForTests, useTodosStore } from './store'

function fakeStorage(initial: Record<string, unknown> = {}) {
  let record = { ...initial }
  const storage: PluginStorage = {
    read: async () => ({ ...record }),
    get: async (key, fallback) => (record[key] === undefined ? fallback : (record[key] as never)),
    set: async (key, value) => {
      record = { ...record, [key]: value }
    },
    remove: async (key) => {
      const { [key]: _dropped, ...rest } = record
      record = rest
    },
    clear: async () => {
      record = {}
    },
  }
  return { storage, snapshot: () => record }
}

const legacyItem: TodoItem = { id: 'a', title: 'From projects.json', completed: false, tags: [] }

beforeEach(() => resetTodosStoreForTests())

describe('hydrateTodos', () => {
  it('adopts the pre-plugin list when the plugin has stored nothing', async () => {
    const { storage, snapshot } = fakeStorage()

    await hydrateTodos(storage, { todos: [legacyItem], storagePath: 'C:/notes' })

    expect(useTodosStore.getState().todos).toEqual([legacyItem])
    expect(useTodosStore.getState().storagePath).toBe('C:/notes')
    // Copied into the plugin's own record, so the core copy is only a backup.
    expect(snapshot().todos).toEqual([legacyItem])
    expect(snapshot().storagePath).toBe('C:/notes')
  })

  it('never lets the legacy copy overwrite what the plugin already owns', async () => {
    const owned: TodoItem = { id: 'b', title: 'Mine', completed: false, tags: [] }
    const { storage } = fakeStorage({ todos: [owned], storagePath: '' })

    await hydrateTodos(storage, { todos: [legacyItem], storagePath: 'C:/notes' })

    expect(useTodosStore.getState().todos).toEqual([owned])
    // An empty stored path is a choice the user made, not a missing value.
    expect(useTodosStore.getState().storagePath).toBe('')
  })

  it('opens on Overview by default and remembers the last tab, reading anything else as Overview', async () => {
    await hydrateTodos(fakeStorage({ tab: 'list' }).storage, { todos: [], storagePath: '' })
    expect(useTodosStore.getState().tab).toBe('tasks')

    const { storage, snapshot } = fakeStorage()
    await hydrateTodos(storage, { todos: [], storagePath: '' })
    useTodosStore.getState().setTab('night')
    await Promise.resolve()
    expect(snapshot().tab).toBe('night')

    resetTodosStoreForTests()
    await hydrateTodos(storage, { todos: [], storagePath: '' })
    expect(useTodosStore.getState().tab).toBe('night')
  })

  it('keeps Modo noite per project and the night run across a restart', async () => {
    const { storage, snapshot } = fakeStorage({ nightSettings: { broken: 1 } })
    await hydrateTodos(storage, { todos: [], storagePath: '' })
    // Off by default: a project without settings, or with unreadable ones, has none.
    expect(useTodosStore.getState().nightSettings).toEqual({})

    const settings = { ...DEFAULT_NIGHT_SETTINGS, enabled: true, start: '22:00' }
    useTodosStore.getState().setNightSettings('p1', settings)
    const current = {
      projectId: 'p1',
      campaignId: 'C',
      taskId: 'C-01',
      terminalId: null,
      tabId: null,
      startedAt: 1,
      deadline: 2,
    }
    const nights = {
      p1: { night: '2026-10-03', started: 1, failures: 0, stopped: null, attempted: ['C-01'] },
    }
    void useTodosStore.getState().setNightRun({ current, nights })
    await Promise.resolve()
    expect(snapshot().nightSettings).toEqual({ p1: settings })

    resetTodosStoreForTests()
    const stored = { ...snapshot(), nightSettings: { p1: { enabled: true } } }
    await hydrateTodos(fakeStorage(stored).storage, { todos: [], storagePath: '' })
    // A stored entry reads over the defaults.
    expect(useTodosStore.getState().nightSettings.p1).toEqual({
      ...DEFAULT_NIGHT_SETTINGS,
      enabled: true,
    })
    expect(useTodosStore.getState().nightRun).toEqual({ current, nights })
  })

  it('reconsiders an ended night when its settings change', async () => {
    await hydrateTodos(fakeStorage().storage, { todos: [], storagePath: '' })
    const night = {
      night: '2026-10-03',
      started: 2,
      failures: 0,
      stopped: 'max' as const,
      attempted: [],
    }
    void useTodosStore.getState().setNightRun({ current: null, nights: { p1: night } })
    useTodosStore.getState().setNightSettings('p1', { ...DEFAULT_NIGHT_SETTINGS, maxTasks: 6 })
    expect(useTodosStore.getState().nightRun.nights.p1).toEqual({ ...night, stopped: null })
  })

  it('treats an emptied list as owned, not as an absent record', async () => {
    const { storage } = fakeStorage({ todos: [] })

    await hydrateTodos(storage, { todos: [legacyItem], storagePath: '' })

    expect(useTodosStore.getState().todos).toEqual([])
  })

  it('keeps each project’s section order, reading older or broken data as none', async () => {
    await hydrateTodos(fakeStorage().storage, { todos: [], storagePath: '' })
    expect(useTodosStore.getState().sectionOrder).toEqual({})

    resetTodosStoreForTests()
    const { storage, snapshot } = fakeStorage({
      sectionOrder: { p1: ['campaigns', 7, 'pending'], p2: 'pending', p3: null },
    })
    await hydrateTodos(storage, { todos: [], storagePath: '' })
    expect(useTodosStore.getState().sectionOrder).toEqual({ p1: ['campaigns', 'pending'] })

    useTodosStore.getState().setSectionOrder('p4', ['findings', 'list'])
    await Promise.resolve()
    expect(snapshot().sectionOrder).toEqual({
      p1: ['campaigns', 'pending'],
      p4: ['findings', 'list'],
    })
    useTodosStore.getState().setSectionOrder('p1', null)
    await Promise.resolve()
    expect(snapshot().sectionOrder).toEqual({ p4: ['findings', 'list'] })
  })
})

describe('orderedSections', () => {
  it('shows the saved sections first in their order, and any other at its default place', () => {
    expect(orderedSections(undefined)).toEqual([
      'pending',
      'active',
      'findings',
      'campaigns',
      'completed',
    ])
    expect(orderedSections(['completed', 'campaigns', 'findings', 'active', 'pending'])).toEqual([
      'completed',
      'campaigns',
      'findings',
      'active',
      'pending',
    ])
    // Unknown and repeated ids are dropped; a section missing from it takes its default index.
    expect(orderedSections(['campaigns', 'gone', 'pending', 'campaigns'])).toEqual([
      'campaigns',
      'active',
      'findings',
      'pending',
      'completed',
    ])
  })

  it('reads an order saved before the tabs: the list is Active, the night card is gone', () => {
    expect(orderedSections(['night', 'findings', 'campaigns', 'list', 'pending'])).toEqual([
      'findings',
      'campaigns',
      'active',
      'pending',
      'completed',
    ])
  })
})

describe('todo actions', () => {
  beforeEach(async () => {
    await hydrateTodos(fakeStorage().storage, { todos: [], storagePath: '' })
  })

  it('adds, renames, toggles and deletes', () => {
    const store = useTodosStore.getState()
    const created = store.createTodo('  Write the doc  ', ['docs'])
    expect(created?.title).toBe('Write the doc')

    useTodosStore.getState().renameTodo(created!.id, 'Rewrite the doc')
    expect(useTodosStore.getState().todos[0].title).toBe('Rewrite the doc')

    useTodosStore.getState().toggleTodo(created!.id)
    expect(useTodosStore.getState().todos[0].completed).toBe(true)

    useTodosStore.getState().deleteTodo(created!.id)
    expect(useTodosStore.getState().todos).toEqual([])
  })

  it('refuses an empty title instead of storing a blank row', () => {
    expect(useTodosStore.getState().createTodo('   ')).toBeNull()
    expect(useTodosStore.getState().todos).toEqual([])
  })

  it('clears the project when one is unset', () => {
    const created = useTodosStore.getState().createTodo('Task', [], 'p1')
    expect(created?.projectId).toBe('p1')

    useTodosStore.getState().setTodoProject(created!.id, null)
    expect(useTodosStore.getState().todos[0].projectId).toBeUndefined()
  })

  it('persists every change into the plugin record', async () => {
    const { storage, snapshot } = fakeStorage()
    await hydrateTodos(storage, { todos: [], storagePath: '' })

    useTodosStore.getState().createTodo('Persisted')
    await Promise.resolve()

    expect((snapshot().todos as TodoItem[])[0].title).toBe('Persisted')
  })
})

it('restores the last campaign per project after a storage round trip', async () => {
  const { storage, snapshot } = fakeStorage()
  await hydrateTodos(storage, { todos: [], storagePath: '' })
  useTodosStore.getState().rememberCampaign('project-a', 'A')
  useTodosStore.getState().rememberCampaign('project-b', 'B')
  expect(snapshot().activeCampaigns).toEqual({ 'project-a': 'A', 'project-b': 'B' })
  resetTodosStoreForTests()
  await hydrateTodos(storage, { todos: [], storagePath: '' })
  expect(useTodosStore.getState().activeCampaigns).toEqual({ 'project-a': 'A', 'project-b': 'B' })
})
