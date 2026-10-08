import { expect, it } from 'vitest'

import { normalizePreferences } from '../stores/projectsStore.migrations'
import { primaryFontFamily, terminalFontStack } from './terminalPreferences'
import { DEFAULT_TERMINAL_FONT_FAMILY } from './types'

it('carries a shell saved by an earlier fork build over to shellPath', () => {
  expect(
    normalizePreferences({ defaultShell: 'C:\\Program Files\\Git\\bin\\bash.exe' } as never)
      .shellPath,
  ).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
  expect(
    normalizePreferences({ shellPath: '/bin/zsh', defaultShell: '/bin/bash' } as never).shellPath,
  ).toBe('/bin/zsh')
  // The fork saved "no choice" as null; it reads as the default stack.
  expect(normalizePreferences({ terminalFontFamily: null } as never).terminalFontFamily).toBe(
    DEFAULT_TERMINAL_FONT_FAMILY,
  )
})

it('stores a picked family first with the default stack as fallback', () => {
  const stack = terminalFontStack('Font "name"')
  expect(stack).toBe(`"Font \\"name\\"", ${DEFAULT_TERMINAL_FONT_FAMILY}`)
  expect(terminalFontStack('  ')).toBe(DEFAULT_TERMINAL_FONT_FAMILY)
  expect(primaryFontFamily(terminalFontStack('Consolas'))).toBe('Consolas')
  expect(primaryFontFamily(DEFAULT_TERMINAL_FONT_FAMILY)).toBe('Cascadia Mono')
})
