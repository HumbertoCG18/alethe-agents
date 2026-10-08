import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { translate } from '../../lib/i18n'
import { emptyCounts, type PlannerGroup } from '../../lib/orchestratorRuns'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { PlannerTab } from '.'

const group = (id: string | null): PlannerGroup => ({
  id,
  label: 'Planner',
  agent: 'claude',
  runs: [],
  jobs: [],
  superseded: [],
  counts: emptyCounts(),
  // The jobs are all done: the dot no longer follows them.
  state: 'finished',
})

function renderTab(id: string | null) {
  render(
    <PlannerTab
      group={group(id)}
      shells={[]}
      selected
      theme="dark"
      onSelect={() => {}}
      t={(key, params) => translate('en', key, params)}
    />,
  )
  return screen.getByRole('tab')
}

afterEach(() => {
  cleanup()
  useTerminalsStore.getState().reset()
})

describe('PlannerTab', () => {
  it('shows the live status of the planner terminal, whatever its jobs are doing', () => {
    useTerminalsStore.getState().registerPty('pty-planner')
    const tab = renderTab('pty-planner')
    expect(tab).toHaveAttribute('data-status', 'waiting')

    act(() => useTerminalsStore.getState().setStatus('pty-planner', 'working'))
    expect(tab).toHaveAttribute('data-status', 'working')
    act(() => useTerminalsStore.getState().markExited('pty-planner'))
    expect(tab).toHaveAttribute('data-status', 'stopped')
  })

  it('reads as stopped without a planner terminal', () => {
    expect(renderTab('pty-gone')).toHaveAttribute('data-status', 'stopped')
    cleanup()
    expect(renderTab(null)).toHaveAttribute('data-status', 'stopped')
  })
})
