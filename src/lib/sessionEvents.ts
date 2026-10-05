import type { OrchestratorJob } from './tauri/orchestrator'

/** What an agent session says, one event at a time, as the session reader (`session_read`) reads it. */
export type SessionEvent = {
  role: 'user' | 'assistant' | 'tool' | 'tool-result' | 'question'
  text: string
  /** A question's id, to answer it by. */
  questionSetId?: string
  questions?: unknown[]
}

/**
 * An orchestrator worker's conversation as session events: the task it was given, what it
 * reported, and the approval it waits on.
 */
export function workerEvents(job: OrchestratorJob): SessionEvent[] {
  const events: SessionEvent[] = []
  if (job.spec.trim()) events.push({ role: 'user', text: job.spec })
  if (job.summary.trim()) events.push({ role: 'assistant', text: job.summary })
  const ask = job.pendingApproval
  if (ask) {
    events.push({
      role: 'question',
      text: ask.command ?? ask.reason ?? ask.kind,
      questionSetId: String(ask.rpcId),
    })
  }
  return events
}
