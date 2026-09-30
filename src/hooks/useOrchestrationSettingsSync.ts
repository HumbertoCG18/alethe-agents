import { useEffect } from 'react'

import { translate } from '../lib/i18n'
import { normalizeOrchestrationSettings } from '../lib/orchestrationSettings'
import { orchestratorApplySettings } from '../lib/tauri/orchestrator'
import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'

/**
 * Keeps the orchestrator on the roles and limits saved in Preferences. It runs at the app level
 * because a planner can delegate without any orchestration pane open.
 */
export function useOrchestrationSettingsSync(): void {
  const hydrated = useProjectsStore((state) => state.hydrated)
  const settings = useProjectsStore((state) => state.preferences.orchestration)
  const pushToast = useUiStore((state) => state.pushToast)

  useEffect(() => {
    // Before the saved file is read these are only the defaults.
    if (!hydrated) return
    // A role still being edited into shape is left out rather than handed to planners half-made.
    orchestratorApplySettings(normalizeOrchestrationSettings(settings)).catch((error: unknown) => {
      // Otherwise planners would quietly keep the previous roles, such as a writable one the
      // person just made read-only. The next change sends everything again.
      const locale = useProjectsStore.getState().preferences.language
      pushToast({
        title: translate(locale, 'orchestrator.settingsNotApplied'),
        body: translate(locale, 'orchestrator.settingsNotAppliedBody', { error: String(error) }),
      })
    })
  }, [hydrated, settings, pushToast])
}
