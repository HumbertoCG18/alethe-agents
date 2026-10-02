import { DEFAULT_PREFERENCES, type OrchestrationRole, type OrchestrationSettings } from './types'

const DEFAULTS = DEFAULT_PREFERENCES.orchestration

export const MAX_CONCURRENT_LIMITS = { min: 1, max: 16 } as const

/** What `claude --effort` takes (Claude Code 2.1.285). */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * The efforts every model Codex 0.159 lists accepts, offered when Codex could not be asked for
 * its models. Without them a role could only run on the model's default effort.
 */
export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** A week. Past what any worker budget needs, and far below what the orchestrator can hold. */
export const MAX_TIMEOUT_SECONDS = 7 * 24 * 60 * 60

/**
 * A role, model or effort name the orchestrator accepts: not empty, no whitespace, and not starting
 * with `-`, because a Claude model ends up on a command line.
 */
export function isOrchestrationName(value: string): boolean {
  return value.length > 0 && !value.startsWith('-') && !/[\s\p{Cc}]/u.test(value)
}

const optionalName = (value: unknown): value is string | null =>
  value === null || (typeof value === 'string' && isOrchestrationName(value))

const wholeSeconds = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_TIMEOUT_SECONDS

/** A row's orchestrator: absent or null serves any planner. */
const ORCHESTRATORS: readonly unknown[] = [undefined, null, 'claude', 'codex']

/** Whether the orchestrator would run this role as it is written. */
export function isValidRole(role: unknown): role is OrchestrationRole {
  if (!role || typeof role !== 'object') return false
  const { name, agent, model, effort, readOnly, timeoutSeconds, orchestrator } = role as Record<
    string,
    unknown
  >
  if (typeof name !== 'string' || !isOrchestrationName(name)) return false
  if (agent !== 'codex' && agent !== 'claude') return false
  if (!optionalName(model) || !optionalName(effort) || typeof readOnly !== 'boolean') return false
  if (timeoutSeconds !== null && !wholeSeconds(timeoutSeconds)) return false
  if (!ORCHESTRATORS.includes(orchestrator)) return false
  // The headless Claude launch bypasses permissions and has no read-only mode.
  return agent === 'codex' || !readOnly
}

/**
 * Settings read from disk. A role the orchestrator would refuse is dropped rather than repaired:
 * making a read-only Claude role writable, say, would change what it means.
 */
export function normalizeOrchestrationSettings(raw: unknown): OrchestrationSettings {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  // One row per name and orchestrator (#276). Names hold no whitespace, so the key is unambiguous.
  const seen = new Set<string>()
  const roles = (Array.isArray(source.roles) ? source.roles : []).filter(
    (role): role is OrchestrationRole => {
      if (!isValidRole(role)) return false
      const key = `${role.orchestrator ?? ''} ${role.name}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    },
  )
  const maxConcurrent =
    typeof source.maxConcurrent === 'number' && Number.isFinite(source.maxConcurrent)
      ? Math.min(
          MAX_CONCURRENT_LIMITS.max,
          Math.max(MAX_CONCURRENT_LIMITS.min, Math.round(source.maxConcurrent)),
        )
      : DEFAULTS.maxConcurrent
  const defaultTimeoutSeconds = wholeSeconds(source.defaultTimeoutSeconds)
    ? source.defaultTimeoutSeconds
    : DEFAULTS.defaultTimeoutSeconds
  return {
    roles: roles.map(({ fallback, orchestrator, ...rest }) => {
      const role = orchestrator ? { ...rest, orchestrator } : rest
      return fallback && canFallBackToName(role, fallback, roles) ? { ...role, fallback } : role
    }),
    maxConcurrent,
    defaultTimeoutSeconds,
    workerDisabledPlugins: pluginIds(
      Array.isArray(source.workerDisabledPlugins) ? source.workerDisabledPlugins : [],
    ),
  }
}

/**
 * Whether `role` may run as `fallback` while its provider is running out (#268): another role,
 * and never a writable one for a read-only role. The orchestrator checks the same.
 */
export function canFallBackTo(
  role: Pick<OrchestrationRole, 'name' | 'readOnly'>,
  fallback: Pick<OrchestrationRole, 'name' | 'readOnly'> | undefined,
): boolean {
  if (!fallback || fallback.name === role.name) return false
  return !role.readOnly || fallback.readOnly
}

/**
 * Whether `role` may keep `name` as its fallback: a row of that name it reaches may run in its
 * place. A row for one orchestrator reaches that orchestrator's row of the name, else the row for
 * any; a row for any serves every planner, so it reaches every row of the name (#276).
 */
export function canFallBackToName(
  role: Pick<OrchestrationRole, 'name' | 'readOnly' | 'orchestrator'>,
  name: string,
  roles: readonly OrchestrationRole[],
): boolean {
  const named = roles.filter((other) => other.name === name)
  const reached = role.orchestrator
    ? [
        named.find((other) => other.orchestrator === role.orchestrator) ??
          named.find((other) => !other.orchestrator),
      ]
    : named
  return reached.some((other) => canFallBackTo(role, other))
}

/** Codex plugin ids, each once; anything Codex could not take as an id is dropped. */
export function pluginIds(values: readonly unknown[]): string[] {
  const ids = values.filter(
    (value): value is string => typeof value === 'string' && isOrchestrationName(value),
  )
  return [...new Set(ids)]
}
