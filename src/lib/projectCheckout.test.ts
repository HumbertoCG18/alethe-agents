import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getProjectDefaultCwd, useProjectsStore } from '../stores/projectsStore'
import {
  anchoredCwd,
  checkoutBusy,
  effectiveCheckout,
  ensureProjectAnchored,
  resolveProjectCheckout,
  useProjectCheckoutAnchors,
} from './projectCheckout'
import { type GitCheckouts, type OrchestratorJob, worktreeCheckouts } from './tauri'
import { EMPTY_PROJECTS_FILE, type Project } from './types'

const checkouts: GitCheckouts = {
  main: 'C:\\repo',
  worktrees: [
    { path: 'C:\\repo', branch: 'dev', lastCommitMs: null },
    { path: 'C:\\repo-night', branch: 'night', lastCommitMs: null, stale: true },
  ],
}

vi.mock('./tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tauri')>()),
  worktreeCheckouts: vi.fn(async (path: string) => {
    if (path.startsWith('C:\\repo')) return checkouts
    throw new Error('not_a_git_repository')
  }),
}))

beforeEach(() => {
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: false })
  vi.mocked(worktreeCheckouts).mockClear()
})

describe('effectiveCheckout', () => {
  it('reads the main checkout when the project folder is a linked worktree', () => {
    expect(effectiveCheckout({ defaultCwd: 'C:\\repo-night' }, checkouts)).toBe('C:\\repo')
    expect(effectiveCheckout({ defaultCwd: 'C:\\repo' }, checkouts)).toBe('C:\\repo')
  })

  it('follows the picked worktree, and main again once it is gone', () => {
    const picked = { defaultCwd: 'C:\\repo', checkoutPath: 'C:\\repo-night' }
    expect(effectiveCheckout(picked, checkouts)).toBe('C:\\repo-night')
    const removed = { ...picked, checkoutPath: 'C:\\repo-gone' }
    expect(effectiveCheckout(removed, checkouts)).toBe('C:\\repo')
  })

  it('keeps a subfolder or a folder outside git as it is', () => {
    expect(effectiveCheckout({ defaultCwd: 'C:\\repo\\app' }, checkouts)).toBe('C:\\repo\\app')
    expect(effectiveCheckout({ defaultCwd: 'C:\\notes' }, null)).toBe('C:\\notes')
  })
})

describe('resolveProjectCheckout', () => {
  it('anchors a project sitting on a linked worktree at the main checkout for new terminals', async () => {
    const project = useProjectsStore
      .getState()
      .createProject({ name: 'Tutor', defaultCwd: 'C:\\repo-night' })

    const { root } = await resolveProjectCheckout(project.id)

    const saved = useProjectsStore.getState().projects[0]
    expect(root).toBe('C:\\repo')
    expect(saved.checkoutPath).toBe('C:\\repo')
    expect(saved.defaultCwd).toBe('C:\\repo-night')
    expect(getProjectDefaultCwd(saved)).toBe('C:\\repo')
  })

  it('writes nothing for a project already on its main checkout or outside git', async () => {
    const store = useProjectsStore.getState()
    const onMain = store.createProject({ name: 'Repo', defaultCwd: 'C:\\repo' })
    const notes = store.createProject({ name: 'Notes', defaultCwd: 'C:\\notes' })

    expect((await resolveProjectCheckout(onMain.id)).root).toBe('C:\\repo')
    expect((await resolveProjectCheckout(notes.id)).root).toBe('C:\\notes')
    expect(useProjectsStore.getState().projects.map((p) => p.checkoutPath)).toEqual([
      undefined,
      undefined,
    ])
  })

  it('never lets a late answer overwrite a worktree picked while git was asked', async () => {
    let answer: (found: GitCheckouts) => void = () => {}
    vi.mocked(worktreeCheckouts).mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve)),
    )
    const store = useProjectsStore.getState()
    const project = store.createProject({ name: 'Tutor', defaultCwd: 'C:\\repo-night' })

    const resolving = resolveProjectCheckout(project.id)
    store.setProjectCheckout(project.id, 'C:\\repo-night')
    answer(checkouts)

    expect((await resolving).root).toBe('C:\\repo-night')
    expect(useProjectsStore.getState().projects[0].checkoutPath).toBe('C:\\repo-night')
  })
})

describe('useProjectCheckoutAnchors', () => {
  it('anchors every project at its main checkout once loaded, and the one made active later', async () => {
    const store = useProjectsStore.getState()
    const tutor = store.createProject({ name: 'Tutor', defaultCwd: 'C:\\repo-night' })
    const { rerender } = renderHook(({ hydrated }) => useProjectCheckoutAnchors(hydrated), {
      initialProps: { hydrated: false },
    })
    expect(vi.mocked(worktreeCheckouts)).not.toHaveBeenCalled()

    rerender({ hydrated: true })
    await waitFor(() =>
      expect(useProjectsStore.getState().projects[0].checkoutPath).toBe('C:\\repo'),
    )
    const terminal = useProjectsStore.getState().createTerminal(tutor.id, {
      name: 'Shell',
      cwd: '',
      firstTab: { type: 'shell', cwd: '' },
    })
    expect(terminal.cwd).toBe('C:\\repo')

    const later = useProjectsStore.getState().createProject({
      name: 'Later',
      defaultCwd: 'C:\\repo-night',
    })
    act(() => useProjectsStore.setState({ activeProjectId: later.id }))
    await waitFor(() =>
      expect(useProjectsStore.getState().projects[1].checkoutPath).toBe('C:\\repo'),
    )
  })
})

describe('useProjectCheckoutAnchors after a profile switch', () => {
  it('anchors the projects of a replaced list, the inactive ones too', async () => {
    const loaded = useProjectsStore
      .getState()
      .createProject({ name: 'Other profile', defaultCwd: 'C:\\repo-night' })
    useProjectsStore.setState({ projects: [], activeProjectId: null })
    renderHook(() => useProjectCheckoutAnchors(true))

    act(() => useProjectsStore.setState({ projects: [loaded], activeProjectId: null }))

    await waitFor(() =>
      expect(useProjectsStore.getState().projects[0].checkoutPath).toBe('C:\\repo'),
    )
  })
})

describe('ensureProjectAnchored', () => {
  it('asks git again after a failed attempt instead of keeping the failure', async () => {
    vi.mocked(worktreeCheckouts).mockRejectedValueOnce('git_busy')
    const project = useProjectsStore
      .getState()
      .createProject({ name: 'Tutor', defaultCwd: 'C:\\repo-night' })

    await ensureProjectAnchored(project.id)
    expect(useProjectsStore.getState().projects[0].checkoutPath).toBeUndefined()
    await ensureProjectAnchored(project.id)

    expect(worktreeCheckouts).toHaveBeenCalledTimes(2)
    expect(useProjectsStore.getState().projects[0].checkoutPath).toBe('C:\\repo')
  })
})

describe('useProjectCheckoutAnchors with the same projects', () => {
  it('anchors again when a project comes back with another folder, or another profile', async () => {
    const project = useProjectsStore
      .getState()
      .createProject({ name: 'Tutor', defaultCwd: 'C:\\repo-night' })
    renderHook(() => useProjectCheckoutAnchors(true))
    await waitFor(() =>
      expect(useProjectsStore.getState().projects[0].checkoutPath).toBe('C:\\repo'),
    )
    vi.mocked(worktreeCheckouts).mockClear()

    const moved = { ...project, defaultCwd: 'D:\\repo-night', checkoutPath: undefined }
    act(() => useProjectsStore.setState({ projects: [moved] }))
    await waitFor(() => expect(worktreeCheckouts).toHaveBeenCalledWith('D:\\repo-night', false))

    vi.mocked(worktreeCheckouts).mockClear()
    act(() => useProjectsStore.setState({ activeProfileId: 'work' }))
    await waitFor(() => expect(worktreeCheckouts).toHaveBeenCalledWith('D:\\repo-night', false))
  })
})

describe('anchoredCwd', () => {
  it('waits for a pending anchor, so the first terminal starts in main', async () => {
    let answer: () => void = () => {}
    vi.mocked(worktreeCheckouts).mockImplementationOnce(
      () => new Promise((resolve) => (answer = () => resolve(checkouts))),
    )
    const store = useProjectsStore.getState()
    const project = store.createProject({ name: 'Tutor', defaultCwd: 'C:\\repo-night' })

    let settled = false
    const pending = anchoredCwd(project.id).then((cwd) => {
      settled = true
      return cwd
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    answer()
    const cwd = await pending

    expect(cwd).toBe('C:\\repo')
    const terminal = store.createTerminal(project.id, {
      name: 'Shell',
      cwd,
      firstTab: { type: 'shell', cwd },
    })
    expect(terminal.cwd).toBe('C:\\repo')
  })

  it('keeps a folder the user typed, and follows the anchor for the one offered', async () => {
    const project = useProjectsStore
      .getState()
      .createProject({ name: 'Tutor', defaultCwd: 'C:\\repo-night' })
    const offered = 'C:\\repo-night'

    expect(await anchoredCwd(project.id, { typed: 'D:\\elsewhere', offered })).toBe('D:\\elsewhere')
    expect(await anchoredCwd(project.id, { typed: offered, offered })).toBe('C:\\repo')
  })

  it('stops waiting after its timeout and uses what is known', async () => {
    vi.mocked(worktreeCheckouts).mockImplementationOnce(() => new Promise(() => {}))
    const project = useProjectsStore
      .getState()
      .createProject({ name: 'Tutor', defaultCwd: 'C:\\repo-night' })

    expect(await anchoredCwd(project.id, { timeoutMs: 20 })).toBe('C:\\repo-night')
  })
})

describe('createTerminal and the project folder', () => {
  it('leaves defaultCwd alone when the project has a chosen checkout', () => {
    const store = useProjectsStore.getState()
    const project = store.createProject({ name: 'Tutor', defaultCwd: 'C:\\repo-night' })
    store.setProjectCheckout(project.id, 'C:\\repo-feature')

    const terminal = store.createTerminal(project.id, {
      name: 'Shell',
      cwd: '',
      firstTab: { type: 'shell', cwd: '' },
    })

    expect(terminal.cwd).toBe('C:\\repo-feature')
    expect(useProjectsStore.getState().projects[0].defaultCwd).toBe('C:\\repo-night')
  })

  it('still remembers the folder of a new terminal in a project without a chosen checkout', () => {
    const store = useProjectsStore.getState()
    const project = store.createProject({ name: 'Notes' })

    store.createTerminal(project.id, {
      name: 'Shell',
      cwd: 'D:\\notes',
      firstTab: { type: 'shell', cwd: 'D:\\notes' },
    })

    expect(useProjectsStore.getState().projects[0].defaultCwd).toBe('D:\\notes')
  })
})

describe('retireCheckout', () => {
  it('points what used the removed worktree at main and never rewrites defaultCwd', () => {
    const store = useProjectsStore.getState()
    const picked = store.createProject({ name: 'Picked', defaultCwd: 'C:\\repo' })
    store.setProjectCheckout(picked.id, 'C:\\repo-night')
    store.createProject({ name: 'Sitting', defaultCwd: 'C:\\repo-night' })
    const elsewhere = store.createProject({ name: 'Elsewhere', defaultCwd: 'C:\\repo-night' })
    store.setProjectCheckout(elsewhere.id, 'C:\\repo-feature')

    store.retireCheckout('C:\\repo-night', 'C:\\repo')

    expect(useProjectsStore.getState().projects.map((p) => [p.defaultCwd, p.checkoutPath])).toEqual(
      [
        ['C:\\repo', 'C:\\repo'],
        ['C:\\repo-night', 'C:\\repo'],
        ['C:\\repo-night', 'C:\\repo-feature'],
      ],
    )
  })
})

describe('checkoutBusy', () => {
  const project = (cwd: string) =>
    ({
      terminals: [{ cwd: 'C:\\repo', tabs: [{ cwd }] }],
    }) as unknown as Project
  const job = (status: OrchestratorJob['status'], cwd: string) =>
    ({ status, cwd }) as OrchestratorJob

  it('names a terminal tab or a live worker inside the worktree', () => {
    expect(checkoutBusy('C:\\repo-night', [project('C:\\repo-night\\src')], [])).toBe('terminal')
    expect(
      checkoutBusy('C:\\repo-night', [project('C:\\repo')], [job('blocked', 'C:\\repo-night')]),
    ).toBe('worker')
  })

  it('lets a worktree go when only finished workers or other folders touch it', () => {
    const done = [job('done', 'C:\\repo-night'), job('running', 'C:\\repo-nightly')]
    expect(checkoutBusy('C:\\repo-night', [project('C:\\repo')], done)).toBeNull()
  })
})
