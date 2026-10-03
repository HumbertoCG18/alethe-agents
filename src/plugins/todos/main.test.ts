import { describe, expect, it, vi } from 'vitest'

import type { PluginContext } from '../../lib/plugins'
import { activationEvents } from '../../lib/plugins'
import { EMPTY_PROJECTS_FILE } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'

const stop = vi.hoisted(() => vi.fn())
vi.mock('./nightRunner', () => ({ startNightRunner: vi.fn(() => ({ tick: vi.fn(), stop })) }))

import plugin from './main'
import { TODOS_MANIFEST } from './manifest'
import { startNightRunner } from './nightRunner'

describe('Todo plugin', () => {
  it('activates at startup and starts the night scheduler once projects are loaded', async () => {
    expect(activationEvents(TODOS_MANIFEST)).toContain('onStartupFinished')
    useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: false })
    const context = {
      storage: { read: async () => ({}), set: async () => {} },
      registerView: vi.fn(),
      registerCommand: vi.fn(),
      contributes: { modal: vi.fn() },
      subscriptions: [],
    } as unknown as PluginContext

    const activation = plugin.activate!(context)
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Before projects.json is loaded, the legacy list and the projects are not there yet.
    expect(startNightRunner).not.toHaveBeenCalled()

    useProjectsStore.setState({ hydrated: true })
    await activation
    expect(startNightRunner).toHaveBeenCalledTimes(1)
    for (const subscription of context.subscriptions) subscription.dispose()
    expect(stop).toHaveBeenCalledTimes(1)
  })
})
