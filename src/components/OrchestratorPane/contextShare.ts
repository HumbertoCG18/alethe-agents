import type { OrchestratorTokens } from '../../lib/tauri/orchestrator'

/** How full the model's context window is: the last turn's prompt, not the running total (#279). */
export function contextShare(job: { tokens?: OrchestratorTokens | null }): number | null {
  const used = job.tokens?.last?.totalTokens
  const window = job.tokens?.modelContextWindow
  if (!used || !window) return null
  return Math.min(100, Math.round((used / window) * 100))
}
