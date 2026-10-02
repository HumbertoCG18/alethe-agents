// Contract with agent-workflow-lab/bin/campanhas.py. When a rule changes there, regenerate the
// gabarito in the lab with
//   python bin/campanhas.py listar --json --registro bin/fixtures/campanhas.exemplo.json
// and copy both bin/fixtures/campanhas.exemplo.json and campanhas.gabarito.json here unchanged.
import { describe, expect, it } from 'vitest'

import exemplo from './__fixtures__/campanhas.exemplo.json'
import gabarito from './__fixtures__/campanhas.gabarito.json'
import gptTutor from './__fixtures__/campanhas.gpt-tutor.json'
import {
  type Campaign,
  campaignActivity,
  campaignCwd,
  parseCampaigns,
  registryPath,
  resumePrompt,
} from './campaigns'
import type { GitCheckouts } from './tauri/git'

const SITUATION_KIND = {
  done: 'concluida',
  waits: 'espera',
  running: 'em_execucao',
  ready: 'prontas',
  blocked: 'bloqueada',
} as const

function parse(registry: unknown): Campaign[] {
  const parsed = parseCampaigns(JSON.stringify(registry))
  if (!parsed || parsed.errors.length > 0) throw new Error(`invalid: ${JSON.stringify(parsed)}`)
  return parsed.campaigns
}

function byId(campaigns: Campaign[], id: string): Campaign {
  const found = campaigns.find((campaign) => campaign.id === id)
  if (!found) throw new Error(`missing ${id}`)
  return found
}

describe('parseCampaigns', () => {
  it('matches the campanhas.py gabarito field by field', () => {
    const campaigns = parse(exemplo)
    expect(
      campaigns.map((campaign) => ({
        id: campaign.id,
        concluidas: campaign.done,
        total: campaign.total,
        decomposta: campaign.decomposed,
        percentual: campaign.percent,
        situacao: {
          tipo: SITUATION_KIND[campaign.situation.kind],
          prontas: campaign.situation.ready,
          espera: campaign.situation.waits,
        },
        janela: campaign.window,
        noite: campaign.night,
        tarefas: campaign.tasks.map((task) => ({
          id: task.id,
          estado: task.state,
          janela: task.window,
          faltam: task.unmet,
        })),
      })),
    ).toEqual(gabarito.campanhas)
  })

  // Values printed by `campanhas.py listar` for the real registry this fixture was trimmed from.
  it.each([
    ['MOODLE-V1', 0, 4, true, 0, 'running', 0, []],
    ['MOTOR', 2, 10, true, 20, 'running', 2, []],
    ['PRODUTO', 0, 6, false, 0, 'ready', 1, []],
    ['INTEGRACAO', 2, 5, true, 40, 'ready', 1, []],
    ['WEB', 0, 4, false, 0, 'waits', 0, ['INTEGRACAO', 'MOTOR']],
    ['REPLAY-NOTURNO', 0, 2, true, 0, 'waits', 0, ['MOTOR-00', 'NOITE-03']],
  ])(
    'pins %s as campanhas.py lists it',
    (id, done, total, decomposed, percent, kind, ready, waits) => {
      const campaign = byId(parse(gptTutor), id)
      expect([campaign.done, campaign.total, campaign.decomposed, campaign.percent]).toEqual([
        done,
        total,
        decomposed,
        percent,
      ])
      expect(campaign.situation).toEqual({ kind, ready, waits })
    },
  )

  it('lists campaigns by priority and keeps the Portuguese text as written', () => {
    const campaigns = parse(gptTutor)
    expect(campaigns).toHaveLength(12)
    expect(campaigns[0].title).toBe('Campanha MOODLE-V1')
    expect(parse(exemplo)[0].title).toBe('Concluída, libera quem depende dela')
    expect(byId(campaigns, 'VOCAB').night).toBe(true)
  })

  it('refuses the whole registry when one task is invalid, like campanhas.py listar', () => {
    // Dropping SOLO-01 would leave SOLO done with no tasks and release AFTER.
    const parsed = parseCampaigns(
      JSON.stringify({
        campanhas: [
          {
            id: 'SOLO',
            prioridade: 1,
            janela: 'assistida',
            tarefas: [{ id: 'SOLO-01', estado: 'feita' }],
          },
          {
            id: 'AFTER',
            prioridade: 2,
            janela: 'assistida',
            depende_de: ['SOLO'],
            tarefas: [{ id: 'AFTER-01', estado: 'pronta' }],
          },
        ],
      }),
    )
    expect(parsed).toEqual({
      campaigns: [],
      errors: [{ kind: 'state', id: 'SOLO-01', detail: '"feita"' }],
    })
  })

  it('reports every error campanhas.py validar reports, plus malformed entries', () => {
    const parsed = parseCampaigns(
      JSON.stringify({
        campanhas: [
          {
            id: 'A',
            prioridade: 1,
            janela: 'tarde',
            depende_de: ['B'],
            tarefas: [
              { id: 'A-01', estado: 'pronta', janela: 'manhã' },
              { id: 'A-01', estado: 'pronta', depende_de: ['GONE'] },
              { estado: 'pronta' },
            ],
          },
          { id: 'B', prioridade: 2, janela: 'noite', depende_de: ['A'], tarefas: [] },
          'not a campaign',
        ],
      }),
    )
    expect(parsed?.campaigns).toEqual([])
    expect(parsed?.errors).toEqual(
      expect.arrayContaining([
        { kind: 'window', id: 'A', detail: '"tarde"' },
        { kind: 'window', id: 'A-01', detail: '"manhã"' },
        { kind: 'duplicate', id: 'A-01', detail: '' },
        { kind: 'malformed', id: 'A.tarefas[2]', detail: '' },
        { kind: 'malformed', id: 'campanhas[2]', detail: '' },
        { kind: 'dependency', id: 'A-01', detail: 'GONE' },
        { kind: 'cycle', id: 'A', detail: 'A → B → A' },
      ]),
    )
    expect(parsed?.errors).toHaveLength(7)
  })

  it('returns null for text that is not a registry', () => {
    expect(parseCampaigns('{')).toBeNull()
    expect(parseCampaigns('[]')).toBeNull()
    expect(parseCampaigns('{"campanhas": {}}')).toBeNull()
  })
})

describe('campaign checkouts', () => {
  const checkouts: GitCheckouts = {
    main: 'C:\\repo\\GPT-Tutor-Generator',
    worktrees: [
      {
        path: 'C:\\repo\\GPT-Tutor-Generator',
        branch: 'dev',
        lastCommitMs: Date.UTC(2026, 9, 2, 5),
      },
      {
        path: 'C:\\repo\\GPT-Tutor-Generator-p1',
        branch: 'p1',
        lastCommitMs: Date.UTC(2026, 9, 1),
      },
      {
        path: 'C:\\repo\\GPT-Tutor-Generator-cru05',
        branch: 'cru05',
        lastCommitMs: Date.UTC(2026, 9, 3, 12),
      },
    ],
  }

  it('opens the first listed worktree that git knows, else the main checkout', () => {
    const campaigns = parse(gptTutor)
    // MOODLE-V1 lists a worktree that is gone, then the main checkout.
    expect(campaignCwd(byId(campaigns, 'MOODLE-V1'), checkouts)).toBe(
      'C:\\repo\\GPT-Tutor-Generator',
    )
    expect(campaignCwd(byId(campaigns, 'MOTOR'), checkouts)).toBe(
      'C:\\repo\\GPT-Tutor-Generator-p1',
    )
    expect(campaignCwd(byId(campaigns, 'REGUA'), checkouts)).toBe('C:\\repo\\GPT-Tutor-Generator')
    expect(campaignCwd(byId(campaigns, 'REGUA'), { main: null, worktrees: [] })).toBeNull()
  })

  it('reports the most recently committed worktree and the latest of commit and atualizado_em', () => {
    const campaigns = parse(gptTutor)
    expect(campaignActivity(byId(campaigns, 'MOTOR'), checkouts)).toEqual({
      worktree: 'GPT-Tutor-Generator-cru05',
      extra: 1,
      updatedAt: Date.UTC(2026, 9, 3, 12),
      fromGit: true,
    })
    // atualizado_em is a local date; newer than any commit, it wins.
    expect(campaignActivity(byId(campaigns, 'REGUA'), checkouts)).toEqual({
      worktree: null,
      extra: 0,
      updatedAt: new Date(2026, 8, 23).getTime(),
      fromGit: false,
    })
  })

  it('builds a one-line resume prompt with absolute paths, since the agent starts in a worktree', () => {
    const campaigns = parse(gptTutor)
    const registry = registryPath('C:\\repo\\GPT-Tutor-Generator\\')
    expect(registry).toBe('C:\\repo\\GPT-Tutor-Generator\\.workflow\\campanhas.json')
    const handoff = 'C:\\repo\\GPT-Tutor-Generator\\docs\\reports\\handoff.md'
    expect(resumePrompt(byId(campaigns, 'VOCAB'), registry, handoff)).toBe(
      'Retome a campanha VOCAB (Campanha VOCAB) pelo registro ' +
        `${registry} e pelo handoff ${handoff}.`,
    )
    // A handoff that could not be found is passed on as written, with what it is relative to.
    expect(resumePrompt(byId(campaigns, 'VOCAB'), registry, null)).toBe(
      'Retome a campanha VOCAB (Campanha VOCAB) pelo registro ' +
        `${registry} e pelo handoff docs/reports/2026-09-26-handoff-regime-vocab-claude.md ` +
        '(relativo ao checkout principal).',
    )
    expect(resumePrompt(byId(campaigns, 'REGUA'), registry, null)).toBe(
      `Retome a campanha REGUA (Campanha REGUA) pelo registro ${registry}.`,
    )
    const [hostile] = parse({
      campanhas: [
        {
          id: 'X',
          titulo: 'a\nb\u001b[201~c',
          handoff: 'h\r.md',
          prioridade: 1,
          janela: 'noite',
          tarefas: [],
        },
      ],
    })
    expect(resumePrompt(hostile, '/repo/.workflow/campanhas.json', null)).toBe(
      'Retome a campanha X (a b [201~c) pelo registro /repo/.workflow/campanhas.json ' +
        'e pelo handoff h .md (relativo ao checkout principal).',
    )
  })
})
