import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { listenFileChanged, readTextFile, unwatchFile, watchFile } from '../lib/tauri'
import { useMarkdownFile } from './useMarkdownFile'

vi.mock('../lib/tauri', () => ({
  readTextFile: vi.fn(),
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
