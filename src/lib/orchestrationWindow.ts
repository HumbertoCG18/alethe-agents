const LABEL_PREFIX = 'orchestration-'

/**
 * The orchestration pane a detached board window shows, read back from the window's label
 * (`orchestration-<terminalId>`, see `open_orchestration_window`); null for any other window.
 */
export function orchestrationWindowPane(label: string): string | null {
  if (!label.startsWith(LABEL_PREFIX)) return null
  return label.slice(LABEL_PREFIX.length) || null
}
