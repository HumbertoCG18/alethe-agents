import { isShellAgentType, type AgentType } from './types'

export type AgentLaunch = {
  args: string[]
  sessionId?: string
  createdSession: boolean
}

function stripFlagWithValue(args: string[], flags: ReadonlySet<string>): string[] {
  const clean: string[] = []
  for (let index = 0; index < args.length; index++) {
    if (flags.has(args[index])) {
      index++
      continue
    }
    clean.push(args[index])
  }
  return clean
}

function stripClaudeSessionArgs(args: string[]): string[] {
  return stripFlagWithValue(args, new Set(['--resume', '-r', '--session-id'])).filter(
    (arg) => arg !== '--continue' && arg !== '-c',
  )
}

function stripCodexSessionArgs(args: string[]): string[] {
  if (args[0] !== 'resume') return [...args]
  const rest = args.slice(1)
  if (rest[0] === '--last' || (rest[0] && !rest[0].startsWith('-'))) rest.shift()
  return rest
}

function stripOpenCodeSessionArgs(args: string[]): string[] {
  return stripFlagWithValue(args, new Set(['--session', '-s'])).filter(
    (arg) => arg !== '--continue' && arg !== '-c' && arg !== '--resume',
  )
}

function stripAntigravitySessionArgs(args: string[]): string[] {
  return stripFlagWithValue(args, new Set(['--conversation'])).filter(
    (arg) => arg !== '--continue' && arg !== '-c',
  )
}

function stripGrokSessionArgs(args: string[]): string[] {
  return stripFlagWithValue(args, new Set(['--resume', '-r', '--session-id', '-s'])).filter(
    (arg) => arg !== '--continue' && arg !== '-c',
  )
}

function stripCodewhaleSessionArgs(args: string[]): string[] {
  // Prefer the `resume` subcommand (codex-style). Also drop flag forms.
  if (args[0] === 'resume') {
    const rest = args.slice(1)
    if (rest[0] === '--last' || (rest[0] && !rest[0].startsWith('-'))) rest.shift()
    return stripFlagWithValue(rest, new Set(['--resume', '-r'])).filter(
      (arg) => arg !== '--continue' && arg !== '-c',
    )
  }
  return stripFlagWithValue(args, new Set(['--resume', '-r'])).filter(
    (arg) => arg !== '--continue' && arg !== '-c',
  )
}

function stripCursorSessionArgs(args: string[]): string[] {
  return stripFlagWithValue(args, new Set(['--resume'])).filter(
    (arg) => arg !== '--continue' && !arg.startsWith('--resume='),
  )
}

/** Claude's per-launch flags for its MCP servers and hooks settings. */
export function claudeLaunchFlags(
  mcpConfigPaths?: readonly string[],
  hooksSettingsPath?: string,
): string[] {
  return [
    ...(mcpConfigPaths ?? []).flatMap((path) => ['--mcp-config', path]),
    ...(hooksSettingsPath ? ['--settings', hooksSettingsPath] : []),
  ]
}

/**
 * The argv tail that hands `agent` its first prompt at launch, or null when it has to be typed
 * into the running CLI instead. Only Claude Code and Codex take one (`[prompt]`), after `--` so no
 * flag before it can claim it (Claude's `--mcp-config` takes every value that follows). On
 * Windows the launch goes through PowerShell, which hands a batch-file launcher's arguments to
 * cmd.exe (expanding `%VAR%`, dropping quotes, running what follows `&`), and Windows PowerShell
 * 5.1 passes an argument's `"` (and a trailing `\`) unescaped; those prompts are typed. Claude
 * runs the subcommand a one-word prompt names (`claude -- update`), so that one is typed too, and
 * so is one the launch command line could not hold (`MAX_LAUNCH_LINE`).
 */
export function promptLaunchArgs(
  agent: AgentType,
  prompt: string,
  launch: {
    /** The launch's arguments before the prompt. */
    args: readonly string[]
    /** Every launcher the pty may run. */
    launchers: readonly (string | null | undefined)[]
    windows: boolean
  },
): string[] | null {
  if (agent !== 'claude' && agent !== 'codex') return null
  if (agent === 'claude' && !/\s/.test(prompt)) return null
  if (launch.windows) {
    const found = launch.launchers.filter((launcher): launcher is string => Boolean(launcher))
    if (found.length === 0 || !found.every((launcher) => /\.exe$/i.test(launcher))) return null
    if (/"|\\$/.test(prompt)) return null
  }
  const launcher = Math.max(MAX_PATH, ...launch.launchers.map((path) => path?.length ?? 0))
  const tail = ['--', prompt]
  if (launcher + quotedLength([...launch.args, ...tail]) > MAX_LAUNCH_LINE) return null
  return tail
}

/**
 * The longest launch line, in UTF-16 units, that takes a prompt. Windows' CreateProcess takes at
 * most 32,767 for the pty's `pwsh -NoLogo -NoProfile -Command "…"`; this keeps 2,767 for the
 * shell's own path and flags (under 300) and for what `quotedLength` cannot see. Elsewhere the
 * line is one argument of the shell, which Linux caps at 128 KiB: 30,000 units are at most
 * 90,000 bytes of UTF-8.
 */
const MAX_LAUNCH_LINE = 30_000
const MAX_PATH = 260

/**
 * How long `args` are on the launch line, at most: `'arg'` each, after a space, with every quote
 * PowerShell doubles and every `"` or `\` the command line escapes counted twice, plus the
 * `& … ; exit $LASTEXITCODE` around them.
 */
function quotedLength(args: readonly string[]): number {
  return args.reduce(
    (length, arg) => length + arg.length + 3 + (arg.match(/['‘’‚‛"\\]/g)?.length ?? 0),
    32,
  )
}

export function buildAgentLaunch(
  agent: AgentType,
  baseArgs: readonly string[] = [],
  sessionId?: string,
  createUuid: () => string = () => crypto.randomUUID(),

  mcpConfigPaths?: readonly string[],
  hooksSettingsPath?: string,
): AgentLaunch {
  if (isShellAgentType(agent)) {
    return { args: [...baseArgs], sessionId: undefined, createdSession: false }
  }

  if (agent === 'claude') {
    const clean = stripClaudeSessionArgs([...baseArgs])
    const flags = claudeLaunchFlags(mcpConfigPaths, hooksSettingsPath)
    if (sessionId) {
      return {
        args: ['--resume', sessionId, ...flags, ...clean],
        sessionId,
        createdSession: false,
      }
    }
    const createdId = createUuid()
    return {
      args: ['--session-id', createdId, ...flags, ...clean],
      sessionId: createdId,
      createdSession: true,
    }
  }

  if (agent === 'codex') {
    const clean = stripCodexSessionArgs([...baseArgs])
    return {
      args: sessionId ? ['resume', sessionId, ...clean] : clean,
      sessionId,
      createdSession: false,
    }
  }

  if (agent === 'opencode') {
    const clean = stripOpenCodeSessionArgs([...baseArgs])

    return {
      args: sessionId ? ['--session', sessionId, ...clean] : clean,
      sessionId,
      createdSession: false,
    }
  }

  if (agent === 'antigravity') {
    const clean = stripAntigravitySessionArgs([...baseArgs])
    return {
      args: sessionId ? ['--conversation', sessionId, ...clean] : clean,
      sessionId,
      createdSession: false,
    }
  }

  if (agent === 'kiro') {
    // kiro-cli only accepts flags like --trust-all-tools under the `chat`
    // subcommand — passed bare, it rejects them before falling back to it.
    return { args: ['chat', ...baseArgs], sessionId: undefined, createdSession: false }
  }

  // Cursor mints its own chat IDs (`cursor-agent create-chat`), so the pane arrives here already
  // holding one: there is nothing to generate, only a `--resume` to attach.
  if (agent === 'cursor') {
    const clean = stripCursorSessionArgs([...baseArgs])
    return {
      args: sessionId ? ['--resume', sessionId, ...clean] : clean,
      sessionId,
      createdSession: false,
    }
  }

  // Grok Build resumes by ID (`--resume`); interactive TUI does not mint IDs via --session-id.
  if (agent === 'grok') {
    const clean = stripGrokSessionArgs([...baseArgs])
    return {
      args: sessionId ? ['--resume', sessionId, ...clean] : clean,
      sessionId,
      createdSession: false,
    }
  }

  // Codewhale uses the `resume` subcommand (same shape as Codex).
  if (agent === 'codewhale') {
    const clean = stripCodewhaleSessionArgs([...baseArgs])
    return {
      args: sessionId ? ['resume', sessionId, ...clean] : clean,
      sessionId,
      createdSession: false,
    }
  }

  return { args: [...baseArgs], sessionId: undefined, createdSession: false }
}
