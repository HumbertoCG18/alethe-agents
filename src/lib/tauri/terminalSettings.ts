import { invoke } from '@tauri-apps/api/core'

/** `kind` names the shell family (pwsh, pwshStore, powershell, cmd, wsl, gitBash, or the executable). */
export type ShellOption = { id: string; kind: string; isDefault?: boolean }

export function discoverShells(): Promise<ShellOption[]> {
  return invoke('discover_shells')
}

let fonts: Promise<string[]> | undefined
export function installedFontFamilies(): Promise<string[]> {
  return (fonts ??= invoke<string[]>('installed_font_families').catch((error) => {
    fonts = undefined
    throw error
  }))
}
