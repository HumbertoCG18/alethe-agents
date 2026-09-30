import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectsStore } from '../stores/projectsStore'
import { resumeSessionInPane } from './paneResume'
import { restartPty } from './tauri'

vi.mock('./tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tauri')>()),
  agentHooksSettingsPath: vi.fn(async () => 'C:\\Temp\\hooks.json'),
  restartPty: vi.fn(async ({ id }: { id: string }) => ({ id })),
  orchestratorMcpConfigPath: vi.fn(async () => 'C:\\Temp\\orchestrator-mcp.json'),
  playwrightMcpConfigPath: vi.fn(async () => 'C:\\Temp\\playwright-mcp.json'),
  graphifyMcpConfigPath: vi.fn(async () => 'C:\\Temp\\graphify-mcp.json'),
  graphifyEnsureGraph: vi.fn(async () => undefined),
  aiMemoryDetect: vi.fn(async () => ({ installed: false })),
  aiMemoryMcpConfigPath: vi.fn(async () => 'C:\\Temp\\ai-memory-mcp.json'),
}))

beforeEach(() => {
  vi.mocked(restartPty).mockClear()
  const { preferences } = useProjectsStore.getState()
  useProjectsStore.setState({
    preferences: {
      ...preferences,
      enabledFeatures: { ...preferences.enabledFeatures, orchestrator: true, playwright: true },
    },
  })
})

// Claude takes its MCP servers per launch; a resumed pane that drops them can no longer delegate
// or reach its other tools (#248).
describe('resumeSessionInPane', () => {
  it('relaunches Claude with its MCP servers', async () => {
    await resumeSessionInPane({
      agent: 'claude',
      projectId: 'proj-1',
      terminalId: 'term-1',
      tabId: 'tab-1',
      ptyId: 'pty-1',
      sessionId: '6a1f0c9e-2b4d-4c1e-9f3a-7d2e8b5c1a90',
      cwd: 'C:\\repo',
    })

    const args = vi.mocked(restartPty).mock.calls[0][0].extraArgs ?? []
    expect(args).toContain('--resume')
    const configs = args.flatMap((arg, index) => (args[index - 1] === '--mcp-config' ? [arg] : []))
    expect(configs.join(' ')).toContain('C:\\Temp\\orchestrator-mcp.json')
    expect(configs.join(' ')).toContain('C:\\Temp\\playwright-mcp.json')
  })
})
