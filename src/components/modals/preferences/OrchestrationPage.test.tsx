import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { orchestratorCodexModels } from '../../../lib/tauri/orchestrator'
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

  it('still offers the Codex efforts when Codex does not list its models', async () => {
    vi.mocked(orchestratorCodexModels).mockRejectedValueOnce(
      new Error('codex did not list its models in time'),
    )
    withRoles([{ ...reviewer, effort: null }])
    render(<OrchestrationPage />)
    await act(async () => {})

    fireEvent.click(screen.getByRole('button', { name: 'Effort for reviewer' }))
    expect(screen.getByRole('option', { name: 'xhigh' })).toBeTruthy()
    fireEvent.click(screen.getByRole('option', { name: 'medium' }))
    expect(orchestration().roles[0]).toMatchObject({ effort: 'medium' })
  })

  it('offers the Codex efforts while Codex is still listing its models', () => {
    vi.mocked(orchestratorCodexModels).mockReturnValueOnce(new Promise(() => {}))
    withRoles([{ ...reviewer, effort: null }])
    render(<OrchestrationPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Effort for reviewer' }))
    expect(screen.getByRole('option', { name: 'high' })).toBeTruthy()
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

  // Antigravity runs workers only; the orchestrator stays Claude or Codex (#218).
  it('offers Antigravity as the agent of a role but not as its orchestrator', () => {
    withRoles([reviewer])
    render(<OrchestrationPage />)

    choose('Agent for reviewer', 'Antigravity')
    expect(orchestration().roles[0]).toMatchObject({
      agent: 'antigravity',
      model: null,
      effort: null,
      readOnly: false,
    })
    expect(screen.getByRole('switch', { name: 'Read-only for reviewer' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Orchestrator for reviewer' }))
    expect(screen.queryByRole('option', { name: 'Antigravity' })).toBeNull()
  })

  it('offers the approved Antigravity models and only the efforts each one takes', () => {
    withRoles([
      {
        name: 'writer',
        agent: 'antigravity',
        model: null,
        effort: null,
        readOnly: false,
        timeoutSeconds: null,
      },
    ])
    render(<OrchestrationPage />)

    // The CLI default carries its own effort, so none is offered next to it.
    fireEvent.click(screen.getByRole('button', { name: 'Effort for writer' }))
    expect(screen.queryByRole('option', { name: 'medium' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Effort for writer' }))

    choose('Model for writer', 'claude-sonnet-5-5')
    fireEvent.click(screen.getByRole('button', { name: 'Effort for writer' }))
    expect(screen.queryByRole('option', { name: 'low' })).toBeNull()
    expect(screen.queryByRole('option', { name: 'max' })).toBeNull()
    fireEvent.click(screen.getByRole('option', { name: 'high' }))
    expect(orchestration().roles[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' })

    // A variant id names its effort, and agy refuses one next to it.
    choose('Model for writer', 'claude-opus-5-5-high')
    expect(orchestration().roles[0]).toMatchObject({ model: 'claude-opus-5-5-high', effort: null })
    fireEvent.click(screen.getByRole('button', { name: 'Effort for writer' }))
    expect(screen.queryByRole('option', { name: 'high' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Effort for writer' }))

    // OpenAI's open model in agy has a fixed effort, so it carries none either.
    choose('Model for writer', 'gpt-oss-120b-medium')
    expect(orchestration().roles[0]).toMatchObject({ model: 'gpt-oss-120b-medium', effort: null })
    fireEvent.click(screen.getByRole('button', { name: 'Effort for writer' }))
    expect(screen.queryByRole('option', { name: 'medium' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Effort for writer' }))

    // The owner's vendor order inside Antigravity: Anthropic, then OpenAI, then Google.
    fireEvent.click(screen.getByRole('button', { name: 'Model for writer' }))
    const order = [
      'claude-sonnet-5-5',
      'claude-opus-5-5-high',
      'gpt-oss-120b-medium',
      'gemini-3.8-flash',
    ]
    const offered = screen.getAllByRole('option').map((option) => option.textContent ?? '')
    expect(offered.filter((model) => order.includes(model))).toEqual(order)
    fireEvent.click(screen.getByRole('button', { name: 'Model for writer' }))

    choose('Model for writer', 'gemini-3.8-flash')
    choose('Effort for writer', 'medium')
    expect(orchestration().roles[0]).toMatchObject({ model: 'gemini-3.8-flash', effort: 'medium' })
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

  // UI-01: no stepper button sits inside a label, so clicking the label text steps nothing.
  it('does not step the concurrency when its label is clicked', () => {
    render(<OrchestrationPage />)
    const before = orchestration().maxConcurrent

    fireEvent.click(screen.getByText('Workers at the same time'))

    expect(orchestration().maxConcurrent).toBe(before)
    expect(screen.getByRole('group', { name: 'Workers at the same time' })).toBeTruthy()
  })

  // UI-01: a header cut short on a narrow window keeps its full text as a tooltip.
  it('keeps the full text of each roles header as its title', () => {
    withRoles([reviewer])
    render(<OrchestrationPage />)

    expect(screen.getByTitle('Read-only')).toHaveTextContent('Read-only')
    expect(screen.getByTitle('Budget (s)')).toHaveTextContent('Budget (s)')
  })

  // Workers start without every plugin of the person's own (#151), so there is no list to keep.
  it('offers no list of Codex plugins for workers to start without', () => {
    render(<OrchestrationPage />)

    expect(screen.queryByRole('textbox', { name: 'Codex plugins off in workers' })).toBeNull()
    expect(orchestration()).not.toHaveProperty('workerDisabledPlugins')
  })

  // A role's fallback while its provider is running out (#268).
  it('offers as fallback only the roles a role may run as', () => {
    const executor: OrchestrationRole = {
      name: 'executor',
      agent: 'claude',
      model: null,
      effort: null,
      readOnly: false,
      timeoutSeconds: null,
    }
    withRoles([reviewer, executor, { ...reviewer, name: 'reviewer-b' }])
    render(<OrchestrationPage />)

    // A read-only role cannot fall back to the writable executor.
    fireEvent.click(screen.getByRole('button', { name: 'Fallback for reviewer' }))
    expect(screen.queryByRole('option', { name: 'executor' })).toBeNull()
    fireEvent.click(screen.getByRole('option', { name: 'reviewer-b' }))
    expect(orchestration().roles[0]).toMatchObject({ name: 'reviewer', fallback: 'reviewer-b' })

    choose('Fallback for executor', 'reviewer')
    expect(orchestration().roles[1]).toMatchObject({ name: 'executor', fallback: 'reviewer' })
  })

  it('keeps a fallback pointing at a role that is renamed, and drops it when that role goes', () => {
    withRoles([
      { ...reviewer, fallback: 'reviewer-b' },
      { ...reviewer, name: 'reviewer-b' },
    ])
    render(<OrchestrationPage />)

    fireEvent.change(screen.getByRole('textbox', { name: 'Name of role reviewer-b' }), {
      target: { value: 'reviewer-c' },
    })
    expect(orchestration().roles[0].fallback).toBe('reviewer-c')

    fireEvent.click(screen.getByRole('button', { name: 'Remove reviewer-c' }))
    expect(orchestration().roles[0].fallback ?? null).toBeNull()
  })

  // A role row for one orchestrator (#276).
  it('gives a role one row per orchestrator under the same name', () => {
    withRoles([
      { ...reviewer, name: 'lead', fallback: 'reviewer' },
      reviewer,
      { ...reviewer, name: 'reviewer-b' },
    ])
    render(<OrchestrationPage />)

    choose('Orchestrator for reviewer', 'Codex')
    expect(orchestration().roles[1]).toMatchObject({ name: 'reviewer', orchestrator: 'codex' })

    // The same name for another orchestrator is a second row, not a clash, and a fallback that
    // names it stays where it was.
    fireEvent.change(screen.getByRole('textbox', { name: 'Name of role reviewer-b' }), {
      target: { value: 'reviewer' },
    })
    expect(orchestration().roles[2].name).toBe('reviewer')
    expect(orchestration().roles[2].orchestrator).toBeUndefined()
    // The fallback options list each name once.
    fireEvent.click(screen.getByRole('button', { name: 'Fallback for lead' }))
    expect(screen.getAllByRole('option', { name: 'reviewer' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Fallback for lead' }))

    // That row cannot become a second Codex row of reviewer.
    fireEvent.click(screen.getByRole('button', { name: 'Orchestrator for reviewer' }))
    expect(screen.getByRole('option', { name: 'Codex' })).toBeDisabled()
    fireEvent.click(screen.getByRole('option', { name: 'Claude Code' }))
    expect(orchestration().roles[2]).toMatchObject({ name: 'reviewer', orchestrator: 'claude' })
    expect(orchestration().roles[0].fallback).toBe('reviewer')
  })
})

// UI-08: a terminal's board goes with it unless the user keeps boards.
describe('OrchestrationPage board closing', () => {
  it('closes the board with its terminal by default, and saves turning that off', () => {
    render(<OrchestrationPage />)
    const toggle = screen.getByRole('switch', {
      name: 'Close the orchestration board with its terminal',
    })
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(toggle)

    expect(useProjectsStore.getState().preferences.closeOrchestrationBoardWithTerminal).toBe(false)
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })
})
