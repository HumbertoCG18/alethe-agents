import { describe, expect, it } from 'vitest'

import packageJson from '../../package.json'
import { CHANGELOG_RELEASES, CURRENT_VERSION, formatReleaseDate } from './changelogData'

describe("What's New releases", () => {
  it('start at the version being shipped', () => {
    // The list is kept by hand; this fails a release that forgets to update it (#69, #213).
    expect(CHANGELOG_RELEASES[0].version).toBe(packageJson.version)
    expect(CURRENT_VERSION).toBe(packageJson.version)
  })

  it('show the release day for viewers west of UTC', () => {
    const previous = process.env.TZ
    process.env.TZ = 'America/Sao_Paulo'
    try {
      expect(formatReleaseDate('2026-09-20', 'pt-BR')).toBe('20/09/2026')
      expect(formatReleaseDate('2026-09-20', 'en-US')).toBe('9/20/2026')
    } finally {
      if (previous === undefined) delete process.env.TZ
      else process.env.TZ = previous
    }
  })
})
