/** Runs a decided voice plan against the workspace: focus, stop, send or open terminals. */
import { agentLabel } from '../../lib/agentProviders'
import type { TFunction } from '../../lib/i18n'
import { anchoredCwd } from '../../lib/projectCheckout'
import { writePty } from '../../lib/tauri'
import type { VoicePlan } from '../../lib/voiceCommand'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'

function focusTerminal(projectId: string, terminalId: string) {
  const projects = useProjectsStore.getState()
  projects.setActiveProjectOnly(projectId)
  projects.focusWorkspaceTerminal(projectId, terminalId)
  const ui = useUiStore.getState()
  ui.setActiveTerminal(projectId, terminalId)
  ui.requestPaneFocus(terminalId)
}

export async function runPlan(plan: VoicePlan, t: TFunction): Promise<string[]> {
  const projects = useProjectsStore.getState()

  if (plan.kind === 'focus') {
    focusTerminal(plan.projectId, plan.terminalId)
    return [t('voice.action.focused', { terminal: plan.terminalName })]
  }
  if (plan.kind === 'kill') {
    projects.deleteTerminal(plan.projectId, plan.terminalId)
    return [t('voice.action.stopped', { terminal: plan.terminalName })]
  }
  if (plan.kind === 'reuse') {
    await writePty(plan.ptyId, `${plan.prompt}\r`)
    focusTerminal(plan.projectId, plan.terminalId)
    return [t('voice.action.sent', { terminal: plan.terminalName })]
  }
  if (plan.kind !== 'spawn') return []

  const project = projects.projects.find((item) => item.id === plan.projectId)
  if (!project) throw new Error('project vanished before the plan ran')
  const cwd = await anchoredCwd(project.id)

  const created = await Promise.all(
    plan.jobs.map((job, index) => {
      const label = agentLabel(job.agent)
      const sameAgent = plan.jobs.filter((item) => item.agent === job.agent).length > 1
      return projects.createAgentTerminal(plan.projectId, {
        name: sameAgent ? `${label} ${index + 1}` : label,
        cwd,
        firstTab: { type: job.agent, cwd, initialInput: job.prompt || undefined },
      })
    }),
  )
  const last = created[created.length - 1]
  if (last) focusTerminal(plan.projectId, last.id)

  return plan.jobs.map((job) => {
    const agent = agentLabel(job.agent)
    return job?.prompt
      ? t('voice.action.openedWith', { agent, project: plan.projectName, prompt: job.prompt })
      : t('voice.action.opened', { agent, project: plan.projectName })
  })
}
