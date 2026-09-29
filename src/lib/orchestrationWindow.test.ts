import { describe, expect, it } from 'vitest'

import { orchestrationWindowPane } from './orchestrationWindow'

// A detached board window is labelled after the orchestration pane it shows (#247).
describe('orchestrationWindowPane', () => {
  it('reads the pane a detached board window was opened for', () => {
    expect(orchestrationWindowPane('orchestration-orchestrator-mWHJe7AX_ilh-tn')).toBe(
      'orchestrator-mWHJe7AX_ilh-tn',
    )
  })

  it('is not a board window otherwise', () => {
    expect(orchestrationWindowPane('main')).toBeNull()
    expect(orchestrationWindowPane('orchestration-')).toBeNull()
    expect(orchestrationWindowPane('web-orchestration-x')).toBeNull()
  })
})
