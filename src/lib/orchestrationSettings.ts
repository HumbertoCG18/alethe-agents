import { DEFAULT_PREFERENCES, type OrchestrationRole, type OrchestrationSettings } from './types'

const DEFAULTS = DEFAULT_PREFERENCES.orchestration

export const MAX_CONCURRENT_LIMITS = { min: 1, max: 16 } as const

/** What `claude --effort` takes (Claude Code 2.1.285). */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

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

/** Whether the orchestrator would run this role as it is written. */
export function isValidRole(role: unknown): role is OrchestrationRole {
  if (!role || typeof role !== 'object') return false
  const { name, agent, model, effort, readOnly, timeoutSeconds } = role as Record<string, unknown>
  if (typeof name !== 'string' || !isOrchestrationName(name)) return false
  if (agent !== 'codex' && agent !== 'claude') return false
  if (!optionalName(model) || !optionalName(effort) || typeof readOnly !== 'boolean') return false
  if (timeoutSeconds !== null && !wholeSeconds(timeoutSeconds)) return false
  // The headless Claude launch bypasses permissions and has no read-only mode.
  return agent === 'codex' || !readOnly
}

/**
 * Settings read from disk. A role the orchestrator would refuse is dropped rather than repaired:
 * making a read-only Claude role writable, say, would change what it means.
 */
export function normalizeOrchestrationSettings(raw: unknown): OrchestrationSettings {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const seen = new Set<string>()
  const roles = (Array.isArray(source.roles) ? source.roles : []).filter(
    (role): role is OrchestrationRole => {
      if (!isValidRole(role) || seen.has(role.name)) return false
      seen.add(role.name)
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
    roles: roles.map((role) => ({ ...role })),
    maxConcurrent,
    defaultTimeoutSeconds,
  }
}
