import { getCodexAccountStats, getCodexUsage } from './tauri'
import { makeTtlCache } from './ttlCache'
import { isUsageAccessOff } from './usageAccess'

const TTL_MS = 60_000
// Account stats come only from a spawned codex.exe (#202) and move by the day.
const STATS_TTL_MS = 30 * 60_000

export const getCachedCodexUsage = makeTtlCache(getCodexUsage, TTL_MS)

// A failed read is kept as "no stats" for the whole TTL, so reopening the card does not start
// another codex.exe; only the access gate still rejects, and access changes clear the cache.
export const getCachedCodexAccountStats = makeTtlCache(
  () =>
    getCodexAccountStats().catch((error: unknown) => {
      if (isUsageAccessOff(error)) throw error
      return null
    }),
  STATS_TTL_MS,
)
