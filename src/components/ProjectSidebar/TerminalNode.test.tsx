import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_PROJECTS_FILE } from '../../lib/types'
import { useCampaignStepsStore } from '../../stores/campaignStepsStore'
import { useProjectsStore } from '../../stores/projectsStore'

vi.mock('../../lib/terminalLifecycle', () => ({ cleanupPtys: vi.fn() }))
// As the real hook: only a Claude session has a chat title to read.
vi.mock('../../hooks/useSidebarChatTitle', () => ({
  useSidebarChatTitle: (tab?: { type: string }) =>
    tab?.type === 'claude' ? 'Revisão da tabela A' : null,
}))

import { NormalTerminalNode } from './NormalTerminalNode'
import { TerminalNode } from './TerminalNode'

beforeEach(() => {
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: false })
  useCampaignStepsStore.setState({ byProject: {} })
})

/** A terminal whose first tab, of `type`, was opened for `campaignId`, if any. */
function terminal(campaignId?: string, type: 'claude' | 'codex' = 'claude') {
  const store = useProjectsStore.getState()
  const project = store.createProject({ name: 'App', defaultCwd: 'C:\\repo' })
  const created = store.createTerminal(project.id, {
    name: 'MOTOR',
    cwd: 'C:\\repo',
    firstTab: { type, cwd: 'C:\\repo', campaignId },
  })
  const fresh = useProjectsStore.getState().projects.find((item) => item.id === project.id)!
  return { project: fresh, terminal: fresh.terminals.find((item) => item.id === created.id)! }
}

const handlers = { onClick: () => {}, onDoubleClick: () => {}, onMenu: () => {} }

describe('terminal rows in the project sidebar', () => {
  it('name a campaign tab by its campaign, then its chat title', () => {
    const row = terminal('MOTOR')
    render(<TerminalNode {...row} selected {...handlers} />)
    expect(screen.getByText('MOTOR · Revisão da tabela A')).toBeInTheDocument()
  })

  it('name a renamed Codex campaign tab by its campaign, then the name given to it', () => {
    const row = terminal('MOTOR', 'codex')
    const tab = row.terminal.tabs[0]
    useProjectsStore.getState().setSubTabName(row.project.id, row.terminal.id, tab.id, 'Tabela A')
    const fresh = useProjectsStore.getState().projects[0]
    render(
      <NormalTerminalNode project={fresh} terminal={fresh.terminals[0]} selected {...handlers} />,
    )
    expect(screen.getByText('MOTOR · Tabela A')).toBeInTheDocument()
  })

  it('name a campaign tab by the task its campaign is going through by its steps', () => {
    const row = terminal('MOTOR')
    // Published for this project only: another project's MOTOR is not this one.
    useCampaignStepsStore.getState().publish(row.project.id, { MOTOR: 'MOTOR-08 2/5' })
    useCampaignStepsStore.getState().publish('elsewhere', { MOTOR: 'MOTOR-01 1/2' })
    render(<TerminalNode {...row} selected {...handlers} />)
    expect(screen.getByText('MOTOR · MOTOR-08 2/5')).toBeInTheDocument()
  })

  it('leave any other tab its chat title, in both sidebar layouts', () => {
    const row = terminal()
    render(<NormalTerminalNode {...row} selected {...handlers} />)
    expect(screen.getByText('Revisão da tabela A')).toBeInTheDocument()
  })
})
