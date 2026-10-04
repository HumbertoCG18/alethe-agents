import { getCurrentWindow } from '@tauri-apps/api/window'
import { confirm } from '@tauri-apps/plugin-dialog'
import { useEffect } from 'react'

import { type CloseFailureStage, createCloseCoordinator } from '../lib/closeCoordinator'
import { getLocale, translate } from '../lib/i18n'
import { quitApp, recordFrontendError } from '../lib/tauri'
import { flushProjectsState } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'

function errorDetails(error: unknown): { message: string; stack: string | null } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack ?? null }
  }
  return { message: String(error), stack: null }
}

// A failed quit, or a confirmation dialog that could not open, leaves the app open: say so.
function reportCloseFailure(
  stage: CloseFailureStage,
  error: unknown,
  toast = stage === 'quit' || stage === 'confirm',
): void {
  const details = errorDetails(error)
  void recordFrontendError(
    `App close failed during ${stage}: ${details.message}`,
    details.stack,
    'app-close',
  )

  if (!toast) return
  const locale = getLocale()
  useUiStore.getState().pushToast({
    title: translate(locale, 'appClose.failedTitle'),
    body: translate(locale, 'appClose.failedBody'),
  })
}

const appWindow = getCurrentWindow()
const closeCoordinator = createCloseCoordinator({
  confirmNative: () => {
    const locale = getLocale()
    return confirm(translate(locale, 'appClose.message'), {
      title: translate(locale, 'appClose.title'),
      kind: 'warning',
      okLabel: translate(locale, 'appClose.confirm'),
      cancelLabel: translate(locale, 'appClose.cancel'),
    })
  },
  beforeClose: flushProjectsState,
  destroyWindow: () => appWindow.destroy(),
  quitApp: () => quitApp(),
  onFailure: reportCloseFailure,
})

export function requestAppClose(): Promise<void> {
  return closeCoordinator.handleCloseRequest({ preventDefault: () => {} })
}

export function useCloseConfirmation(): void {
  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | null = null

    void appWindow
      .onCloseRequested((event) => closeCoordinator.handleCloseRequest(event))
      .then((stopListening) => {
        if (cancelled) stopListening()
        else unlisten = stopListening
      })
      .catch((error) => reportCloseFailure('confirm', error, false))

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])
}
