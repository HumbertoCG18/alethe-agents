import { type AgentType, type ExperimentalAgentPermissionMode, UNRESTRICTED_FLAG } from './types'

/**
 * Permission policy for the experimental worker agents (Agent Canvas and Agent Sandbox).
 *
 * Every launch of those workers builds its permission arguments here, so the two modes are defined
 * in one place:
 * - `ask`: the agent keeps its own permission checks. Nothing is approved on the user's behalf.
 * - `bypass`: the agent runs commands and edits files without asking.
 *
 * This is unrelated to the main orchestrator and to the "unrestricted" toggle of regular terminals.
 */
export const DEFAULT_EXPERIMENTAL_AGENT_PERMISSION_MODE: ExperimentalAgentPermissionMode = 'ask'

const CODEX_ASK_APPROVAL_POLICY = 'on-request'
const CODEX_ASK_SANDBOX = 'workspace-write'
const CODEX_BYPASS_APPROVAL_POLICY = 'never'
const CODEX_BYPASS_SANDBOX = 'danger-full-access'

/** Anything other than an explicit `bypass` is `ask`, so a missing or corrupt value stays safe. */
export function normalizeExperimentalAgentPermissionMode(
  value: unknown,
): ExperimentalAgentPermissionMode {
  return value === 'bypass' ? 'bypass' : DEFAULT_EXPERIMENTAL_AGENT_PERMISSION_MODE
}

function bypassFlag(agent: 'claude' | 'codex'): string[] {
  const flag = UNRESTRICTED_FLAG[agent]
  return flag ? [flag] : []
}

/**
 * Permission arguments for a worker started as an interactive terminal, where the user can answer
 * the agent's own prompts. Agents without a known policy get no arguments in either mode.
 */
export function interactivePermissionArgs(
  agent: AgentType,
  mode: ExperimentalAgentPermissionMode,
): string[] {
  if (agent === 'claude') return mode === 'bypass' ? bypassFlag('claude') : []
  if (agent === 'codex') {
    return mode === 'bypass'
      ? bypassFlag('codex')
      : ['--ask-for-approval', CODEX_ASK_APPROVAL_POLICY, '--sandbox', CODEX_ASK_SANDBOX]
  }
  return []
}

/**
 * Arguments for a one-shot (non-interactive) worker. Nobody can answer a prompt there, so in `ask`
 * mode the CLI itself refuses whatever would have needed an approval.
 */
export function oneShotArgs(
  agent: AgentType,
  task: string,
  mode: ExperimentalAgentPermissionMode,
): string[] | undefined {
  switch (agent) {
    case 'codex':
      // `codex exec` takes `--sandbox` itself; the approval policy is a root-level flag.
      return mode === 'bypass'
        ? ['exec', ...bypassFlag('codex'), '--skip-git-repo-check', task]
        : [
            '--ask-for-approval',
            CODEX_ASK_APPROVAL_POLICY,
            'exec',
            '--sandbox',
            CODEX_ASK_SANDBOX,
            '--skip-git-repo-check',
            task,
          ]
    case 'claude':
      return ['-p', task, ...interactivePermissionArgs('claude', mode)]
    case 'opencode':
      return ['run', task]
    default:
      return undefined
  }
}

/** `thread/start` parameters for a Codex app-server worker. */
export function codexThreadStartParams(cwd: string, mode: ExperimentalAgentPermissionMode) {
  return mode === 'bypass'
    ? { cwd, approvalPolicy: CODEX_BYPASS_APPROVAL_POLICY, sandbox: CODEX_BYPASS_SANDBOX }
    : { cwd, approvalPolicy: CODEX_ASK_APPROVAL_POLICY, sandbox: CODEX_ASK_SANDBOX }
}

/** `turn/start` parameters for a Codex app-server worker. */
export function codexTurnStartParams(
  threadId: string,
  text: string,
  mode: ExperimentalAgentPermissionMode,
) {
  return {
    threadId,
    input: [{ type: 'text' as const, text }],
    approvalPolicy: mode === 'bypass' ? CODEX_BYPASS_APPROVAL_POLICY : CODEX_ASK_APPROVAL_POLICY,
  }
}

export type CodexApprovalKind = 'command' | 'fileChange'

export type CodexApprovalAnswer = {
  kind: CodexApprovalKind
  decision: 'accept' | 'decline'
}

/**
 * Answer for a Codex app-server approval request that no user is there to answer. Returns `null`
 * for any other method. Only `bypass` accepts; `ask` always declines.
 */
export function codexApprovalAnswer(
  method: string,
  mode: ExperimentalAgentPermissionMode,
): CodexApprovalAnswer | null {
  const kind: CodexApprovalKind | null =
    method === 'item/commandExecution/requestApproval'
      ? 'command'
      : method === 'item/fileChange/requestApproval'
        ? 'fileChange'
        : null
  if (!kind) return null
  return { kind, decision: mode === 'bypass' ? 'accept' : 'decline' }
}
