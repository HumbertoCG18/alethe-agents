import { useEffect, useState } from 'react'

import { USAGE_FALLBACK_THRESHOLD, USAGE_POLL_MS } from '../lib/agentCanvasConfig'
import {
  type AgentFitness,
  antigravityFitness,
  claudeFitness,
  codexFitness,
} from '../lib/agentFitness'
import { getCachedAntigravityUsage } from '../lib/antigravityUsageCache'
import { getCachedClaudeUsage } from '../lib/claudeUsageCache'
import { getCachedCodexUsage } from '../lib/codexUsageCache'
import { setAgentFitness } from '../lib/tauri'
import { useProjectsStore } from '../stores/projectsStore'

type QuotaAgent = 'claude' | 'codex' | 'antigravity'

export type QuotaWarning = {
  agent: QuotaAgent
  pct: number
  /** Fitness label of the window that triggered the warning (see `quotaWindowLabel`). */
  window: string
  resetsAt: string | null
}

export function useOrchestratorQuotaWarnings(): QuotaWarning[] {
  const [warnings, setWarnings] = useState<QuotaWarning[]>([])
  const claudeAccess = useProjectsStore((s) => s.preferences.usageAccess.claude)
  const codexAccess = useProjectsStore((s) => s.preferences.usageAccess.codex)
  const antigravityAccess = useProjectsStore((s) => s.preferences.usageAccess.antigravity)

  // A provider that is off must not leave its last reading behind in the orchestrator core.
  useEffect(() => {
    if (!claudeAccess) void setAgentFitness('claude', null).catch(() => undefined)
  }, [claudeAccess])
  useEffect(() => {
    if (!codexAccess) void setAgentFitness('codex', null).catch(() => undefined)
  }, [codexAccess])
  useEffect(() => {
    if (!antigravityAccess) void setAgentFitness('antigravity', null).catch(() => undefined)
  }, [antigravityAccess])

  useEffect(() => {
    // Quota is only known for a provider whose usage reading is on. Without it the orchestrator
    // gets no fitness for that agent and no warning is raised: it runs as if quota were unknown.
    if (!claudeAccess && !codexAccess && !antigravityAccess) return
    let cancelled = false

    const report = async (agent: QuotaAgent, fitness: AgentFitness) => {
      // A reading that arrives after its provider was turned off must not reach the core again.
      if (cancelled) return null
      await setAgentFitness(agent, fitness).catch(() => undefined)
      return fitness.rateLimited || fitness.used >= USAGE_FALLBACK_THRESHOLD
        ? { agent, pct: fitness.used, window: fitness.worst, resetsAt: fitness.resetsAt }
        : null
    }

    const check = async () => {
      const next: QuotaWarning[] = []
      if (claudeAccess) {
        try {
          const warning = await report('claude', claudeFitness(await getCachedClaudeUsage()))
          if (warning) next.push(warning)
        } catch {
          // ignore
        }
      }
      if (codexAccess) {
        try {
          const warning = await report('codex', codexFitness(await getCachedCodexUsage()))
          if (warning) next.push(warning)
        } catch {
          // ignore
        }
      }
      if (antigravityAccess) {
        try {
          const usage = await getCachedAntigravityUsage()
          // Without the CLI or its sign-in there is no reading, which is not an empty quota.
          if (usage.status === 'ready') {
            const warning = await report('antigravity', antigravityFitness(usage))
            if (warning) next.push(warning)
          } else if (!cancelled) {
            await setAgentFitness('antigravity', null).catch(() => undefined)
          }
        } catch {
          // ignore
        }
      }
      if (!cancelled) setWarnings(next)
    }

    void check()
    const timer = window.setInterval(check, USAGE_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [claudeAccess, codexAccess, antigravityAccess])

  // A warning raised before the provider was turned off does not outlive it.
  const access = { claude: claudeAccess, codex: codexAccess, antigravity: antigravityAccess }
  return warnings.filter((warning) => access[warning.agent])
}
