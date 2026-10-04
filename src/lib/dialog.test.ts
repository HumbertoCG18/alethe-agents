import { beforeEach, describe, expect, it, vi } from 'vitest'

const confirm = vi.hoisted(() => vi.fn())
const recordFrontendError = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm, open: vi.fn(), save: vi.fn() }))
vi.mock('./tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tauri')>()),
  recordFrontendError,
}))

import { askConfirm } from './dialog'

beforeEach(() => {
  confirm.mockReset()
  recordFrontendError.mockClear()
})

describe('askConfirm', () => {
  it('resolves true when the user accepts, passing the message and options through', async () => {
    confirm.mockResolvedValue(true)

    await expect(askConfirm('Delete?', { title: 'Alethe', kind: 'warning' })).resolves.toBe(true)
    expect(confirm).toHaveBeenCalledWith('Delete?', { title: 'Alethe', kind: 'warning' })
  })

  it('resolves false when the user cancels', async () => {
    confirm.mockResolvedValue(false)

    await expect(askConfirm('Delete?')).resolves.toBe(false)
    expect(recordFrontendError).not.toHaveBeenCalled()
  })

  it('answers "no" at once to a second question while one is still open', async () => {
    let answer: (value: boolean) => void = () => {}
    confirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => (answer = resolve)))
    // Two clicks before the first dialog shows: only one dialog, only one yes.
    const first = askConfirm('Reset?')
    await expect(askConfirm('Reset?')).resolves.toBe(false)
    expect(confirm).toHaveBeenCalledTimes(1)
    answer(true)
    await expect(first).resolves.toBe(true)

    // Once it is answered, the next question opens a dialog again.
    confirm.mockResolvedValueOnce(true)
    await expect(askConfirm('Reset?')).resolves.toBe(true)
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('treats a failed dialog as "no" and reports the failure', async () => {
    confirm.mockRejectedValue(new Error('Command plugin:dialog|message not allowed by ACL'))

    await expect(askConfirm('Delete?')).resolves.toBe(false)
    expect(recordFrontendError).toHaveBeenCalledWith(
      expect.stringContaining('not allowed by ACL'),
      expect.anything(),
      'dialog',
    )
  })
})
