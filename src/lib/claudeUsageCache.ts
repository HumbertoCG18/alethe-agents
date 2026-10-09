import { useUiStore } from '../stores/uiStore'
import { type ClaudeUsage, type ClaudeUsageFailure, getClaudeUsage } from './tauri'
import { makeTtlCache } from './ttlCache'
import { isUsageAccessOff } from './usageAccess'

const TTL_MS = 60_000
/** The wait after a rate limit that did not say how long, or gave a value out of range. */
const DEFAULT_BACKOFF_MS = 5 * 60_000
const MAX_BACKOFF_MS = 60 * 60_000

/**
 * The last failed read: `at` and `waitMs` are on the monotonic clock, so a wall-clock change
 * neither ends nor stretches a back-off. Kept apart from the TTL cache, which memory pressure
 * clears.
 */
let lastFailure: { failure: ClaudeUsageFailure; at: number; waitMs: number } | null = null

export function resetClaudeUsageBackoffForTests(): void {
  lastFailure = null
}

function backoffMs(retryAfterSecs: string | undefined): number {
  const ms = Number(retryAfterSecs) * 1000
  return retryAfterSecs && Number.isFinite(ms) && ms >= 0 && ms <= MAX_BACKOFF_MS
    ? ms
    : DEFAULT_BACKOFF_MS
}

/** Reads the backend's `kind[:status[:retry_after_secs]]` error; anything else is `unavailable`. */
function recordFailure(error: unknown): ClaudeUsageFailure {
  const [kind, , retryAfterSecs] = String(error).split(':')
  let failure: ClaudeUsageFailure = { kind: 'unavailable' }
  let waitMs = 0
  if (kind === 'rate_limited') {
    waitMs = backoffMs(retryAfterSecs)
    // Epoch time only to show when; the wait itself runs on the monotonic clock.
    failure = { kind, retryAt: Date.now() + waitMs }
  } else if (kind === 'no_token' || kind === 'unauthorized' || kind === 'offline') {
    failure = { kind }
  }
  lastFailure = { failure, at: performance.now(), waitMs }
  return failure
}

/** One request. Rejects with a `ClaudeUsageFailure`, or the usage-off marker. */
async function readClaudeUsage(): Promise<ClaudeUsage> {
  try {
    const usage = await getClaudeUsage()
    lastFailure = null
    return usage
  } catch (error) {
    if (isUsageAccessOff(error)) throw error
    throw recordFailure(error)
  }
}

const cachedClaudeUsage = makeTtlCache(readClaudeUsage, TTL_MS)

/**
 * Every Claude usage reader goes through here. A read stands for the cache window whether it
 * succeeded or failed; a forced read skips the window, but never a rate-limit back-off.
 */
export function getCachedClaudeUsage(force = false): Promise<ClaudeUsage> {
  if (lastFailure) {
    const elapsed = performance.now() - lastFailure.at
    if (elapsed < lastFailure.waitMs || (!force && elapsed < TTL_MS)) {
      return Promise.reject(lastFailure.failure)
    }
  }
  return cachedClaudeUsage(force)
}

/**
 * Reads Claude usage into the UI store. The usage API rate limits readily, so a failed read keeps
 * the last reading on screen and records why it could not be refreshed; only a missing token
 * clears it.
 */
export async function loadClaudeUsage(force = false): Promise<ClaudeUsage | null> {
  const { setClaudeUsage, setClaudeUsageError } = useUiStore.getState()
  try {
    const usage = await getCachedClaudeUsage(force)
    setClaudeUsage(usage)
    setClaudeUsageError(null)
    return usage
  } catch (error) {
    // Turned off is a choice, not a failure: leave nothing on screen and report no error.
    if (isUsageAccessOff(error)) {
      setClaudeUsage(null)
      setClaudeUsageError(null)
      return null
    }
    const failure = error as ClaudeUsageFailure
    if (failure.kind === 'no_token') setClaudeUsage(null)
    setClaudeUsageError(failure)
    return null
  }
}
