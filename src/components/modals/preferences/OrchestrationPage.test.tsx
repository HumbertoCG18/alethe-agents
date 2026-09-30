import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_PROJECTS_FILE, type OrchestrationRole } from '../../../lib/types'
import { useProjectsStore } from '../../../stores/projectsStore'
import { OrchestrationPage } from './OrchestrationPage'

vi.mock('../../../lib/tauri/orchestrator', () => ({
  orchestratorCodexModels: vi.fn(async () => [
    { model: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', defaultEffort: 'low', efforts: ['low', 'ultra'] },
    { model: 'gpt-6-astra', name: 'GPT-6 Astra', defaultEffort: 'medium', efforts: ['medium'] },
  ]),
}))

const reviewer: OrchestrationRole = {
  name: 'reviewer',
  agent: 'codex',
  model: 'gpt-6.1-sol',
  effort: 'low',
  readOnly: true,
  timeoutSeconds: 600,
}

const orchestration = () => useProjectsStore.getState().preferences.orchestration

function withRoles(roles: OrchestrationRole[]) {
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
  const { preferences, setPreferences } = useProjectsStore.getState()
  setPreferences({ orchestration: { ...preferences.orchestration, roles } })
}

function choose(control: string, option: string) {
  fireEvent.click(screen.getByRole('button', { name: control }))
  fireEvent.click(screen.getByRole('option', { name: option }))
}

beforeEach(() => withRoles([]))

// The Orchestration category of Preferences (#254).
describe('OrchestrationPage', () => {
  it('adds a role that the orchestrator can run as soon as it appears', () => {
    render(<OrchestrationPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Add role' }))

    expect(orchestration().roles).toEqual([
      {
        name: 'role-1',
        agent: 'codex',
        model: null,
        effort: null,
        readOnly: false,
        timeoutSeconds: null,
      },
    ])
  })

  it('offers the models Codex reports and the efforts the chosen one accepts', async () => {
    withRoles([reviewer])
    render(<OrchestrationPage />)
    // Let the model list Codex reports arrive.
    await act(async () => {})

    choose('Model for reviewer', 'GPT-6 Astra')
    // The effort it had is not one the new model accepts.
    expect(orchestration().roles[0]).toMatchObject({ model: 'gpt-6-astra', effort: null })

    fireEvent.click(screen.getByRole('button', { name: 'Effort for reviewer' }))
    expect(screen.queryByRole('option', { name: 'ultra' })).toBeNull()
    fireEvent.click(screen.getByRole('option', { name: 'medium' }))
    expect(orchestration().roles[0]).toMatchObject({ effort: 'medium' })
  })

  it('offers the efforts Claude Code takes for a Claude role', () => {
    withRoles([
      {
        name: 'executor',
        agent: 'claude',
        model: 'claude-opus-5-5',
        effort: null,
        readOnly: false,
        timeoutSeconds: null,
      },
    ])
    render(<OrchestrationPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Effort for executor' }))
    expect(screen.getByRole('option', { name: 'max' })).toBeTruthy()
    fireEvent.click(screen.getByRole('option', { name: 'high' }))

    expect(orchestration().roles[0]).toMatchObject({ agent: 'claude', effort: 'high' })
  })

  it('drops what only Codex has when a role moves to Claude', () => {
    withRoles([reviewer])
    render(<OrchestrationPage />)

    choose('Agent for reviewer', 'Claude Code')

    expect(orchestration().roles[0]).toMatchObject({
      agent: 'claude',
      model: null,
      effort: null,
      readOnly: false,
    })
  })

  it('does not save a rename that takes the name of another role', () => {
    const writer: OrchestrationRole = {
      name: 'writer',
      agent: 'claude',
      model: null,
      effort: null,
      readOnly: false,
      timeoutSeconds: null,
    }
    withRoles([writer, reviewer])
    render(<OrchestrationPage />)

    fireEvent.change(screen.getByRole('textbox', { name: 'Name of role writer' }), {
      target: { value: 'reviewer' },
    })

    // Saved, it would hand the reviewer's name to a writable Claude role.
    expect(orchestration().roles.map((role) => role.name)).toEqual(['writer', 'reviewer'])
    expect(screen.getByText(/Use a unique name/)).toBeTruthy()
  })

  it('saves how many workers run at the same time', () => {
    render(<OrchestrationPage />)

    fireEvent.click(screen.getByRole('button', { name: 'More workers at the same time' }))

    expect(orchestration().maxConcurrent).toBe(5)
  })
})
