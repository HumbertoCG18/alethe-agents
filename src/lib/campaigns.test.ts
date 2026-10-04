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
  campaignWorkers,
  checkedResult,
  evidenceIsPath,
  isoDay,
  liveTaskWorkers,
  nextTaskId,
  nightDiaryFiles,
  parseCampaigns,
  parseFindings,
  parseNightDiary,
  pathInside,
  registryPath,
  resumePrompt,
  setCampaignTaskState,
  taskLabel,
  validCampaignTitle,
  workflowPath,
} from './campaigns'
import type { GitCheckouts } from './tauri/git'
import type { OrchestratorJob } from './tauri/orchestrator'

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

  it('sets the evidence too, restores it, and leaves alone what it is not given', () => {
    const registry = structuredClone(exemplo)
    Object.assign(registry.campanhas[1].tarefas[2], { resultado: 'antes', evidencia: 'velha' })
    const done = setCampaignTaskState(
      JSON.stringify(registry),
      'OITO-03',
      'concluída',
      'x',
      today,
      'docs/e.md',
    )
    expect(done).toMatchObject({
      ok: true,
      previous: { state: 'pronta', result: 'antes', evidence: 'velha' },
    })
    if (!done.ok) return
    expect(written(done.content, 'OITO').campaign.tarefas[2]).toMatchObject({
      estado: 'concluída',
      resultado: 'x',
      evidencia: 'docs/e.md',
    })

    // `campanhas.py estado ID pronta`: only the state changes.
    const queued = setCampaignTaskState(done.content, 'OITO-03', 'pronta', undefined, today)
    expect(queued.ok && written(queued.content, 'OITO').campaign.tarefas[2]).toEqual({
      ...oito().tarefas[2],
      resultado: 'x',
      evidencia: 'docs/e.md',
    })

    const undone = setCampaignTaskState(done.content, 'OITO-03', 'pronta', null, today, null)
    expect(undone.ok && written(undone.content, 'OITO').campaign.tarefas[2]).toEqual(
      oito().tarefas[2],
    )
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

  it('places workflow files in the main checkout with its own separator', () => {
    expect(registryPath('C:\\repo\\')).toBe('C:\\repo\\.workflow\\campanhas.json')
    expect(workflowPath('/home/me/repo', 'local', 'noites')).toBe(
      '/home/me/repo/.workflow/local/noites',
    )
  })
})

describe('runs linked to registry tasks', () => {
  const registry = parseCampaigns(JSON.stringify(exemplo))!
  const checkouts: GitCheckouts = {
    main: 'C:\\repo',
    worktrees: [
      { path: 'C:\\repo', branch: 'dev', lastCommitMs: null },
      { path: 'C:\\repo-feature', branch: 'feature', lastCommitMs: null },
    ],
  }
  const job = (task: string | null, status: OrchestratorJob['status'], cwd = 'C:\\repo') => ({
    task,
    status,
    cwd,
  })

  it('compares folders by whole components, after resolving . and ..', () => {
    const inside: Array<[string, string]> = [
      ['C:\\repo', 'C:\\repo'],
      ['C:\\Repo\\src\\..\\docs\\x.md', 'c:\\repo\\'],
      ['C:/repo/./a', 'C:\\repo'],
      ['\\\\Server\\Share\\Repo\\x.md', '\\\\server\\share\\repo'],
      ['\\\\?\\C:\\repo\\a', 'C:\\repo'],
      ['C:\\x', 'C:\\'],
      ['/home/me/repo/a/../b', '/home/me/repo'],
    ]
    const outside: Array<[string, string]> = [
      ['C:\\repo\\..\\other', 'C:\\repo'],
      ['C:\\repository', 'C:\\repo'],
      ['\\\\server\\share\\other\\x.md', '\\\\server\\share\\repo'],
      ['\\\\server\\share\\repo\\..\\..\\other\\x', '\\\\server\\share\\repo'],
      ['D:\\repo\\x', 'C:\\repo'],
      ['C:\\..\\x', 'C:\\'],
      ['/home/me/Repo/a', '/home/me/repo'],
      ['docs/x.md', 'C:\\repo'],
      ['', 'C:\\repo'],
    ]
    for (const [path, root] of inside) {
      expect(pathInside(path, root), `${path} in ${root}`).toBe(true)
    }
    for (const [path, root] of outside) {
      expect(pathInside(path, root), `${path} in ${root}`).toBe(false)
    }
  })

  it('names the campaign of a task the registry lists, else the task alone', () => {
    expect(taskLabel('OITO-03', registry.campaigns)).toBe('OITO · OITO-03')
    expect(taskLabel('MOTOR-01', registry.campaigns)).toBe('MOTOR-01')
  })

  it('counts the running and queued workers of each task in the repository', () => {
    const workers = liveTaskWorkers(
      [
        job('OITO-02', 'running', 'C:\\Repo-Feature\\src'),
        // Stopped on a question, it still holds its slot.
        job('OITO-02', 'blocked'),
        job('OITO-03', 'queued', 'C:\\repo\\.alethe\\worktrees\\job-03'),
        job('OITO-03', 'done'),
        job('OITO-03', 'interrupted'),
        job('OITO-04', 'running', 'C:\\repository'),
        job('OITO-04', 'running', 'C:\\other'),
        job('OITO-04', 'running', 'C:\\repo\\..\\other'),
        job(null, 'running'),
      ],
      checkouts,
    )
    expect(Object.fromEntries(workers)).toEqual({
      'OITO-02': { running: 2, queued: 0 },
      'OITO-03': { running: 0, queued: 1 },
    })
    expect(campaignWorkers(['OITO-01', 'OITO-02', 'OITO-03'], workers)).toEqual({
      running: 2,
      queued: 1,
    })
    expect(campaignWorkers(['BASE-01'], workers)).toEqual({ running: 0, queued: 0 })
  })
})

describe('night diary', () => {
  const diary = {
    data: '2026-10-03',
    entradas: [
      {
        tarefa: 'MOTOR-01',
        resultado: 'aguarda-voce',
        resumo: 'Gate 2 pendente',
        evidencia: 'docs/motor.md',
        hora: '03:41',
      },
      { tarefa: 'MOTOR-02', resultado: 'ok', resumo: 'feito', evidencia: 'a1b2c3d', hora: '04:10' },
    ],
  }

  it('reads the date and every entry in order', () => {
    expect(parseNightDiary(JSON.stringify(diary))).toEqual({
      date: '2026-10-03',
      entries: [
        {
          task: 'MOTOR-01',
          result: 'aguarda-voce',
          summary: 'Gate 2 pendente',
          evidence: 'docs/motor.md',
          time: '03:41',
        },
        { task: 'MOTOR-02', result: 'ok', summary: 'feito', evidence: 'a1b2c3d', time: '04:10' },
      ],
    })
  })

  it('ignores malformed entries and refuses a malformed file', () => {
    const mixed = {
      ...diary,
      entradas: [
        ...diary.entradas,
        { tarefa: 'MOTOR-03', resultado: 'talvez' },
        { resultado: 'ok' },
        'MOTOR-04',
        null,
        { tarefa: 'MOTOR-05', resultado: 'parou', resumo: 7 },
      ],
    }
    expect(parseNightDiary(JSON.stringify(mixed))?.entries.map((entry) => entry.task)).toEqual([
      'MOTOR-01',
      'MOTOR-02',
      'MOTOR-05',
    ])
    expect(parseNightDiary(JSON.stringify(mixed))?.entries[2].summary).toBe('')
    for (const text of [
      '{',
      'null',
      '[]',
      JSON.stringify({ data: '03/10/2026', entradas: [] }),
      JSON.stringify({ data: '2026-10-03' }),
      JSON.stringify({ data: '2026-10-03', entradas: {} }),
    ]) {
      expect(parseNightDiary(text)).toBeNull()
    }
  })

  it('lists the diary files newest first, by their dated names', () => {
    const entry = (name: string, isDir = false) => ({
      name,
      path: `C:\\n\\${name}`,
      is_dir: isDir,
      size: null,
    })
    expect(
      nightDiaryFiles([
        entry('2026-10-01.json'),
        entry('2026-10-03.json'),
        entry('notas.txt'),
        entry('2026-10-04.json', true),
        entry('2026-10-02.JSON'),
      ]),
    ).toEqual(['C:\\n\\2026-10-03.json', 'C:\\n\\2026-10-02.JSON', 'C:\\n\\2026-10-01.json'])
  })

  it('treats evidence with a folder or a file extension as a path, and anything else as text', () => {
    for (const path of ['docs/motor.md', 'C:\\repo\\x.json', 'README.md', '/tmp/log']) {
      expect(evidenceIsPath(path), path).toBe(true)
    }
    for (const text of ['a1b2c3d', 'https://github.com/x/y/pull/4', 'PR 12', '', 'see docs/x.md']) {
      expect(evidenceIsPath(text), text).toBe(false)
    }
  })
})

describe('parseFindings', () => {
  const finding = (fields: Record<string, unknown>) => ({
    id: 'ACH-0001',
    data: '2026-10-03',
    tipo: 'bug',
    titulo: 'Title',
    origem: 'MOTOR-01',
    detalhe: 'docs/x.md',
    estado: 'novo',
    ...fields,
  })
  const file = (achados: unknown[]) => JSON.stringify({ versao: 1, achados })

  it('reads a valid finding', () => {
    expect(parseFindings(file([finding({})]))).toEqual([
      {
        id: 'ACH-0001',
        date: '2026-10-03',
        type: 'bug',
        title: 'Title',
        origin: 'MOTOR-01',
        detail: 'docs/x.md',
      },
    ])
  })

  it('returns nothing for text that is not a findings file', () => {
    for (const source of ['', '{', 'null', '[]', '{"achados": 3}', '{"versao":1}']) {
      expect(parseFindings(source), source).toEqual([])
    }
  })

  it('ignores malformed entries and keeps the valid ones', () => {
    const list = parseFindings(
      file([
        null,
        'x',
        finding({ id: '' }),
        finding({ id: 'ACH-0002', tipo: 'talvez' }),
        finding({ id: 'ACH-0003', titulo: '' }),
        finding({ id: 'ACH-0004', data: 'ontem' }),
        finding({ id: 'ACH-0005', origem: undefined, detalhe: 7 }),
      ]),
    )
    expect(list).toEqual([
      {
        id: 'ACH-0005',
        date: '2026-10-03',
        type: 'bug',
        title: 'Title',
        origin: '',
        detail: '',
      },
    ])
  })

  it('keeps only new findings', () => {
    const list = parseFindings(
      file([
        finding({ id: 'ACH-0001', estado: 'virou-tarefa' }),
        finding({ id: 'ACH-0002', estado: 'descartado' }),
        finding({ id: 'ACH-0003' }),
        finding({ id: 'ACH-0004', estado: 'other' }),
      ]),
    )
    expect(list.map((item) => item.id)).toEqual(['ACH-0003'])
  })

  it('orders newest date first, then by id', () => {
    const list = parseFindings(
      file([
        finding({ id: 'ACH-0003', data: '2026-10-01' }),
        finding({ id: 'ACH-0002', data: '2026-10-03' }),
        finding({ id: 'ACH-0001', data: '2026-10-02' }),
        finding({ id: 'ACH-0004', data: '2026-10-03' }),
      ]),
    )
    expect(list.map((item) => item.id)).toEqual(['ACH-0002', 'ACH-0004', 'ACH-0001', 'ACH-0003'])
  })
})

describe('untrusted findings and diary input', () => {
  it('drops impossible calendar dates', () => {
    const finding = (data: string) => ({
      id: 'ACH-0001',
      data,
      tipo: 'bug',
      titulo: 'T',
      estado: 'novo',
    })
    expect(parseFindings(JSON.stringify({ achados: [finding('2026-02-31')] }))).toEqual([])
    expect(parseFindings(JSON.stringify({ achados: [finding('2026-13-01')] }))).toEqual([])
    expect(parseFindings(JSON.stringify({ achados: [finding('2028-02-29')] }))).toHaveLength(1)
    expect(parseNightDiary('{"data":"2026-02-31","entradas":[]}')).toBeNull()
    expect(parseNightDiary('{"data":"2026-02-28","entradas":[]}')).not.toBeNull()
  })

  it('does not parse a file over 1 MB', () => {
    const entry = { id: 'ACH-0001', data: '2026-10-03', tipo: 'bug', titulo: 'T', estado: 'novo' }
    const small = JSON.stringify({ achados: [entry] })
    expect(parseFindings(small)).toHaveLength(1)
    expect(parseFindings(small.replace('"T"', `"${'x'.repeat(1_000_001)}"`))).toEqual([])
  })
})

describe('checkedResult', () => {
  it('says when the task was checked here and keeps what it already said', () => {
    expect(checkedResult(null, '2026-10-04')).toBe('marcada no Alethe em 2026-10-04')
    expect(checkedResult('', '2026-10-04')).toBe('marcada no Alethe em 2026-10-04')
    expect(checkedResult('medido: 350/350 = 87', '2026-10-04')).toBe(
      'marcada no Alethe em 2026-10-04; medido: 350/350 = 87',
    )
  })

  it('drops a "waiting for the Gate 2" note that the check answers', () => {
    expect(
      checkedResult(
        'aguarda o Gate 2 do usuário: integração A+P1 verificada (350/350 = 87)',
        '2026-10-04',
      ),
    ).toBe('marcada no Alethe em 2026-10-04; integração A+P1 verificada (350/350 = 87)')
    expect(checkedResult('aguarda o Gate 2 do usuário', '2026-10-04')).toBe(
      'marcada no Alethe em 2026-10-04',
    )
    expect(checkedResult('aguarda o Gate 2 do usuário (PR #61)', '2026-10-04')).toBe(
      'marcada no Alethe em 2026-10-04; (PR #61)',
    )
  })
})
