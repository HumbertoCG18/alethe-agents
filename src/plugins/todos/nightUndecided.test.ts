import { describe, expect, it } from 'vitest'

import { parseCampaigns } from '../../lib/campaigns'
import { nightUndecided } from './campaignView'

describe('nightUndecided', () => {
  const registry = JSON.stringify({
    versao: 1,
    projeto: 'x',
    tronco: 'C:\repo',
    campanhas: [
      {
        id: 'A',
        prioridade: 1,
        janela: 'qualquer',
        tarefas: [
          { id: 'A-01', titulo: 'a', estado: 'descartada', depende_de: [] },
          { id: 'A-02', titulo: 'b', estado: 'bloqueada', depende_de: [] },
        ],
      },
    ],
  })
  const campaigns = parseCampaigns(registry)!.campaigns
  const entry = (task: string) => ({
    task,
    result: 'aguarda-voce' as const,
    summary: 's',
    evidence: '',
    time: '2026-10-21T00:00:00',
  })

  it('stops waiting on you once the task is discarded', () => {
    expect(nightUndecided(entry('A-01'), campaigns)).toBe(false)
    expect(nightUndecided(entry('A-02'), campaigns)).toBe(true)
  })
})
