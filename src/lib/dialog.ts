import { confirm, open, save, type DialogFilter } from '@tauri-apps/plugin-dialog'

import { useUiStore } from '../stores/uiStore'
import { recordFrontendError } from './tauri'

function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export type FsBrowserCallback = (path: string | null) => void

let pendingFsResolver: FsBrowserCallback | null = null

export function resolvePendingFsBrowser(path: string | null) {
  if (pendingFsResolver) {
    pendingFsResolver(path)
    pendingFsResolver = null
  }
}

export async function pickDirectory(opts?: { defaultPath?: string }): Promise<string | null> {
  if (!isTauriEnv()) {
    return new Promise<string | null>((resolve) => {
      pendingFsResolver = resolve
      useUiStore.getState().openModal_('fsBrowser', {
        mode: 'folder',
        defaultPath: opts?.defaultPath,
      })
    })
  }
  const result = await open({
    directory: true,
    multiple: false,
    defaultPath: opts?.defaultPath,
  })
  if (typeof result === 'string') return result
  return null
}

export async function pickFile(opts?: {
  title?: string
  filters?: DialogFilter[]
  defaultPath?: string
}): Promise<string | null> {
  if (!isTauriEnv()) {
    return new Promise<string | null>((resolve) => {
      pendingFsResolver = resolve
      useUiStore.getState().openModal_('fsBrowser', {
        mode: 'file',
        title: opts?.title,
        defaultPath: opts?.defaultPath,
      })
    })
  }
  const result = await open({
    directory: false,
    multiple: false,
    title: opts?.title,
    filters: opts?.filters,
    defaultPath: opts?.defaultPath,
  })
  if (typeof result === 'string') return result
  return null
}

export async function saveFile(opts: {
  title?: string
  defaultPath?: string
  filters?: DialogFilter[]
}): Promise<string | null> {
  if (!isTauriEnv()) {
    return new Promise<string | null>((resolve) => {
      pendingFsResolver = resolve
      useUiStore.getState().openModal_('fsBrowser', {
        mode: 'file',
        title: opts.title,
        defaultPath: opts.defaultPath,
      })
    })
  }
  const result = await save({
    title: opts.title,
    defaultPath: opts.defaultPath,
    filters: opts.filters,
  })
  return result ?? null
}

export type ConfirmOptions = {
  title?: string
  kind?: 'info' | 'warning' | 'error'
  okLabel?: string
  cancelLabel?: string
}

/**
 * Asks a yes/no question through the native dialog. Never use `window.confirm`: tauri-plugin-dialog
 * replaces it with an async function whose Promise is always truthy, so a synchronous check
 * proceeds without asking. A dialog that fails to open counts as "no", and so does a question
 * asked while another is open: a second click before the first dialog shows must not run the
 * action twice.
 */
let asking = false

export async function askConfirm(message: string, options?: ConfirmOptions): Promise<boolean> {
  if (asking) return false
  asking = true
  try {
    return await confirm(message, options)
  } catch (error) {
    void recordFrontendError(
      `Confirmation dialog failed: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? (error.stack ?? null) : null,
      'dialog',
    )
    return false
  } finally {
    asking = false
  }
}
