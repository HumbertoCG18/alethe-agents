import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import {
  listenFileChanged,
  readRepositoryTextFile,
  readTextFile,
  unwatchFile,
  watchFile,
} from '../lib/tauri'
import { useMarkdownFile } from './useMarkdownFile'

vi.mock('../lib/tauri', () => ({
  readTextFile: vi.fn(),
  readRepositoryTextFile: vi.fn(),
  watchFile: vi.fn(async () => {}),
  unwatchFile: vi.fn(async () => {}),
  listenFileChanged: vi.fn(async () => () => {}),
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('ignores late errors, reloads night reports on file changes and releases delayed watchers', async () => {
  let failOld!: (error: Error) => void
  let finishWatch!: () => void
  vi.mocked(watchFile).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishWatch = resolve
      }),
  )
  vi.mocked(readTextFile).mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        failOld = reject
      }),
  )
  const view = renderHook(({ path }) => useMarkdownFile(path), {
    initialProps: { path: 'C:/old.md' },
  })
  const oldReload = view.result.current.reload
  vi.mocked(readTextFile).mockResolvedValue('Night report')
  view.rerender({ path: 'C:/night.md' })
  await waitFor(() => expect(view.result.current.content).toBe('Night report'))
  await act(async () => {
    failOld(new Error('old failure'))
    finishWatch()
  })
  expect(view.result.current.error).toBeNull()
  await act(async () => oldReload())
  expect(view.result.current.content).toBe('Night report')
  expect(unwatchFile).toHaveBeenCalledWith('C:/old.md')
  vi.mocked(readTextFile).mockResolvedValue('Updated night report')
  act(() => vi.mocked(listenFileChanged).mock.calls.at(-1)![0]('C:/night.md'))
  await waitFor(() => expect(view.result.current.content).toBe('Updated night report'))
  view.unmount()
  await waitFor(() => expect(unwatchFile).toHaveBeenCalledWith('C:/night.md'))
})

it('reads a document named by repository text under its checkout, any other one as before', async () => {
  vi.mocked(readRepositoryTextFile).mockResolvedValue('Scoped')
  vi.mocked(readTextFile).mockResolvedValue('Unscoped')
  const scoped = renderHook(() => useMarkdownFile('C:/repo/docs/x.md', 'C:/repo'))
  await waitFor(() => expect(scoped.result.current.content).toBe('Scoped'))
  expect(readRepositoryTextFile).toHaveBeenCalledWith('C:/repo', 'C:/repo/docs/x.md')
  expect(readTextFile).not.toHaveBeenCalled()
  const plain = renderHook(() => useMarkdownFile('C:/picked.md'))
  await waitFor(() => expect(plain.result.current.content).toBe('Unscoped'))
  expect(readTextFile).toHaveBeenCalledWith('C:/picked.md')
})

it('never shows content read under another scope while the new read is pending', async () => {
  vi.mocked(readTextFile).mockResolvedValue('Unscoped')
  vi.mocked(readRepositoryTextFile).mockImplementation(() => new Promise(() => {}))
  const view = renderHook(({ scope }) => useMarkdownFile('C:/repo/x.md', scope), {
    initialProps: { scope: null as string | null },
  })
  await waitFor(() => expect(view.result.current.content).toBe('Unscoped'))
  view.rerender({ scope: 'C:/repo' })
  expect(view.result.current.content).toBeNull()
  expect(view.result.current.error).toBeNull()
  await waitFor(() =>
    expect(readRepositoryTextFile).toHaveBeenCalledWith('C:/repo', 'C:/repo/x.md'),
  )
  expect(view.result.current.content).toBeNull()
})
