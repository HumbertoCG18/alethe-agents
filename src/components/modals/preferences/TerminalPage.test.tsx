import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

import { DEFAULT_PREFERENCES, DEFAULT_TERMINAL_FONT_FAMILY } from '../../../lib/types'

const mocks = vi.hoisted(() => ({
  shells: vi.fn(),
  fonts: vi.fn(),
  state: {
    preferences: {} as typeof DEFAULT_PREFERENCES,
    cliPaths: {},
    setPreferences: vi.fn(),
    setAgentEnabled: vi.fn(),
    setCliPath: vi.fn(),
  },
}))
vi.mock('../../../stores/projectsStore', () => ({
  SPAWN_CONCURRENCY_LIMITS: { min: 1, max: 8 },
  useProjectsStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
}))
vi.mock('../../../lib/tauri/terminalSettings', () => ({
  discoverShells: mocks.shells,
  installedFontFamilies: mocks.fonts,
}))
vi.mock('../../../lib/resetLastSession', () => ({
  countLiveResumablePanes: vi.fn(),
  resetLastSession: vi.fn(),
}))
import { Modal } from '../Modal'
import { TerminalPage } from './TerminalPage'

/** Sections collapse through a header button named like their picker; this is the picker. */
const picker = (name: string) =>
  screen.getAllByRole('button', { name }).find((el) => el.getAttribute('aria-haspopup') === 'listbox')!

beforeEach(() => {
  mocks.state.preferences = { ...DEFAULT_PREFERENCES }
  mocks.state.setPreferences.mockReset()
  mocks.shells.mockReset().mockResolvedValue([
    { id: 'C:/Program Files/PowerShell/7/pwsh.exe', kind: 'pwsh', isDefault: true },
    { id: 'C:/Users/me/AppData/Local/Microsoft/WindowsApps/pwsh.exe', kind: 'pwshStore' },
    { id: 'C:/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe', kind: 'powershell' },
    { id: 'C:/Program Files/Git/bin/bash.exe', kind: 'gitBash' },
    { id: '/bin/bash', kind: 'bash' },
  ])
  mocks.fonts.mockReset().mockResolvedValue(['Consolas'])
})

it('offers actual local shells and fonts and saves the choices', async () => {
  const close = vi.fn()
  render(
    <Modal open onClose={close} title="Preferences">
      <TerminalPage enabledCount={4} />
    </Modal>,
  )
  fireEvent.click(picker('Default shell'))
  expect(
    await screen.findByRole('option', { name: 'Platform default (PowerShell 7)' }),
  ).toBeInTheDocument()
  expect(screen.getByRole('option', { name: /^PowerShell 7 \(Microsoft Store\).*WindowsApps/ }))
    .toBeInTheDocument()
  expect(screen.getByRole('option', { name: /^Windows PowerShell.*v1\.0/ })).toBeInTheDocument()
  expect(screen.getByRole('option', { name: /^Git Bash.*Git\/bin/ })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('option', { name: /^bash.*\/bin\/bash/ }))
  expect(mocks.state.setPreferences).toHaveBeenCalledWith({ shellPath: '/bin/bash' })
  fireEvent.click(picker('Terminal font'))
  fireEvent.click(await screen.findByRole('option', { name: 'Consolas' }))
  expect(mocks.state.setPreferences).toHaveBeenCalledWith({
    terminalFontFamily: `"Consolas", ${DEFAULT_TERMINAL_FONT_FAMILY}`,
  })
  expect(close).not.toHaveBeenCalled()
})

it('shows fallback warnings for removed local choices', async () => {
  mocks.state.preferences.shellPath = '/custom/bash'
  mocks.state.preferences.terminalFontFamily = `"Removed font", ${DEFAULT_TERMINAL_FONT_FAMILY}`
  render(<TerminalPage enabledCount={4} />)
  expect(
    await screen.findByText(
      'Custom executable. If it is removed, new sessions use the platform default.',
    ),
  ).toBeTruthy()
  expect(
    await screen.findByText('Saved font is unavailable. The default font is used instead.'),
  ).toBeTruthy()
})
