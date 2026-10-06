import { describe, expect, it } from 'vitest'

import { campaignPrerequisites, parseCampaigns, setCampaignDependencies } from './campaigns'

const source = JSON.stringify({
  campanhas: [
    {
      id: 'A',
      prioridade: 1,
      janela: 'assistida',
      worktrees: [],
      depende_de: [],
      tarefas: [{ id: 'A-01', estado: 'pronta', depende_de: [] }],
    },
    {
      id: 'B',
      prioridade: 2,
      janela: 'assistida',
      worktrees: [],
      depende_de: [],
      tarefas: [{ id: 'B-01', estado: 'pronta', depende_de: [] }],
    },
  ],
})

describe('campaign prerequisite editing', () => {
  it('blocks without any terminal and releases only after the prerequisite finishes', () => {
    const edit = setCampaignDependencies(source, 'B', ['A'], '2026-10-06')
    expect(edit.ok).toBe(true)
    if (!edit.ok) return
    const parsed = parseCampaigns(edit.content)!
    expect(campaignPrerequisites(parsed.campaigns[1], parsed.campaigns)).toEqual(['A'])
    const done = JSON.parse(edit.content)
    done.campanhas[0].tarefas[0].estado = 'concluída'
    const completed = parseCampaigns(JSON.stringify(done))!
    expect(campaignPrerequisites(completed.campaigns[1], completed.campaigns)).toEqual([])
  })
  it('rejects self dependency, unknown IDs and cycles without producing a write', () => {
    expect(setCampaignDependencies(source, 'A', ['A'], '2026-10-06').ok).toBe(false)
    expect(setCampaignDependencies(source, 'A', ['missing'], '2026-10-06').ok).toBe(false)
    const edit = setCampaignDependencies(source, 'B', ['A'], '2026-10-06')
    if (!edit.ok) throw new Error('valid edit refused')
    expect(setCampaignDependencies(edit.content, 'A', ['B'], '2026-10-06').ok).toBe(false)
  })
})
