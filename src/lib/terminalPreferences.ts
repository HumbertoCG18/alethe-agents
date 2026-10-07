export const BUNDLED_TERMINAL_FONT = 'Caskaydia Cove Nerd Font Mono'

export function terminalFontStack(family?: string | null): string {
  return `${JSON.stringify(family?.trim() || BUNDLED_TERMINAL_FONT)}, "${BUNDLED_TERMINAL_FONT}", Consolas, monospace`
}

export function normalizeTerminalChoice(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed && trimmed.length <= maxLength && !/[\u0000-\u001f]/.test(trimmed) ? trimmed : null
}
