import { getAntigravityUsage } from './tauri'
import { makeTtlCache } from './ttlCache'

// Each read spawns the agy CLI for several seconds; quota windows are 5 hours and a week.
const TTL_MS = 5 * 60_000

export const getCachedAntigravityUsage = makeTtlCache(getAntigravityUsage, TTL_MS)
