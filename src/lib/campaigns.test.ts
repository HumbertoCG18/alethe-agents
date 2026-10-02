// Contract with agent-workflow-lab/bin/campanhas.py. When a rule changes there, regenerate the
// gabarito in the lab with
//   python bin/campanhas.py listar --json --registro bin/fixtures/campanhas.exemplo.json
// and copy both bin/fixtures/campanhas.exemplo.json and campanhas.gabarito.json here unchanged.
import { describe, expect, it } from 'vitest'

import exemplo from './__fixtures__/campanhas.exemplo.json'
import gabarito from './__fixtures__/campanhas.gabarito.json'
import gptTutor from './__fixtures__/campanhas.gpt-tutor.json'
import {
  activeCampaign,
  addCampaignTask,
  type Campaign,
  campaignActivity,
  campaignCwd,
  campaignTaskView,
  isoDay,
  nextTaskId,
  parseCampaigns,
  registryPath,
  resumePrompt,
  setCampaignTaskState,
  validCampaignTitle,
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
    const ids = new Set(
      campaigns.flatMap((campaign) => [campaign.id, ...campaign.tasks.map((task) => task.id)]),
    )
    expect(
      campaigns.map((campaign) => ({
        id: campaign.id,
        proxima_tarefa: nextTaskId(
          campaign.id,
          campaign.tasks.map((task) => task.id),
          ids,
        ),
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

  describe('activeCampaign', () => {
    const campaigns = parse(gptTutor)
    const active = (tab: { campaignId?: string; cwd: string } | null, remembered: string | null) =>
      activeCampaign(campaigns, checkouts, tab, remembered)

    it('takes the campaign a tab was opened for over the one its cwd belongs to', () => {
      expect(active({ campaignId: 'REGUA', cwd: 'C:\\repo\\GPT-Tutor-Generator-p1' }, null)).toBe(
        'REGUA',
      )
      // A tag naming a campaign no longer in the registry falls back to the cwd.
      expect(active({ campaignId: 'GONE', cwd: 'C:\\repo\\GPT-Tutor-Generator-p1' }, null)).toBe(
        'MOTOR',
      )
    })

    it('matches a cwd through the checkouts git lists, from any folder inside one', () => {
      expect(active({ cwd: 'c:/repo/GPT-Tutor-Generator-cru05/src/' }, 'VOCAB')).toBe('MOTOR')
      // Same folder name, but not a checkout of this repository.
      expect(active({ cwd: 'D:\\elsewhere\\GPT-Tutor-Generator-p1' }, null)).toBeNull()
    })

    it('matches the main checkout only to campaigns that list it, preferring the remembered one', () => {
      const main = { cwd: 'C:\\repo\\GPT-Tutor-Generator' }
      expect(active(main, null)).toBe('MOODLE-V1')
      expect(active(main, 'VOCAB')).toBe('VOCAB')
      // REGUA lists no worktree and resumes in the main checkout, but does not claim it.
      expect(active(main, 'REGUA')).toBe('MOODLE-V1')
    })

    it('falls back to the remembered campaign, and to none when nothing matches', () => {
      expect(active(null, 'REGUA')).toBe('REGUA')
      expect(active({ cwd: 'D:\\notes' }, 'REGUA')).toBe('REGUA')
      expect(active({ cwd: 'D:\\notes' }, null)).toBeNull()
      expect(active(null, 'GONE')).toBeNull()
    })

    it('compares whole folder names, ignoring case and separators on Windows', () => {
      const listed = parse({
        campanhas: [
          { id: 'MAIN', prioridade: 1, janela: 'assistida', worktrees: ['repo'], tarefas: [] },
          {
            id: 'FEAT',
            prioridade: 2,
            janela: 'assistida',
            worktrees: ['REPO-FEATURE/'],
            tarefas: [],
          },
        ],
      })
      // git lists Windows checkouts with forward slashes.
      const git: GitCheckouts = {
        main: 'C:/repo',
        worktrees: [
          { path: 'C:/repo', branch: 'dev', lastCommitMs: null },
          { path: 'C:/repo-feature', branch: 'feature', lastCommitMs: null },
        ],
      }
      const inFeature = { cwd: 'C:\\repo-feature\\src' }
      expect(activeCampaign(listed, git, inFeature, null)).toBe('FEAT')
      // `repo` names the main checkout only, not a folder whose name starts with it.
      expect(activeCampaign(listed, git, inFeature, 'MAIN')).toBe('FEAT')
      expect(activeCampaign(listed, git, { cwd: 'c:\\REPO\\src' }, null)).toBe('MAIN')
      expect(campaignCwd(byId(listed, 'FEAT'), git)).toBe('C:/repo-feature')
    })
  })
})

const today = '2026-10-02'
const oito = () => structuredClone(exemplo).campanhas.find((campaign) => campaign.id === 'OITO')!

/** The registry `content` parsed back, and its campaign `id`. */
function written(content: string, id: string) {
  const data = JSON.parse(content) as typeof exemplo
  return { data, campaign: data.campanhas.find((campaign) => campaign.id === id)! }
}

describe('nextTaskId', () => {
  it('follows campanhas.py: largest numeric suffix of the campaign plus one, two digits at least', () => {
    expect(nextTaskId('X', [], new Set())).toBe('X-01')
    expect(nextTaskId('X', ['X-01', 'X-07', 'X-03'], new Set())).toBe('X-08')
    expect(nextTaskId('X', ['X-99'], new Set())).toBe('X-100')
    expect(nextTaskId('X', ['X-009'], new Set())).toBe('X-10')
  })

  it('counts only ids shaped <CAMPAIGN>-<digits>', () => {
    expect(nextTaskId('X', ['X-01', 'X-07a', 'XY-09', 'X-', 'Y-05'], new Set())).toBe('X-02')
    // The campaign id is matched literally, not as a pattern.
    expect(nextTaskId('A.B', ['A.B-01', 'AxB-05'], new Set())).toBe('A.B-02')
  })

  it('never reuses an id taken anywhere in the registry', () => {
    expect(nextTaskId('X', ['X-01'], new Set(['X-01', 'X-02', 'X-03']))).toBe('X-04')
  })
})

describe('addCampaignTask', () => {
  it('appends a proposed USER task with the next id, dates the campaign and stays valid', () => {
    const result = addCampaignTask(JSON.stringify(exemplo), 'OITO', '  Nova tarefa  ', today)
    expect(result).toMatchObject({ ok: true, id: 'OITO-09' })
    if (!result.ok) return
    const { data, campaign } = written(result.content, 'OITO')
    const added = campaign.tarefas.at(-1)!
    // Same keys, in the same order, as `campanhas.py tarefa` writes them.
    expect(Object.entries(added)).toEqual([
      ['id', 'OITO-09'],
      ['titulo', 'Nova tarefa'],
      ['estado', 'proposta'],
      ['depende_de', []],
      ['origem', 'USER'],
    ])
    expect(campaign.atualizado_em).toBe(today)
    expect(data.campanhas[0].atualizado_em).toBe('2026-10-01')
    expect(parseCampaigns(result.content)?.errors).toEqual([])
    expect(result.content).toBe(`${JSON.stringify(data, null, 2)}\n`)
  })

  it('takes titles of 1 to 140 characters, refusing only control characters and line breaks', () => {
    const source = JSON.stringify(exemplo)
    for (const title of [
      '',
      '   ',
      'a'.repeat(141),
      'line\nbreak',
      'tab\there',
      'a\u2028b',
      'a\u2029b',
    ]) {
      expect(addCampaignTask(source, 'OITO', title, today)).toEqual({ ok: false, error: 'title' })
    }
    // Code points, not UTF-16 units; a no-break space and a ZWJ emoji are text.
    for (const title of ['a'.repeat(140), '😀'.repeat(140), 'a\u00a0b', '👩‍💻 deploy']) {
      expect(addCampaignTask(source, 'OITO', title, today)).toMatchObject({ ok: true })
    }
  })

  it('refuses a title the campaign already has, ignoring case, naming the task', () => {
    expect(addCampaignTask(JSON.stringify(exemplo), 'OITO', ' PROPOSTA ', today)).toEqual({
      ok: false,
      error: 'duplicate',
      id: 'OITO-06',
    })
    // Another campaign's title is no duplicate.
    expect(addCampaignTask(JSON.stringify(exemplo), 'PARADA', 'proposta', today)).toMatchObject({
      ok: true,
      id: 'PARADA-02',
    })
  })

  it('refuses an unknown campaign and a registry that would be invalid', () => {
    expect(addCampaignTask(JSON.stringify(exemplo), 'GONE', 'x', today)).toEqual({
      ok: false,
      error: 'missing',
    })
    const broken = structuredClone(exemplo)
    broken.campanhas[0].tarefas[0].estado = 'feita'
    expect(addCampaignTask(JSON.stringify(broken), 'OITO', 'x', today)).toEqual({
      ok: false,
      error: 'invalid',
    })
  })
})

describe('setCampaignTaskState', () => {
  it('marks a task done in Alethe, and the previous state puts it back as it was', () => {
    const done = setCampaignTaskState(
      JSON.stringify(exemplo),
      'OITO-03',
      'concluída',
      'marcada no Alethe',
      today,
    )
    expect(done).toMatchObject({ ok: true, previous: { state: 'pronta', result: null } })
    if (!done.ok) return
    const { campaign } = written(done.content, 'OITO')
    expect(campaign.tarefas[2]).toEqual({
      ...oito().tarefas[2],
      estado: 'concluída',
      resultado: 'marcada no Alethe',
    })
    expect(campaign.atualizado_em).toBe(today)

    const undone = setCampaignTaskState(
      done.content,
      'OITO-03',
      done.previous.state,
      done.previous.result,
      today,
    )
    expect(undone.ok && written(undone.content, 'OITO').campaign.tarefas[2]).toEqual(
      oito().tarefas[2],
    )
  })

  it('keeps a result the task already had when it is restored', () => {
    const registry = structuredClone(exemplo)
    Object.assign(registry.campanhas[1].tarefas[2], { resultado: 'antes' })
    const done = setCampaignTaskState(JSON.stringify(registry), 'OITO-03', 'concluída', 'x', today)
    expect(done).toMatchObject({ ok: true, previous: { state: 'pronta', result: 'antes' } })
  })

  it('refuses a task the registry does not have', () => {
    expect(
      setCampaignTaskState(JSON.stringify(exemplo), 'GONE-01', 'concluída', null, today),
    ).toEqual({ ok: false, error: 'missing' })
  })
})

describe('campaignTaskView', () => {
  const tasks = parse({
    campanhas: [
      {
        id: 'X',
        prioridade: 1,
        janela: 'assistida',
        tarefas: [
          { id: 'X-100', estado: 'pronta' },
          { id: 'X-02', estado: 'bloqueada' },
          { id: 'X-03', estado: 'concluída' },
          { id: 'X-04', estado: 'proposta' },
          { id: 'X-05', estado: 'reservada' },
          { id: 'X-06', estado: 'em execução' },
          { id: 'X-99', estado: 'pronta' },
          { id: 'X-01', estado: 'concluída' },
        ],
      },
    ],
  })[0].tasks
  const ids = (filter: 'all' | 'active' | 'completed') =>
    campaignTaskView(tasks, filter).map((task) => task.id)

  it('lists the open tasks by state (in progress, ready, reserved, proposed, blocked), then by id', () => {
    expect(ids('active')).toEqual(['X-06', 'X-99', 'X-100', 'X-05', 'X-04', 'X-02'])
  })

  it('lists only the done tasks under Completed, and everything under All', () => {
    expect(ids('completed')).toEqual(['X-01', 'X-03'])
    expect(ids('all')).toEqual(['X-06', 'X-99', 'X-100', 'X-05', 'X-04', 'X-02', 'X-01', 'X-03'])
  })
})

describe('registry helpers', () => {
  it('measures titles in code points, as the composer checks them', () => {
    expect(validCampaignTitle('😀'.repeat(140))).toBe(true)
    expect(validCampaignTitle('😀'.repeat(141))).toBe(false)
    expect(validCampaignTitle('')).toBe(false)
  })

  it('dates writes with the local calendar day, as campanhas.py does', () => {
    expect(isoDay(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
  })
})
