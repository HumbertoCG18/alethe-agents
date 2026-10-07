import { invoke } from '@tauri-apps/api/core'

export type ShellOption = { id: string; label: string }

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
