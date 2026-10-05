import { describe, expect, it } from 'vitest'

import { buildAgentLaunch, promptLaunchArgs } from './sessionLaunch'

describe('buildAgentLaunch', () => {
  it('new Claude panes receive distinct deterministic session ids', () => {
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
    const first = buildAgentLaunch(
      'claude',
      ['--dangerously-skip-permissions'],
      undefined,
      () => ids[0],
    )
    const second = buildAgentLaunch(
      'claude',
      ['--dangerously-skip-permissions'],
      undefined,
      () => ids[1],
    )

    expect(first.sessionId).not.toBe(second.sessionId)
    expect(first.args).toEqual(['--session-id', ids[0], '--dangerously-skip-permissions'])
    expect(second.args).toEqual(['--session-id', ids[1], '--dangerously-skip-permissions'])
  })

  it('Claude resumes only the session assigned to its pane', () => {
    const launch = buildAgentLaunch(
      'claude',
      ['--continue', '--resume', 'stale', '--session-id', 'stale-too', '--model', 'sonnet'],
      'pane-session',
    )

    expect(launch.args).toEqual(['--resume', 'pane-session', '--model', 'sonnet'])
    expect(launch.createdSession).toBe(false)
  })

  it('Codex without a known id starts a new chat instead of resuming last', () => {
    const launch = buildAgentLaunch('codex', ['resume', '--last', '--search'])
    expect(launch.args).toEqual(['--search'])
  })

  it('Codex and OpenCode use their pane-specific resume syntax', () => {
    expect(buildAgentLaunch('codex', ['resume', 'old', '--search'], 'codex-pane').args).toEqual([
      'resume',
      'codex-pane',
      '--search',
    ])
    expect(
      buildAgentLaunch('opencode', ['--continue', '--session', 'old', '--model', 'x'], 'open-pane')
        .args,
    ).toEqual(['--session', 'open-pane', '--model', 'x'])
  })

  it('Cursor resumes the chat its pane owns and drops every stale resume flag', () => {
    expect(
      buildAgentLaunch(
        'cursor',
        ['--continue', '--resume', 'old', '--resume=older', '--force'],
        'cursor-chat',
      ).args,
    ).toEqual(['--resume', 'cursor-chat', '--force'])
  })

  it('Cursor without a chat id starts fresh instead of continuing the last one', () => {
    const launch = buildAgentLaunch('cursor', ['--continue', '--force'])
    expect(launch.args).toEqual(['--force'])
    expect(launch.sessionId).toBeUndefined()
  })

  it('Antigravity keeps agy flags and uses its pane-specific conversation', () => {
    expect(
      buildAgentLaunch(
        'antigravity',
        ['--continue', '--conversation', 'old', '--dangerously-skip-permissions'],
        'agy-pane',
      ).args,
    ).toEqual(['--conversation', 'agy-pane', '--dangerously-skip-permissions'])
  })

  it('Grok Build resumes by --resume when a pane session id is known', () => {
    expect(
      buildAgentLaunch('grok', ['--continue', '--resume', 'old', '--yolo'], 'grok-pane').args,
    ).toEqual(['--resume', 'grok-pane', '--yolo'])
  })

  it('Grok Build without a session id starts fresh instead of continuing last', () => {
    const launch = buildAgentLaunch('grok', ['--continue', '--yolo'])
    expect(launch.args).toEqual(['--yolo'])
    expect(launch.sessionId).toBeUndefined()
  })

  it('Codewhale uses the resume subcommand like Codex', () => {
    expect(
      buildAgentLaunch('codewhale', ['resume', 'old', '--model', 'auto'], 'whale-pane').args,
    ).toEqual(['resume', 'whale-pane', '--model', 'auto'])
  })

  it('Codewhale without a session id drops stale resume/continue flags', () => {
    const launch = buildAgentLaunch('codewhale', ['--continue', '--resume', 'stale'])
    expect(launch.args).toEqual([])
    expect(launch.sessionId).toBeUndefined()
  })
})

// The initial prompt rides in argv for the agents whose CLI takes one (#74).
describe('promptLaunchArgs', () => {
  const prompt = 'Retome a campanha X pelo registro C:\\repo\\.workflow\\campanhas.json.'
  const exe = 'C:\\Users\\me\\.local\\bin\\claude.exe'
  /** A launch on Windows (or not) through `launchers`, with `args` before the prompt. */
  const on = (
    launchers: (string | null | undefined)[],
    windows = true,
    args: string[] = ['--session-id', '11111111-1111-4111-8111-111111111111'],
  ) => ({ args, launchers, windows })

  it('gives Claude Code and Codex the prompt last, after `--` so no flag can take it', () => {
    expect(promptLaunchArgs('claude', prompt, on([exe]))).toEqual(['--', prompt])
    expect(promptLaunchArgs('codex', prompt, on(['C:\\codex\\bin\\codex.exe']))).toEqual([
      '--',
      prompt,
    ])
    expect(promptLaunchArgs('codex', prompt, on(['/usr/local/bin/codex'], false))).toEqual([
      '--',
      prompt,
    ])
  })

  it('keeps every other agent on the typed path', () => {
    for (const agent of ['opencode', 'cursor', 'antigravity', 'grok', 'shell'] as const) {
      expect(promptLaunchArgs(agent, prompt, on([exe]))).toBeNull()
    }
  })

  it('types it on Windows unless every launcher the pty may run is a native executable', () => {
    // cmd.exe re-parses a batch file's arguments: %VAR% expands, quotes go, `&` runs a command.
    for (const launcher of ['C:\\npm\\codex.cmd', 'C:\\npm\\codex.BAT', 'C:\\npm\\codex.ps1']) {
      expect(promptLaunchArgs('codex', prompt, on([launcher]))).toBeNull()
    }
    expect(promptLaunchArgs('codex', prompt, on([]))).toBeNull()
    expect(promptLaunchArgs('claude', prompt, on([exe, 'C:\\npm\\claude.cmd']))).toBeNull()
    expect(promptLaunchArgs('claude', prompt, on([exe, null, undefined]))).toEqual(['--', prompt])
    // Elsewhere the launcher is exec'd with each argument single-quoted.
    expect(promptLaunchArgs('codex', prompt, on(['/home/me/.npm/bin/codex'], false))).not.toBeNull()
  })

  it('types it on Windows when Windows PowerShell would pass it mangled', () => {
    // Windows PowerShell 5.1 wraps an argument in quotes without escaping the ones inside it.
    expect(promptLaunchArgs('claude', 'say "hi" now', on([exe]))).toBeNull()
    expect(promptLaunchArgs('claude', 'look in C:\\repo\\', on([exe]))).toBeNull()
    expect(promptLaunchArgs('claude', 'say "hi" now', on(['/bin/claude'], false))).toEqual([
      '--',
      'say "hi" now',
    ])
    // Everything else reaches the argv as typed (the pty's own quoting is tested in Rust).
    const symbols = "it's ‘quoted’ $HOME `cmd` ; & | % %PATH% ^ < > (x) {y} @z #c"
    expect(promptLaunchArgs('claude', symbols, on([exe]))).toEqual(['--', symbols])
  })

  it('types a one-word prompt for Claude Code, which would run the subcommand it names', () => {
    expect(promptLaunchArgs('claude', 'update', on([exe]))).toBeNull()
    expect(promptLaunchArgs('codex', 'update', on(['/bin/codex'], false))).toEqual(['--', 'update'])
  })

  // CreateProcess takes at most 32,767 characters of command line (ENAMETOOLONG past it).
  it('types a prompt the launch command line could not hold', () => {
    const words = (length: number) => 'word '.repeat(length / 5)
    expect(promptLaunchArgs('claude', words(33_010), on([exe]))).toBeNull()
    expect(promptLaunchArgs('codex', words(33_010), on(['/bin/codex'], false))).toBeNull()
    expect(promptLaunchArgs('claude', words(20_000), on([exe]))).toEqual(['--', words(20_000)])
  })

  it('counts the flags before it and the quoting PowerShell needs', () => {
    const long = 'word '.repeat(1_000)
    // Fits alone, not after flags that take most of the line.
    expect(promptLaunchArgs('claude', long, on([exe]))).not.toBeNull()
    const flags = Array.from({ length: 6 }, () => long)
    expect(promptLaunchArgs('claude', long, on([exe], true, flags))).toBeNull()
    // Every single quote is doubled inside PowerShell's quoting.
    const quotes = "it's ".repeat(5_000)
    expect(promptLaunchArgs('claude', quotes.slice(0, 20_000), on([exe]))).not.toBeNull()
    expect(promptLaunchArgs('claude', quotes, on([exe]))).toBeNull()
    expect(promptLaunchArgs('claude', 'x’ '.repeat(8_000), on([exe]))).toBeNull()
  })
})
