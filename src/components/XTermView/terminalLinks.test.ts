import { describe, expect, it, vi } from 'vitest'

import {
  detectTerminalLinks,
  getLogicalTerminalLine,
  locateTerminalPath,
  relativeTerminalPath,
  resolveTerminalFilePath,
  terminalLinkRange,
  terminalRowsAround,
  wrappedPathCandidates,
} from './terminalLinks'

describe('terminal links', () => {
  it('ends URLs at whitespace while preserving spaces inside local paths', () => {
    expect(detectTerminalLinks('https://github.com/login/device in your browser...')).toEqual([
      expect.objectContaining({
        text: 'https://github.com/login/device',
        displayLength: 'https://github.com/login/device'.length,
      }),
    ])
    expect(detectTerminalLinks('(https://github.com/login/device in your browser)')[0].text).toBe(
      'https://github.com/login/device',
    )
    expect(detectTerminalLinks('D:\\public launch\\src\\file.ts')).toEqual([
      expect.objectContaining({ text: 'D:\\public launch\\src\\file.ts', kind: 'path' }),
    ])
    expect(
      detectTerminalLinks('"D:\\tmp\\shot-lab-strips\\ um PNG por shot, nome = slug."')[0],
    ).toEqual(
      expect.objectContaining({
        text: 'D:\\tmp\\shot-lab-strips\\',
        target: 'D:\\tmp\\shot-lab-strips\\',
        kind: 'path',
      }),
    )
  })

  it('detects mixed-case protocols and bare deployment domains', () => {
    const links = detectTerminalLinks(
      'Deploy em verzel-elite-dev-painel.vercel.app (Https://verzel-elite-dev-painel.vercel.app).',
    )

    expect(links).toEqual([
      expect.objectContaining({
        text: 'verzel-elite-dev-painel.vercel.app',
        target: 'https://verzel-elite-dev-painel.vercel.app',
        kind: 'url',
      }),
      expect.objectContaining({
        text: 'Https://verzel-elite-dev-painel.vercel.app',
        target: 'https://verzel-elite-dev-painel.vercel.app',
        kind: 'url',
      }),
    ])
    expect(detectTerminalLinks('localhost:5173/dashboard')[0]).toEqual(
      expect.objectContaining({ target: 'http://localhost:5173/dashboard', kind: 'url' }),
    )
  })

  it('reconstructs viewport-wrapped lines and creates a multiline range', () => {
    const values = [
      { value: 'go https:/', isWrapped: false },
      { value: '/example.c', isWrapped: true },
      { value: 'om/docs', isWrapped: true },
    ]
    const buffer = {
      length: values.length,
      getLine: (index: number) => {
        const line = values[index]
        return line ? { isWrapped: line.isWrapped, translateToString: () => line.value } : undefined
      },
    }

    const logicalLine = getLogicalTerminalLine(buffer, 2)
    expect(logicalLine).toEqual({ text: 'go https://example.com/docs', startLine: 1 })
    const [link] = detectTerminalLinks(logicalLine!.text)
    expect(terminalLinkRange(logicalLine!.startLine, 10, link)).toEqual({
      start: { x: 4, y: 1 },
      end: { x: 7, y: 3 },
    })
  })

  it('keeps escaped spaces in the visual range and unescapes the opened path', () => {
    const [link] = detectTerminalLinks('/tmp/my\\ file/readme.md')
    expect(link.text).toBe('/tmp/my file/readme.md')
    expect(link.displayLength).toBe('/tmp/my\\ file/readme.md'.length)
    expect(link.fileKind).toBe('markdown')
  })

  it('classifies path links by extension', () => {
    expect(detectTerminalLinks('/tmp/shot.png')[0].fileKind).toBe('image')
    expect(detectTerminalLinks('/tmp/main.ts:42:10')[0].fileKind).toBe('text')
    expect(detectTerminalLinks('/tmp/notes.md')[0].fileKind).toBe('markdown')
    expect(detectTerminalLinks('/tmp/trailer.mp4')[0].fileKind).toBe('video')
    expect(
      detectTerminalLinks(
        'Jogado em D:\\kauam\\Vaults\\Nostromo\\40-Conteudo\\youtube\\projecao-canal.md com as duas projeções',
      )[0].text,
    ).toBe('D:\\kauam\\Vaults\\Nostromo\\40-Conteudo\\youtube\\projecao-canal.md')
    expect(
      detectTerminalLinks('D:\\kauam\\Videos\\motion-kit-hype-video.mp4 e escuta')[0].text,
    ).toBe('D:\\kauam\\Videos\\motion-kit-hype-video.mp4')
    expect(detectTerminalLinks('https://example.com/x')[0].fileKind).toBeUndefined()
  })

  it('detects relative files printed by coding agents', () => {
    expect(detectTerminalLinks('Updated README.md')[0]).toEqual(
      expect.objectContaining({ text: 'README.md', kind: 'path', fileKind: 'markdown' }),
    )
    expect(detectTerminalLinks('See src/components/App.tsx:42')[0]).toEqual(
      expect.objectContaining({
        text: 'src/components/App.tsx:42',
        kind: 'path',
        fileKind: 'text',
      }),
    )
    expect(detectTerminalLinks('user@example.com')).toEqual([])
  })

  it('resolves relative agent links from the terminal working directory', () => {
    expect(resolveTerminalFilePath('README.md', 'D:\\repo')).toBe('D:\\repo\\README.md')
    expect(resolveTerminalFilePath('./docs/README.md:12', '/workspace/repo')).toBe(
      '/workspace/repo/docs/README.md',
    )
    expect(resolveTerminalFilePath('D:\\repo\\README.md', 'D:\\other')).toBe('D:\\repo\\README.md')
  })

  // `~\` is how Windows shells and agents print home paths (#237).
  it('resolves a home prefix from the home folder instead of the terminal folder', () => {
    const [link] = detectTerminalLinks(
      'em ~\\Desktop\\para-gpt\\validacao_externa_29-09.zip (sha256 e5de322d)',
    )
    expect(link.text).toBe('~\\Desktop\\para-gpt\\validacao_externa_29-09.zip')
    expect(resolveTerminalFilePath(link.target, 'C:\\repo', 'C:\\Users\\me')).toBe(
      'C:\\Users\\me\\Desktop\\para-gpt\\validacao_externa_29-09.zip',
    )
    expect(resolveTerminalFilePath('~/notes.md:3', '/work/repo', '/home/me/')).toBe(
      '/home/me/notes.md',
    )
    expect(resolveTerminalFilePath('~', 'C:\\repo', 'C:\\Users\\me')).toBe('C:\\Users\\me')
    // Until the home folder is known, the path is kept as printed rather than joined to the cwd.
    expect(resolveTerminalFilePath('~\\notes.md', 'C:\\repo')).toBe('~\\notes.md')
    expect(resolveTerminalFilePath('~other\\notes.md', 'C:\\repo', 'C:\\Users\\me')).toBe(
      'C:\\repo\\~other\\notes.md',
    )
  })

  it('ends a Windows home path where a `~/` path would end', () => {
    expect(detectTerminalLinks('~\\projetos\\alethe roda em dev')[0].text).toBe(
      '~\\projetos\\alethe',
    )
    expect(
      detectTerminalLinks('~\\projects\\alethe ~\\Desktop\\notes.md').map((link) => link.text),
    ).toEqual(['~\\projects\\alethe', '~\\Desktop\\notes.md'])
    expect(detectTerminalLinks('~\\Desktop\\ see readme.md').map((link) => link.text)).toEqual([
      '~\\Desktop\\',
      'readme.md',
    ])
  })

  it('keeps the printed relative path so it can be looked up in other worktrees', () => {
    expect(relativeTerminalPath('./docs/report.md:12')).toBe('docs/report.md')
    expect(relativeTerminalPath('repo-feature\\docs\\report.md')).toBe(
      'repo-feature\\docs\\report.md',
    )
    expect(relativeTerminalPath('D:\\repo\\README.md')).toBeNull()
    expect(relativeTerminalPath('/workspace/README.md')).toBeNull()
    expect(relativeTerminalPath('~/notes.md')).toBeNull()
  })

  it('stops an extensionless path at the first space instead of eating the sentence', () => {
    const [link] = detectTerminalLinks(
      '/pt-br/vitrine-dupla/trajetoria — 5 variações de trajetória',
    )
    expect(link.text).toBe('/pt-br/vitrine-dupla/trajetoria')

    expect(detectTerminalLinks('/api/users retorna 401 quando o token expira')[0].text).toBe(
      '/api/users',
    )
    expect(detectTerminalLinks('~/projetos/alethe roda em dev e em prod')[0].text).toBe(
      '~/projetos/alethe',
    )
  })

  it('still crosses a space when a file extension is waiting on the other side', () => {
    expect(detectTerminalLinks('/tmp/my folder/readme.md')[0].text).toBe('/tmp/my folder/readme.md')
    expect(detectTerminalLinks('D:\\public launch\\src\\file.ts')[0].text).toBe(
      'D:\\public launch\\src\\file.ts',
    )
  })

  it('does not turn prose slashes into links', () => {
    expect(detectTerminalLinks('/ Zambia / India')).toEqual([])
    expect(detectTerminalLinks('IP residencial/mobile + UA')).toEqual([])
    expect(detectTerminalLinks('foo/bar')).toEqual([])
    expect(
      detectTerminalLinks('src/file.ts package.json user@example.com').map((link) => link.text),
    ).toEqual(['src/file.ts', 'package.json'])
  })

  it('keeps two bracketed paths apart instead of linking the whole parenthetical', () => {
    expect(
      detectTerminalLinks('(/pt-br/vitrine-dupla/projetos e /en/double-showcase/projects)').map(
        (link) => link.text,
      ),
    ).toEqual(['/pt-br/vitrine-dupla/projetos', '/en/double-showcase/projects'])
  })

  it('still stops a bracketed path at the closing bracket', () => {
    expect(detectTerminalLinks('see (/tmp/my folder/readme.md) now')[0].text).toBe(
      '/tmp/my folder/readme.md',
    )
  })
})

// Claude Code wraps long lines itself, moving the cursor, so xterm sees separate rows and the link
// stops at the row end (#54).
describe('paths wrapped by the TUI', () => {
  // The rows around `rows[at]`, whose first link is the clicked one.
  const candidates = (rows: string[], at = 0) =>
    wrappedPathCandidates(detectTerminalLinks(rows[at])[0], {
      above: rows.slice(0, at).reverse(),
      line: [rows[at]],
      below: rows.slice(at + 1),
    })
  // Rows as xterm keeps them, `true` when soft-wrapped: a wide glyph is one character of the text.
  const bufferOf = (...values: Array<[string, boolean?]>) => ({
    length: values.length,
    getLine: (index: number) =>
      values[index] && {
        isWrapped: Boolean(values[index][1]),
        translateToString: () => values[index][0],
      },
  })
  // The candidates for the first link on buffer row `at`, read as the link provider reads them.
  const fromBuffer = (buffer: ReturnType<typeof bufferOf>, at: number) => {
    const logical = getLogicalTerminalLine(buffer, at + 1)!
    const [link] = detectTerminalLinks(logical.text)
    return wrappedPathCandidates(link, terminalRowsAround(buffer, logical))
  }
  // The prompt of #54, printed by Claude Code in a pane 69 columns wide.
  const prompt = [
    '  dev) e um handoff curto em',
    '        GPT-Tutor-Generator-noite/docs/reports/2026-10-03-piloto-noi',
    '  te/handoff.md, com uma seção por tarefa',
  ]
  const promptPath = 'GPT-Tutor-Generator-noite/docs/reports/2026-10-03-piloto-noite/handoff.md'

  it('offers the path joined with the leading token of the next row', () => {
    expect(
      candidates([
        '  Escrevi C:\\repo\\docs\\reports\\2026-10-03-piloto-noi',
        '  te\\handoff.md, com uma seção nova',
        '  mais texto',
      ]),
    ).toEqual(['C:\\repo\\docs\\reports\\2026-10-03-piloto-noite\\handoff.md'])
  })

  it('joins a third row only when the second is all path', () => {
    expect(
      candidates([
        'em /work/repo/docs/reports/2026-10-0',
        '   3-piloto-noite/handoffs/abcdefghi',
        '   j/handoff.md.',
      ]),
    ).toEqual([
      '/work/repo/docs/reports/2026-10-03-piloto-noite/handoffs/abcdefghi',
      '/work/repo/docs/reports/2026-10-03-piloto-noite/handoffs/abcdefghij/handoff.md',
    ])
  })

  it('keeps a dot the row cut right after', () => {
    expect(candidates(['C:\\repo\\docs\\handoff.', '  md agora'])).toEqual([
      'C:\\repo\\docs\\handoff.md',
    ])
  })

  // The clicked half is the second one when the first does not look like a path on its own.
  it('offers the path joined with the end of the row above', () => {
    // The row above is all path, so the one above it is tried too: `emGPT-...`, which no disk has.
    expect(candidates(prompt, 2)).toEqual([promptPath, `em${promptPath}`])
    // The same rows soft-wrapped by the terminal, padded to the width.
    const padded = bufferOf([prompt[0].padEnd(69)], [prompt[1].padEnd(69), true], [prompt[2], true])
    expect(fromBuffer(padded, 2)[0]).toBe(promptPath)
  })

  // Rows placed by the cursor stay apart when the pane is widened; no width is involved.
  it('still rebuilds the path after the pane is widened', () => {
    const rows = bufferOf(...prompt.map((row): [string] => [row]))
    expect(fromBuffer(rows, 2)[0]).toBe(promptPath)
  })

  // Five wide glyphs fill ten columns with five characters, apart or soft-wrapped.
  it('rebuilds a path cut on a row with wide glyphs', () => {
    const wide = '界界界界界 abcdef/no'
    expect(fromBuffer(bufferOf([wide], ['  i/hand.md']), 1)).toEqual(['abcdef/noi/hand.md'])
    expect(fromBuffer(bufferOf([wide], ['  i/hand.md', true]), 1)).toEqual(['abcdef/noi/hand.md'])
  })

  it('offers nothing when the path does not reach the row end or nothing follows', () => {
    expect(candidates(['C:\\repo\\a.md e mais', '  texto'])).toEqual([])
    expect(candidates(['C:\\repo\\docs\\reports', '', '  texto'])).toEqual([])
    expect(candidates(['C:\\repo\\docs\\reports', '  `code`'])).toEqual([])
    expect(candidates(['https://example.com/docs', '  more'])).toEqual([])
  })
})

describe('locating a clicked path', () => {
  const lookup = (found: Record<string, string>) =>
    vi.fn(async (_cwd: string, path: string) => found[path] ?? null)
  // Every path given exists, where it was printed.
  const everything = vi.fn(async (_cwd: string, path: string) => path)
  const linkAt = (rows: string[], at: number) => {
    const link = detectTerminalLinks(rows[at])[0]
    const around = {
      above: rows.slice(0, at).reverse(),
      line: [rows[at]],
      below: rows.slice(at + 1),
    }
    return { ...link, wrapped: wrappedPathCandidates(link, around) }
  }

  it('looks an absolute path up too, so another checkout can hold it', async () => {
    const find = lookup({ 'C:\\repo\\docs\\x.md': 'C:\\repo-noite\\docs\\x.md' })
    const [link] = detectTerminalLinks('C:\\repo\\docs\\x.md')
    await expect(locateTerminalPath(link, 'C:\\repo', null, find)).resolves.toEqual({
      target: 'C:\\repo-noite\\docs\\x.md',
      fileKind: 'markdown',
    })
    expect(find).toHaveBeenCalledWith('C:\\repo', 'C:\\repo\\docs\\x.md')
  })

  it('keeps looking a relative path up as printed', async () => {
    const find = lookup({ 'docs/x.md': 'C:\\repo-noite\\docs\\x.md' })
    const [link] = detectTerminalLinks('./docs/x.md:12')
    await expect(locateTerminalPath(link, 'C:\\repo', null, find)).resolves.toMatchObject({
      target: 'C:\\repo-noite\\docs\\x.md',
    })
  })

  // The Markdown actions follow the file found, not the cut half that was printed.
  it('classifies a recovered path by the file it found', async () => {
    const link = {
      target: 'C:\\repo\\docs\\reports\\2026-10-03-piloto-noi',
      wrapped: ['C:\\repo\\docs\\reports\\2026-10-03-piloto-noite\\handoff.md'],
    }
    const find = vi.fn(async (_cwd: string, path: string) => (path.endsWith('.md') ? path : null))
    await expect(locateTerminalPath(link, 'C:\\repo', null, find)).resolves.toEqual({
      target: 'C:\\repo\\docs\\reports\\2026-10-03-piloto-noite\\handoff.md',
      fileKind: 'markdown',
    })
  })

  // Prose around a file link that exists never redirects it, even to another file that exists.
  it('keeps a file link that exists, whatever the rows around it join into', async () => {
    const above = linkAt(['We completed reading', '  docs/x.md'], 1)
    expect(above.wrapped).toEqual(['readingdocs/x.md'])
    await expect(locateTerminalPath(above, 'C:\\repo', null, everything)).resolves.toMatchObject({
      target: 'docs/x.md',
    })
    const below = linkAt(['  docs/x.md', 'tail of the prose'], 0)
    expect(below.wrapped).toEqual(['docs/x.mdtail'])
    await expect(locateTerminalPath(below, 'C:\\repo', null, everything)).resolves.toMatchObject({
      target: 'docs/x.md',
    })
  })

  it('takes the longest join that exists, not the last one', async () => {
    const link = linkAt(['longdirectoryprefix/', '  abcdefghijklmno.md', '  tail'], 1)
    const find = lookup({
      'longdirectoryprefix/abcdefghijklmno.md': 'C:\\repo\\longdirectoryprefix\\abcdefghijklmno.md',
      'abcdefghijklmno.mdtail': 'C:\\repo\\abcdefghijklmno.mdtail',
    })
    await expect(locateTerminalPath(link, 'C:\\repo', null, find)).resolves.toMatchObject({
      target: 'C:\\repo\\longdirectoryprefix\\abcdefghijklmno.md',
    })
  })

  // `.claude` looks like an extension, yet names a folder: it does not win as a file link would.
  it('recovers the file past a dotted folder the row was cut after', async () => {
    const link = linkAt(['C:\\repo\\.claude', '/worktrees/night/handoff.md'], 0)
    const find = lookup({
      'C:\\repo\\.claude': 'C:\\repo\\.claude',
      'C:\\repo\\.claude/worktrees/night/handoff.md':
        'C:\\repo\\.claude\\worktrees\\night\\handoff.md',
    })
    await expect(locateTerminalPath(link, 'C:\\repo', null, find)).resolves.toEqual({
      target: 'C:\\repo\\.claude\\worktrees\\night\\handoff.md',
      fileKind: 'markdown',
    })
  })

  // A row cut right after a folder name leaves a link to the folder, which exists.
  it('prefers the whole file to a folder the row was cut after', async () => {
    const link = {
      target: 'C:\\repo\\docs',
      wrapped: ['C:\\repo\\docs\\handoff.md', 'C:\\repo\\docs\\handoff.md\\nope'],
    }
    const find = lookup({
      'C:\\repo\\docs': 'C:\\repo\\docs',
      'C:\\repo\\docs\\handoff.md': 'C:\\repo-noite\\docs\\handoff.md',
    })
    await expect(locateTerminalPath(link, 'C:\\repo', null, find)).resolves.toMatchObject({
      target: 'C:\\repo-noite\\docs\\handoff.md',
    })
  })

  it('keeps the printed path when nothing exists or the lookup fails', async () => {
    await expect(
      locateTerminalPath(
        { target: 'C:\\repo\\a.md', wrapped: ['C:\\repo\\a.mdtexto'] },
        'C:\\repo',
        null,
        lookup({}),
      ),
    ).resolves.toMatchObject({ target: 'C:\\repo\\a.md' })
    const failing = vi.fn(async () => Promise.reject(new Error('ipc')))
    await expect(
      locateTerminalPath({ target: 'docs/x.md' }, 'C:\\repo', null, failing),
    ).resolves.toEqual({ target: 'C:\\repo\\docs\\x.md', fileKind: 'markdown' })
  })
})
