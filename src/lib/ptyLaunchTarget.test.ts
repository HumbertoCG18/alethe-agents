import { beforeEach, expect, it } from 'vitest'

import { useProjectsStore } from '../stores/projectsStore'
import { ptyLaunchTarget } from './ptyLaunchTarget'
import { EMPTY_PROJECTS_FILE } from './types'

const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const WINDOWS_POWERSHELL = 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

beforeEach(() => {
  const file = structuredClone(EMPTY_PROJECTS_FILE)
  useProjectsStore.setState({
    ...file,
    preferences: { ...file.preferences, shellPath: '/bin/bash' },
    // Only what the lookup reads: two terminals of one project and their tabs.
    projects: [
      {
        terminals: [
          { tabs: [{ id: 'tab-1', ptyId: 'pty-1', type: 'shell', shell: PWSH }] },
          {
            tabs: [
              { id: 'tab-2', ptyId: null, type: 'shell', shell: WINDOWS_POWERSHELL },
              { id: 'tab-3', ptyId: 'pty-3', type: 'shell' },
              { id: 'tab-4', ptyId: 'pty-4', type: 'claude', shell: PWSH },
            ],
          },
        ],
      },
    ] as never,
  })
})

it('runs each plain shell tab of a project on its own shell, the default as its fallback', () => {
  expect(ptyLaunchTarget('shell', 'pty-1')).toEqual({
    command: undefined,
    launcherOverride: PWSH,
    fallbackLauncher: '/bin/bash',
  })
  // Before its first spawn a tab runs under its own id.
  expect(ptyLaunchTarget(null, 'tab-2')).toMatchObject({ launcherOverride: WINDOWS_POWERSHELL })
})

it('uses the default shell for a tab without its own', () => {
  expect(ptyLaunchTarget('shell', 'pty-3')).toEqual({
    command: undefined,
    launcherOverride: '/bin/bash',
  })
  expect(ptyLaunchTarget('shell').launcherOverride).toBe('/bin/bash')
})

it('keeps the launcher an agent tab requires', () => {
  expect(ptyLaunchTarget('claude', 'pty-4')).toEqual({
    command: 'claude',
    launcherOverride: undefined,
  })
})
