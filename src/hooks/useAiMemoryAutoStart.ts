import { useEffect, useRef } from 'react'

import { AI_MEMORY_DEFAULT_PORT, aiMemoryStart, canStart } from '../lib/aiMemory'
import { aiMemoryDetect } from '../lib/tauri'
import { useProjectsStore } from '../stores/projectsStore'

/**
 * Starts ai-memory's server once per launch, mirroring `useRouter9AutoStart`: both halves of the
 * feature need it running — the capture hooks POST to it, and the MCP registration points at it —
 * so leaving it off until someone opens Preferences and clicks Start meant the feature was off again
 * on every launch. It runs once per active profile: a profile switch does not reload the window, and
 * it stops the server Alethe started for the previous profile.
 */
export function useAiMemoryAutoStart(hydrated: boolean, activeProfileId: string): void {
  // The profile the last attempt was for, recorded even when the feature is off there, so returning
  // to a profile that has it on tries again.
  const attemptedRef = useRef<string | null>(null)

  useEffect(() => {
    if (!hydrated || attemptedRef.current === activeProfileId) return
    attemptedRef.current = activeProfileId
    const enabled = useProjectsStore.getState().preferences.enabledFeatures.aiMemory
    if (!enabled) return

    void aiMemoryDetect()
      .then((status) => {
        // A switch while detection ran: starting now would start the server for the new profile.
        if (attemptedRef.current !== activeProfileId) return
        // `canStart` is also what the panel uses to decide whether to offer the button: installed,
        // and nothing already answering on the endpoint — including someone's own copy, which this
        // must leave alone rather than fight for the bind.
        if (!canStart(status)) return
        return aiMemoryStart(AI_MEMORY_DEFAULT_PORT)
      })
      .catch(() => undefined)
  }, [hydrated, activeProfileId])
}
