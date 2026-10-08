import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'
import { getCachedAntigravityUsage } from './antigravityUsageCache'
import { getCachedClaudeUsage, loadClaudeUsage } from './claudeUsageCache'
import { getCachedCodexUsage } from './codexUsageCache'
import {
  type CodexUsage,
  consumeCodexResetCredit,
  getAntigravityUsage,
  getClaudeUsage,
  getCodexUsage,
} from './tauri'
import { clearAllTtlCaches } from './ttlCache'
import { DEFAULT_PREFERENCES, type UsageProviderId } from './types'
import { USAGE_ACCESS_OFF } from './usageAccess'

const USAGE_COMMANDS = [
  'get_claude_usage',
  'get_codex_usage',
  'consume_codex_reset_credit',
  'get_antigravity_usage',
]

const codexReading = {
  primary: { used_percent: 12, window_minutes: 300, resets_at_ms: 1 },
  secondary: { used_percent: 30, window_minutes: 10080, resets_at_ms: 2 },
  plan: 'pro',
  rate_limited: false,
  reset_credits: 0,
} satisfies CodexUsage

function allow(access: Partial<Record<UsageProviderId, boolean>>) {
  const { preferences } = useProjectsStore.getState()
  useProjectsStore.setState({
    preferences: { ...preferences, usageAccess: { ...preferences.usageAccess, ...access } },
  })
}

function usageCalls(): string[] {
  return invoke.mock.calls
    .map(([command]) => String(command))
    .filter((command) => USAGE_COMMANDS.includes(command))
}

/** Every way the app has of reading usage, forced past the caches. */
function readEverything() {
  return Promise.allSettled([
    getClaudeUsage(),
    getCodexUsage(),
    getAntigravityUsage(),
    consumeCodexResetCredit('credit'),
    getCachedClaudeUsage(true),
    getCachedCodexUsage(true),
    getCachedAntigravityUsage(true),
    loadClaudeUsage(true),
  ])
}

beforeEach(() => {
  useProjectsStore.setState({ preferences: DEFAULT_PREFERENCES })
  clearAllTtlCaches()
  invoke.mockReset()
  invoke.mockResolvedValue(codexReading)
  useUiStore.setState({
    claudeUsage: null,
    claudeUsageError: null,
    codexUsage: null,
    antigravityUsage: null,
  })
})

describe('usage access gate', () => {
  it('makes no backend call for any provider on a new profile', async () => {
    const results = await readEverything()

    expect(usageCalls()).toEqual([])
    expect(invoke).not.toHaveBeenCalled()
    for (const result of results.slice(0, 7)) {
      expect(result).toEqual({ status: 'rejected', reason: USAGE_ACCESS_OFF })
    }
    // Off is not an error to show: no reading and no "unavailable" either.
    expect(useUiStore.getState().claudeUsage).toBeNull()
    expect(useUiStore.getState().claudeUsageError).toBeNull()
  })

  it('reads only the provider that was turned on', async () => {
    allow({ codex: true })
    await readEverything()

    expect(new Set(usageCalls())).toEqual(
      new Set(['get_codex_usage', 'consume_codex_reset_credit']),
    )
  })

  it('stops reading a provider, and clears what it showed, once it is turned off', async () => {
    allow({ claude: true, codex: true, antigravity: true })
    useUiStore.setState({ codexUsage: await getCachedCodexUsage() })
    expect(usageCalls()).toEqual(['get_codex_usage'])

    invoke.mockClear()
    allow({ codex: false })

    expect(useUiStore.getState().codexUsage).toBeNull()
    // Not even the reading cached a moment ago is served.
    await expect(getCachedCodexUsage()).rejects.toBe(USAGE_ACCESS_OFF)
    expect(usageCalls()).toEqual([])
  })

  it('drops a reading that arrives after the provider was turned off', async () => {
    allow({ codex: true })
    let finish: (usage: CodexUsage) => void = () => undefined
    invoke.mockReturnValueOnce(new Promise<CodexUsage>((resolve) => (finish = resolve)))

    const pending = getCachedCodexUsage(true)
    allow({ codex: false })
    finish(codexReading)

    await expect(pending).rejects.toBe(USAGE_ACCESS_OFF)
  })
})
