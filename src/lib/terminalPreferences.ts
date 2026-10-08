import { DEFAULT_TERMINAL_FONT_FAMILY } from './types'

/** Ships with Alethe (src/assets/fonts), so the picker offers it even when the system lacks it. */
export const BUNDLED_TERMINAL_FONT = 'Caskaydia Cove Nerd Font Mono'

/** The saved font stack: the picked family first, then the default stack as its fallback. */
export function terminalFontStack(family: string): string {
  const name = family.trim()
  return name
    ? `${JSON.stringify(name)}, ${DEFAULT_TERMINAL_FONT_FAMILY}`
    : DEFAULT_TERMINAL_FONT_FAMILY
}

/** The family a saved stack starts with, unquoted; the picker and the native macOS terminal use one. */
export function primaryFontFamily(stack: string): string {
  return (stack.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '')
}
