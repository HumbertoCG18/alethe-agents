import { useProjectsStore } from '../stores/projectsStore'
import { hasOrchestratorTools, waitForOrchestratorTools } from './claudeMcpConfigs'

/** How long a restarted (or resumed) Claude gets to come back with the orchestrator tools. */
const TOOLS_TIMEOUT_MS = 20_000

/**
 * `ready`: the terminal has its board. `declined`: the user kept it as it was. `failed`: Claude did
 * not come back with the orchestrator tools. `busy`: a start is already underway for it.
 */
export type OrchestrationStart = 'ready' | 'declined' | 'failed' | 'busy'

/** Terminals with a start already underway, so a second click cannot restart them twice. */
const starting = new Set<string>()

function hasBoard(projectId: string, terminalId: string): boolean {
  return (
    useProjectsStore.getState().projects.find((project) => project.id === projectId)?.paneGroups ??
    []
  ).some((group) => group.kind === 'orchestration' && group.paneIds.includes(terminalId))
}

/**
 * Puts an orchestration board next to a Claude terminal that is already open, turning its
 * conversation into a planner (#248). The board is only useful when that Claude has the
 * orchestrator tools, which it only receives at launch; one started without them is restarted on
 * the same conversation once the user agrees, and the board only appears once it is back with
 * them.
 */
export async function startOrchestrationOn({
  projectId,
  terminalId,
  ptyId,
  cwd,
  confirmRestart,
  restart,
}: {
  projectId: string
  terminalId: string
  ptyId: string
  cwd: string
  confirmRestart: () => Promise<boolean>
  /** Restarts the terminal's agent, or schedules its resume; false when it could not. */
  restart: () => Promise<boolean>
}): Promise<OrchestrationStart> {
  if (hasBoard(projectId, terminalId)) return 'ready'
  if (starting.has(terminalId)) return 'busy'
  starting.add(terminalId)
  try {
    const needsRestart = !hasOrchestratorTools(ptyId)
    if (needsRestart && !(await confirmRestart())) return 'declined'

    // Same as starting a planner from the new-terminal dialog: the feature has to be on for the
    // launch to include the orchestrator tools. Only after the user agreed to go ahead.
    const { preferences, setPreferences } = useProjectsStore.getState()
    if (!preferences.enabledFeatures.orchestrator) {
      setPreferences({ enabledFeatures: { ...preferences.enabledFeatures, orchestrator: true } })
    }
    if (needsRestart) {
      if (!(await restart())) return 'failed'
      if (!(await waitForOrchestratorTools(ptyId, TOOLS_TIMEOUT_MS))) return 'failed'
    }

    // The terminal may have been grouped, or closed, while this waited.
    const project = useProjectsStore.getState().projects.find((entry) => entry.id === projectId)
    if (!project?.terminals.some((terminal) => terminal.id === terminalId)) return 'failed'
    if (hasBoard(projectId, terminalId)) return 'ready'

    const { createOrchestratorPane, groupPanes } = useProjectsStore.getState()
    const board = createOrchestratorPane(projectId, cwd)
    groupPanes(projectId, [terminalId, board.id], { kind: 'orchestration' })
    return 'ready'
  } finally {
    starting.delete(terminalId)
  }
}
