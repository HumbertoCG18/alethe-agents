import { invoke } from '@tauri-apps/api/core'
import { expect, it, vi } from 'vitest'

import { generateMarkdown } from './markdown'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
it('cancels the exact backend request and rejects before IPC when already aborted', async () => {
  let finish!: (value: string) => void
  vi.mocked(invoke).mockImplementation((command) =>
    command === 'markdown_generate'
      ? new Promise((resolve) => {
          finish = resolve as (value: string) => void
        })
      : Promise.resolve(undefined),
  )
  const controller = new AbortController()
  const request = {
    path: '/x.md',
    content: 'text',
    agent: 'codex',
    model: '',
    style: 'medium',
    language: 'en',
    question: null,
  }
  const pending = generateMarkdown(request, controller.signal)
  const args = vi.mocked(invoke).mock.calls[0][1] as { requestId: string }
  controller.abort()
  expect(invoke).toHaveBeenCalledWith('markdown_cancel', { requestId: args.requestId })
  finish('answer')
  await pending
  vi.mocked(invoke).mockClear()
  await expect(generateMarkdown(request, controller.signal)).rejects.toThrow('cancelled')
  expect(invoke).not.toHaveBeenCalled()
})
