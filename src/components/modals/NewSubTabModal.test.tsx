import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { EMPTY_PROJECTS_FILE } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { NewSubTabModal } from './NewSubTabModal'

vi.mock('../../lib/tauri/terminalSettings', () => ({
  discoverShells: vi.fn(async () => [
    { id: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', kind: 'pwsh', isDefault: true },
    { id: 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', kind: 'powershell' },
  ]),
}))
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const WINDOWS_POWERSHELL = 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

afterEach(cleanup)

/** Opens New tab on a shell terminal in C:\repo that runs PowerShell 7; returns its saved tabs. */
function openOnShellTerminal() {
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: false })
  const project = useProjectsStore
    .getState()
    .createProject({ name: 'Tutor', defaultCwd: 'C:\\repo' })
  const terminal = useProjectsStore.getState().createTerminal(project.id, {
    name: 'Shell',
    cwd: 'C:\\repo',
    firstTab: { type: 'shell', cwd: 'C:\\repo', shell: PWSH },
  })
  useUiStore.getState().openModal_('newSubTab', { projectId: project.id, terminalId: terminal.id })
  render(<NewSubTabModal />)
  return () =>
    useProjectsStore
      .getState()
      .projects.find((item) => item.id === project.id)
      ?.terminals.find((item) => item.id === terminal.id)?.tabs ?? []
}

/** The tab type rows are buttons too; the shell picker is the one opening a list. */
const shellPicker = () =>
  screen
    .queryAllByRole('button', { name: 'Shell' })
    .find((el) => el.getAttribute('aria-haspopup') === 'listbox')

it('adds a shell tab on its own shell next to a tab on another one', async () => {
  const tabs = openOnShellTerminal()
  fireEvent.click(shellPicker()!)
  fireEvent.click(await screen.findByRole('option', { name: /^Windows PowerShell/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Add' }))

  await waitFor(() => expect(tabs().map((tab) => tab.shell)).toEqual([PWSH, WINDOWS_POWERSHELL]))
})

it('offers no shell for a WSL folder, which opens the distro shell', async () => {
  const tabs = openOnShellTerminal()
  fireEvent.click(shellPicker()!)
  fireEvent.click(await screen.findByRole('option', { name: /^Windows PowerShell/ }))
  fireEvent.change(screen.getByDisplayValue('C:\\repo'), {
    target: { value: '\\\\wsl.localhost\\Ubuntu\\home\\dev' },
  })

  expect(shellPicker()).toBeUndefined()
  fireEvent.click(screen.getByRole('button', { name: 'Add' }))
  await waitFor(() => expect(tabs()).toHaveLength(2))
  expect(tabs()[1]).toMatchObject({ type: 'shell', shell: undefined })
})
