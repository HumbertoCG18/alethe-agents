import { expect, it } from 'vitest'

import { normalizePreferences } from '../stores/projectsStore.migrations'
import { BUNDLED_TERMINAL_FONT, terminalFontStack } from './terminalPreferences'

it('backfills older preferences and keeps legacy palettes', () => {
  const prefs = normalizePreferences({ terminalTheme: 'dark' })
  expect(prefs.defaultShell).toBeNull()
  expect(prefs.terminalFontFamily).toBeNull()
  expect(prefs.terminalTheme).toBe('dark')
})

it('persists local choices and rejects corrupted values', () => {
  expect(
    normalizePreferences({ defaultShell: '/bin/bash', terminalFontFamily: 'Consolas' }),
  ).toMatchObject({ defaultShell: '/bin/bash', terminalFontFamily: 'Consolas' })
  expect(
    normalizePreferences({ defaultShell: 'bad\0path', terminalFontFamily: 123 as never }),
  ).toMatchObject({ defaultShell: null, terminalFontFamily: null })
  expect(terminalFontStack('Font "name"')).toContain('"Font \\"name\\""')
  expect(terminalFontStack(null)).toContain(BUNDLED_TERMINAL_FONT)
})
