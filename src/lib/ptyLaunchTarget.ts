import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'
import { resolveAgentCliCommand } from './agentProviders'
import { getLocale, translate } from './i18n'
import type { AgentType } from './types'

/**
 * What to spawn for a tab: the agent CLI, or — for a plain shell tab, which has no CLI — the shell
 * the user configured: the tab's own, with the default from Preferences as its fallback, else that
 * default. All fields derive from the same tab, so they are returned together and spread into
 * `spawnPty`/`restartPty`; keeping them apart let restart paths drop the shell override.
 *
 * `ptyId` finds the tab: the pty it runs in, or its own id before its first spawn. The backend runs
 * a shell only when it is an absolute file, tries them in that order and degrades to the
 * per-platform auto-detect instead of failing the spawn; `noticeShellFallback` reports a skip.
 *
 * Bare shells spawned outside a tab (the agent installer's `irm … | iex` pipelines) deliberately do
 * not come through here: they need the detected PowerShell, not the user's shell of choice.
 */
export function ptyLaunchTarget(
  type: AgentType | null | undefined,
  ptyId?: string,
): {
  command: string | undefined
  launcherOverride: string | undefined
  fallbackLauncher?: string
} {
  // Plugin-provided agents have a CLI too; only a plain shell tab has none.
  const command = type ? resolveAgentCliCommand(type) : undefined
  if (command) return { command, launcherOverride: undefined }
  const defaultShell = useProjectsStore.getState().preferences.shellPath ?? undefined
  const shell = ptyId
    ? useProjectsStore
        .getState()
        .projects.flatMap((project) => project.terminals)
        .flatMap((terminal) => terminal.tabs)
        .find((tab) => tab.ptyId === ptyId || tab.id === ptyId)?.shell
    : undefined
  if (!shell) return { command: undefined, launcherOverride: defaultShell }
  return { command: undefined, launcherOverride: shell, fallbackLauncher: defaultShell }
}

/** Says, once per spawn, that the backend skipped `shell` because it no longer runs. */
export function noticeShellFallback(
  response: { shellFallback?: boolean },
  shell: string | undefined,
): void {
  if (!response.shellFallback || !shell) return
  useUiStore
    .getState()
    .pushToast({ title: translate(getLocale(), 'prefs.shellMissing'), body: shell })
}
