import { describe, expect, it } from 'vitest'

import { workerEvents } from './sessionEvents'
import type { OrchestratorJob, OrchestratorPendingApproval } from './tauri'

const job = (partial: Partial<OrchestratorJob>) =>
  ({ spec: 'Measure table A', summary: '', pendingApproval: null, ...partial }) as OrchestratorJob

const approval = (partial: Partial<OrchestratorPendingApproval>): OrchestratorPendingApproval => ({
  rpcId: 7,
  kind: 'command',
  command: null,
  cwd: null,
  reason: null,
  askedAtMs: 0,
  ...partial,
})

describe('workerEvents', () => {
  it('reads a worker as its task, its report and the approval it waits on', () => {
    expect(
      workerEvents(
        job({
          summary: 'Measured; Gate 1 is missing.',
          pendingApproval: approval({ command: 'npm test' }),
        }),
      ),
    ).toEqual([
      { role: 'user', text: 'Measure table A' },
      { role: 'assistant', text: 'Measured; Gate 1 is missing.' },
      { role: 'question', text: 'npm test', questionSetId: '7' },
    ])
  })

  it('leaves out what a worker has not said yet', () => {
    expect(workerEvents(job({ summary: '  ' }))).toEqual([
      { role: 'user', text: 'Measure table A' },
    ])
    expect(workerEvents(job({ spec: '' }))).toEqual([])
  })

  it('words an approval by its reason, then by its kind, when it names no command', () => {
    const asked = (ask: Partial<OrchestratorPendingApproval>) =>
      workerEvents(job({ spec: '', pendingApproval: approval(ask) }))[0]?.text
    expect(asked({ kind: 'fileChange', reason: 'Edit src/a.ts' })).toBe('Edit src/a.ts')
    expect(asked({ kind: 'fileChange' })).toBe('fileChange')
  })
})
