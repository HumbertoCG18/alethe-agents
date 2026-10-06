import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PREFERENCES,
  type Preferences,
  type Project,
  type WorkspaceViewSnapshot,
} from './types'
import {
  captureWorkspaceSnapshot,
  cloneWorkspaceSnapshot,
  compositionLabel,
  MAX_WORKSPACE_HISTORY,
  pushWorkspaceHistory,
  sanitizeWorkspaceSnapshot,
} from './workspaceNavigation'

const preferences: Preferences = {
  ...DEFAULT_PREFERENCES,
  onboardingDone: true,
  accountCreated: true,
  discordRichPresenceEnabled: false,
}

const projects: Project[] = [
  {
    id: 'project-a',
    name: 'Project A',
    groupId: null,
    terminals: [
      {
        id: 'terminal-a',
        name: 'Terminal A',
        cwd: 'C:\\a',
        tabs: [],
        activeTabId: '',
        disabled: false,
        laneVisible: null,
      },
    ],
    layoutMode: 'auto',
    collapsed: false,
    createdAt: 1,
  },
]

function snapshot(projectId = 'project-a', terminalId = 'terminal-a'): WorkspaceViewSnapshot {
  return captureWorkspaceSnapshot({
    containers: [
      {
        projectId,
        paneIds: [terminalId],
        size: 1,
        internalLayout: 'auto',
        collapsed: false,
      },
    ],
    activeProjectId: projectId,
    activeGroupId: null,
    focusedTerminalId: terminalId,
    preferences,
  })
}

describe('workspaceNavigation', () => {
  it('pushWorkspaceHistory truncates the forward branch', () => {
    const a = snapshot()
    const first = pushWorkspaceHistory([], -1, {
      id: 'h1',
      tabId: 'tab-a',
      label: 'A',
      snapshot: a,
      visitedAt: 1,
    })
    const second = pushWorkspaceHistory(first.history, first.historyIndex, {
      id: 'h2',
      tabId: 'tab-b',
      label: 'B',
      snapshot: a,
      visitedAt: 2,
    })
    const branched = pushWorkspaceHistory(second.history, 0, {
      id: 'h3',
      tabId: 'tab-c',
      label: 'C',
      snapshot: a,
      visitedAt: 3,
    })

    expect(branched.history.map((entry) => entry.id)).toEqual(['h1', 'h3'])
    expect(branched.historyIndex).toBe(1)
  })

  it('history keeps only the latest configured entries', () => {
    let history: ReturnType<typeof pushWorkspaceHistory> = { history: [], historyIndex: -1 }
    for (let index = 0; index < MAX_WORKSPACE_HISTORY + 5; index += 1) {
      history = pushWorkspaceHistory(history.history, history.historyIndex, {
        id: `h${index}`,
        tabId: 'tab-a',
        label: 'A',
        snapshot: snapshot(),
        visitedAt: index,
      })
    }
    expect(history.history.length).toBe(MAX_WORKSPACE_HISTORY)
    expect(history.history[0].id).toBe('h5')
  })

  it('sanitizeWorkspaceSnapshot removes missing projects and terminals', () => {
    const dirty = snapshot('project-a', 'missing-terminal')
    dirty.containers.push({
      projectId: 'missing-project',
      paneIds: ['anything'],
      size: 1,
      internalLayout: 'auto',
      collapsed: false,
    })

    const clean = sanitizeWorkspaceSnapshot(dirty, projects)
    expect(clean.containers).toEqual([])
    // The project still exists, so it stays active even without visible panes.
    expect(clean.activeProjectId).toBe('project-a')
    expect(clean.focusedTerminalId).toBeNull()
    expect(
      sanitizeWorkspaceSnapshot({ ...dirty, activeProjectId: 'missing-project' }, projects)
        .activeProjectId,
    ).toBeNull()
  })

  it('snapshots are deep-cloned and composition labels include item count', () => {
    const original = snapshot()
    const cloned = cloneWorkspaceSnapshot(original)
    cloned.containers[0].paneIds.push('terminal-b')

    expect(original.containers[0].paneIds).toEqual(['terminal-a'])
    expect(compositionLabel(cloned, projects)).toBe('Project A + 1')
  })
})
