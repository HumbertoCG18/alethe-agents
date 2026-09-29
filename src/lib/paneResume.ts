import { useProjectsStore } from '../stores/projectsStore'
import { relaunchAgentPty } from './agentRelaunch'
import { graphifyRepoOf } from './claudeMcpConfigs'
import { registerSessionClaim, releaseSessionClaim } from './sessionDiscovery'
import { saveSession } from './sessionResume'
import type { AgentRuntimeProfile, AgentType } from './types'

export type ResumeSessionInPaneParams = {
  agent: AgentType
  projectId: string
  terminalId: string
  tabId: string
  ptyId: string
  sessionId: string
  cwd: string
  extraArgs?: string[]
  runtimeProfile?: AgentRuntimeProfile
}

/**
 * Points a live pane at another conversation. The restart itself is the easy half — the claim
 * handoff, the `active-sessions` record and the tab's own `sessionId` all have to move with it,
 * or the pane resumes one conversation while the sidebar and the next app start believe another.
 */
export async function resumeSessionInPane({
  agent,
  projectId,
  terminalId,
  tabId,
  ptyId,
  sessionId,
  cwd,
  extraArgs,
  runtimeProfile,
}: ResumeSessionInPaneParams): Promise<void> {
  releaseSessionClaim(tabId)
  releaseSessionClaim(ptyId)

  const project = useProjectsStore.getState().projects.find((entry) => entry.id === projectId)
  const terminal = project?.terminals.find((entry) => entry.id === terminalId)
  await relaunchAgentPty({
    ptyId,
    agent,
    runtimeProfile,
    extraArgs,
    sessionId,
    cwd,
    graphifyRepo: graphifyRepoOf(project, terminal?.cwd),
  })

  if (cwd) {
    registerSessionClaim(agent, cwd, sessionId, tabId)
    registerSessionClaim(agent, cwd, sessionId, ptyId)
  }
  saveSession(tabId, {
    sessionId: ptyId,
    claudeSessionId: agent === 'claude' ? sessionId : undefined,
    codexSessionId: agent === 'codex' ? sessionId : undefined,
    opencodeSessionId: agent === 'opencode' ? sessionId : undefined,
    antigravitySessionId: agent === 'antigravity' ? sessionId : undefined,
    cwd,
    agent,
    timestamp: Date.now(),
  })
  useProjectsStore.getState().setSubTabSessionId(projectId, terminalId, tabId, sessionId)

  window.dispatchEvent(new CustomEvent('alethe:terminal-resize-request', { detail: { ptyId } }))
}
