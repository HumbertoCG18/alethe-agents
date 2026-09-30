import { describe, expect, it } from 'vitest'

import { DEFAULT_PREFERENCES, EMPTY_PROJECTS_FILE } from '../lib/types'
import { migrate, normalizePreferences, normalizeTodos } from './projectsStore.migrations'

describe('preference normalization', () => {
  it('preserves persisted sidebar visibility and widths', () => {
    const preferences = normalizePreferences({
      ...DEFAULT_PREFERENCES,
      leftSidebarVisible: false,
      rightSidebarVisible: true,
      leftSidebarWidth: 337,
      rightSidebarWidth: 391,
    })

    expect(preferences).toMatchObject({
      leftSidebarVisible: false,
      rightSidebarVisible: true,
      leftSidebarWidth: 337,
      rightSidebarWidth: 391,
    })
  })

  it('disables legacy automatic parking preferences', () => {
    const preferences = normalizePreferences({
      ...DEFAULT_PREFERENCES,
      resourcePolicy: {
        ...DEFAULT_PREFERENCES.resourcePolicy,
        mode: 'smart-lru',
        automaticParkingOptIn: true,
      },
    })

    expect(preferences.resourcePolicy).toMatchObject({
      mode: 'manual',
      automaticParkingOptIn: false,
    })
  })

  // Orchestration settings (#254).
  it('gives a file saved before orchestration settings the defaults', () => {
    const { orchestration: _older, ...saved } = DEFAULT_PREFERENCES

    expect(normalizePreferences(saved as typeof DEFAULT_PREFERENCES).orchestration).toEqual({
      roles: [],
      maxConcurrent: 4,
      defaultTimeoutSeconds: 900,
    })
  })

  it('keeps valid roles and drops the ones the orchestrator would refuse', () => {
    const reviewer = {
      name: 'reviewer',
      agent: 'codex' as const,
      model: 'gpt-6.1-sol',
      effort: 'medium',
      readOnly: true,
      timeoutSeconds: 600,
    }
    const writer = {
      name: 'writer',
      agent: 'claude' as const,
      model: 'opus',
      effort: null,
      readOnly: false,
      timeoutSeconds: null,
    }
    const preferences = normalizePreferences({
      ...DEFAULT_PREFERENCES,
      orchestration: {
        maxConcurrent: 40,
        defaultTimeoutSeconds: 1e20,
        roles: [
          reviewer,
          writer,
          // Repairing these would change what they mean: a read-only Claude role made writable.
          { ...writer, name: 'reader', readOnly: true },
          { ...writer, name: 'thinker', effort: 'high' },
          { ...reviewer, model: null },
          { ...reviewer, name: '-flag' },
          { ...reviewer, name: 'odd', agent: 'grok' as 'codex' },
          { ...reviewer, name: 'spaced', model: 'gpt 6' },
          // Past what the orchestrator can hold, so the whole settings would be refused.
          { ...reviewer, name: 'endless', timeoutSeconds: 1e20 },
        ],
      },
    })

    expect(preferences.orchestration).toEqual({
      maxConcurrent: 16,
      defaultTimeoutSeconds: 900,
      roles: [reviewer, writer],
    })
  })

  it('keeps Discord Rich Presence opt-in while preserving an existing choice', () => {
    expect(normalizePreferences(undefined).discordRichPresenceEnabled).toBe(false)
    expect(
      normalizePreferences({
        ...DEFAULT_PREFERENCES,
        discordRichPresenceEnabled: true,
      }).discordRichPresenceEnabled,
    ).toBe(true)
    expect(
      normalizePreferences({
        ...DEFAULT_PREFERENCES,
        discordRichPresenceEnabled: false,
      }).discordRichPresenceEnabled,
    ).toBe(false)
  })

  it('defaults motion to animated and preserves a reduced-motion choice', () => {
    expect(normalizePreferences(undefined).motionPreference).toBe('animated')
    expect(
      normalizePreferences({
        ...DEFAULT_PREFERENCES,
        motionPreference: 'reduced',
      }).motionPreference,
    ).toBe('reduced')
    expect(
      normalizePreferences({
        ...DEFAULT_PREFERENCES,
        motionPreference: 'unsupported' as 'reduced',
      }).motionPreference,
    ).toBe('animated')
  })

  it('clamps Pomodoro durations to a sane range and falls back on invalid input', () => {
    expect(
      normalizePreferences({
        ...DEFAULT_PREFERENCES,
        pomodoroWorkMinutes: 0,
        pomodoroShortBreakMinutes: 999,
        pomodoroLongBreakMinutes: Number.NaN,
      }),
    ).toMatchObject({
      pomodoroWorkMinutes: 1,
      pomodoroShortBreakMinutes: 120,
      pomodoroLongBreakMinutes: DEFAULT_PREFERENCES.pomodoroLongBreakMinutes,
    })
  })

  it('discards a running Pomodoro session that already ended', () => {
    const preferences = normalizePreferences({
      ...DEFAULT_PREFERENCES,
      pomodoroSession: {
        phase: 'work',
        status: 'running',
        endsAt: Date.now() - 60_000,
        remainingMsAtPause: null,
        cyclesCompleted: 1,
        focusTodoId: null,
      },
    })

    expect(preferences.pomodoroSession).toMatchObject({ status: 'finished', endsAt: null })
  })
})

describe('todos normalization', () => {
  it('backfills PR fields when present and drops them when absent', () => {
    const todos = normalizeTodos([
      {
        id: 'a',
        title: 'Review PR',
        completed: false,
        prUrl: 'https://x',
        prNumber: 12,
        prRepo: 'o/r',
      },
      { id: 'b', title: 'Plain task', completed: false },
    ])

    expect(todos.find((t) => t.id === 'a')).toMatchObject({
      prUrl: 'https://x',
      prNumber: 12,
      prRepo: 'o/r',
    })
    expect(todos.find((t) => t.id === 'b')).not.toHaveProperty('prUrl')
  })
})

describe('projects file migration', () => {
  it('adds isolated layout histories when migrating v6 data', () => {
    const migrated = migrate({
      ...EMPTY_PROJECTS_FILE,
      version: 6,
      projects: [{ id: 'project', gridLayoutHistory: undefined }],
      groups: [{ id: 'group', gridLayoutHistory: undefined }],
      preferences: { ...DEFAULT_PREFERENCES, workspaceGridLayoutHistory: undefined },
    })

    expect(migrated.version).toBe(9)
    expect(migrated.projects[0].gridLayoutHistory).toEqual([])
    expect(migrated.groups[0].gridLayoutHistory).toEqual([])
    expect(migrated.preferences.workspaceGridLayoutHistory).toEqual([])
  })

  it('carries forward remote sharing when migrating v7 data to v8', () => {
    const migrated = migrate({
      ...EMPTY_PROJECTS_FILE,
      version: 7,
      projects: [
        {
          id: 'project',
          terminals: [
            { id: 'excluded', remoteExcluded: true },
            { id: 'shared', remoteExcluded: false },
            { id: 'untouched' },
          ],
        },
      ],
    })

    expect(migrated.version).toBe(9)
    const terminals = migrated.projects[0].terminals
    expect(terminals.find((t) => t.id === 'excluded')?.remoteShared).toBe(false)
    expect(terminals.find((t) => t.id === 'shared')?.remoteShared).toBe(true)
    expect(terminals.find((t) => t.id === 'untouched')?.remoteShared).toBe(true)
  })

  it('leaves an explicit remoteShared value untouched when migrating to v8', () => {
    const migrated = migrate({
      ...EMPTY_PROJECTS_FILE,
      version: 7,
      projects: [
        {
          id: 'project',
          terminals: [{ id: 'terminal', remoteExcluded: true, remoteShared: true }],
        },
      ],
    })

    expect(migrated.projects[0].terminals[0].remoteShared).toBe(true)
  })
})
