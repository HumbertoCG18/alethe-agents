const invalidators = new Set<() => void>()

/**
 * Drops every memoised value so the next read refetches.
 *
 * These caches hold whatever the last poll returned for the lifetime of the app; under memory
 * pressure that is dead weight the process can hand back immediately, unlike a terminal buffer.
 */
export function clearAllTtlCaches(): void {
  for (const invalidate of invalidators) invalidate()
}

export function makeTtlCache<T>(
  fetcher: () => Promise<T>,
  ttlMs: number,
): (force?: boolean) => Promise<T> {
  let cached: { value: T; at: number } | null = null
  let inFlight: Promise<T> | null = null
  invalidators.add(() => {
    cached = null
  })

  return (force = false) => {
    const now = Date.now()
    if (!force && cached && now - cached.at < ttlMs) {
      return Promise.resolve(cached.value)
    }
    // A read already on its way is as fresh as a forced one would be, and a second request to a
    // rate-limited endpoint only keeps the limit hit.
    if (inFlight) return inFlight

    inFlight = fetcher()
      .then(
        (value) => {
          cached = { value, at: Date.now() }
          return value
        },
        (error: unknown) => {
          // A read that failed says the value on hand can no longer be trusted: serving it on the
          // next read would present it as fresh, and a missing token would bring it back.
          cached = null
          throw error
        },
      )
      .finally(() => {
        inFlight = null
      })

    return inFlight
  }
}

export function makeKeyedTtlCache<K, T>(
  fetcher: (key: K) => Promise<T>,
  ttlMs: number,
): (key: K, force?: boolean) => Promise<T> {
  let cached: { key: K; value: T; at: number } | null = null
  let inFlight: { key: K; promise: Promise<T> } | null = null
  invalidators.add(() => {
    cached = null
  })

  return (key: K, force = false) => {
    const now = Date.now()
    if (!force && cached && cached.key === key && now - cached.at < ttlMs) {
      return Promise.resolve(cached.value)
    }
    if (!force && inFlight && inFlight.key === key) return inFlight.promise

    const promise = fetcher(key)
      .then((value) => {
        cached = { key, value, at: Date.now() }
        return value
      })
      .finally(() => {
        if (inFlight?.promise === promise) inFlight = null
      })

    inFlight = { key, promise }
    return promise
  }
}
