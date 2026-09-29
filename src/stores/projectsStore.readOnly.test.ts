import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { saveProjectsFile } from '../lib/tauri'
import { EMPTY_PROJECTS_FILE } from '../lib/types'
import { setProjectsReadOnly, useProjectsStore } from './projectsStore'

vi.mock('../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/tauri')>()),
  saveProjectsFile: vi.fn(async () => undefined),
}))
vi.mock('../lib/terminalLifecycle', () => ({ cleanupPtys: vi.fn() }))

beforeEach(() => {
  vi.useFakeTimers()
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
  vi.mocked(saveProjectsFile).mockClear()
})

afterEach(() => {
  setProjectsReadOnly(false)
  vi.useRealTimers()
})

// A detached board window reads projects.json but must never write it: the main window owns it
// and two writers would overwrite each other (#247).
describe('read-only projects', () => {
  it('saves changes in the main window', async () => {
    useProjectsStore.getState().createProject({ name: 'App' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(saveProjectsFile).toHaveBeenCalled()
  })

  it('never saves from a window that only reads', async () => {
    setProjectsReadOnly(true)
    useProjectsStore.getState().createProject({ name: 'App' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(saveProjectsFile).not.toHaveBeenCalled()
  })
})
