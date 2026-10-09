import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'
import { relaunchAgentPty } from './agentRelaunch'
import { hasOrchestratorTools, recordClaudeLaunch } from './claudeMcpConfigs'
import { restartPty } from './tauri'

vi.mock('./tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tauri')>()),
  agentHooksSettingsPath: vi.fn(async () => 'C:\\Temp\\hooks.json'),
  restartPty: vi.fn(async ({ id }: { id: string }) => ({ id })),
  orchestratorMcpConfigPath: vi.fn(async () => 'C:\\Temp\\orchestrator-mcp.json'),
  playwrightMcpConfigPath: vi.fn(async () => 'C:\\Temp\\playwright-mcp.json'),
  aiMemoryDetect: vi.fn(async () => ({ installed: false })),
}))

beforeEach(() => {
  vi.mocked(restartPty).mockClear()
  recordClaudeLaunch('pty-1', false)
  const { preferences } = useProjectsStore.getState()
  useProjectsStore.setState({
    preferences: {
      ...preferences,
      enabledFeatures: { ...preferences.enabledFeatures, orchestrator: true },
    },
  })
})

// Every relaunch of a Claude pane keeps its MCP servers and hooks, and only a launch that went
// through counts as the pane having the orchestrator tools (#248).
describe('relaunchAgentPty', () => {
  it('relaunches Claude with its MCP servers and hooks and records the tools', async () => {
    await relaunchAgentPty({ ptyId: 'pty-1', agent: 'claude', cwd: 'C:\\repo' })

    const args = vi.mocked(restartPty).mock.calls[0][0].extraArgs ?? []
    expect(args).toEqual(
      expect.arrayContaining(['--mcp-config', 'C:\\Temp\\orchestrator-mcp.json']),
    )
    expect(args).toEqual(expect.arrayContaining(['--settings', 'C:\\Temp\\hooks.json']))
    expect(hasOrchestratorTools('pty-1')).toBe(true)
  })

  it('hands a Claude inside WSL its MCP servers and hooks in guest form', async () => {
    await relaunchAgentPty({
      ptyId: 'pty-1',
      agent: 'claude',
      cwd: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo',
    })

    const args = vi.mocked(restartPty).mock.calls[0][0].extraArgs ?? []
    expect(args).toEqual(
      expect.arrayContaining(['--mcp-config', '/mnt/c/Temp/orchestrator-mcp.json']),
    )
    expect(args).toEqual(expect.arrayContaining(['--settings', '/mnt/c/Temp/hooks.json']))
    expect(args.some((arg) => arg.includes('C:\\'))).toBe(false)
  })

  it('records nothing when the restart fails', async () => {
    vi.mocked(restartPty).mockRejectedValueOnce(new Error('spawn failed'))

    await expect(
      relaunchAgentPty({ ptyId: 'pty-1', agent: 'claude', cwd: 'C:\\repo' }),
    ).rejects.toThrow('spawn failed')

    expect(hasOrchestratorTools('pty-1')).toBe(false)
  })

  describe('a plain shell tab with its own shell', () => {
    const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
    beforeEach(() => {
      useUiStore.setState({ toasts: [], notifications: [] })
      useProjectsStore.setState((state) => ({
        preferences: { ...state.preferences, shellPath: '/bin/bash' },
        projects: [
          { terminals: [{ tabs: [{ id: 'tab-1', ptyId: 'pty-1', type: 'shell', shell: pwsh }] }] },
        ] as never,
      }))
    })

    it('restarts on that shell, the default as its fallback', async () => {
      await relaunchAgentPty({ ptyId: 'pty-1', agent: 'shell', cwd: 'C:\\repo' })

      expect(vi.mocked(restartPty).mock.calls[0][0]).toMatchObject({
        command: undefined,
        launcherOverride: pwsh,
        fallbackLauncher: '/bin/bash',
      })
      expect(useUiStore.getState().notifications).toEqual([])
    })

    it('says so when the backend fell back because that shell is gone', async () => {
      vi.mocked(restartPty).mockResolvedValueOnce({ id: 'pty-1', shellFallback: true })

      await relaunchAgentPty({ ptyId: 'pty-1', agent: 'shell', cwd: 'C:\\repo' })

      expect(useUiStore.getState().notifications).toHaveLength(1)
      expect(useUiStore.getState().notifications[0]).toMatchObject({
        title: 'Saved shell is unavailable. The default shell is used instead.',
        body: pwsh,
      })
    })
  })
})
