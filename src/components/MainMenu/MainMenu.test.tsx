import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { translate } from '../../lib/i18n'
import { useUiStore } from '../../stores/uiStore'
import { MainMenu } from '.'

const askConfirm = vi.hoisted(() => vi.fn<(message: string) => Promise<boolean>>())
// Never settle, so the page reload that follows a wipe never runs in jsdom.
const tauri = vi.hoisted(() => ({
  resetAppData: vi.fn(() => new Promise<void>(() => {})),
  wipeAllAppData: vi.fn(() => new Promise<void>(() => {})),
}))

vi.mock('../../lib/dialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/dialog')>()),
  askConfirm,
}))
vi.mock('../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/tauri')>()),
  ...tauri,
}))

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  askConfirm.mockReset()
  tauri.resetAppData.mockClear()
  tauri.wipeAllAppData.mockClear()
  useUiStore.setState({ showMainMenu: true })
  // What tauri-plugin-dialog injects: an async confirm whose Promise is always truthy.
  vi.stubGlobal(
    'confirm',
    vi.fn(async () => false),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe.each([
  { label: 'menu.factoryReset', action: 'wipeAllAppData' },
  { label: 'menu.resetAppData', action: 'resetAppData' },
] as const)('MainMenu $label', ({ label, action }) => {
  it('does nothing when the user cancels', async () => {
    askConfirm.mockResolvedValue(false)
    render(<MainMenu />)
    fireEvent.click(screen.getByText(translate('en', label)))
    await flush()
    expect(tauri[action]).not.toHaveBeenCalled()
    expect(askConfirm).toHaveBeenCalledTimes(1)
  })

  it('proceeds when the user confirms', async () => {
    askConfirm.mockResolvedValue(true)
    render(<MainMenu />)
    fireEvent.click(screen.getByText(translate('en', label)))
    await vi.waitFor(() => expect(tauri[action]).toHaveBeenCalledTimes(1))
  })
})
