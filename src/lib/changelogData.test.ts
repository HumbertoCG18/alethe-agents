import { describe, expect, it } from 'vitest'

import packageJson from '../../package.json'
import { CHANGELOG_RELEASES, CURRENT_VERSION } from './changelogData'

describe("What's New releases", () => {
  it('start at the version being shipped', () => {
    // The list is kept by hand; this fails a release that forgets to update it (#69, #213).
    expect(CHANGELOG_RELEASES[0].version).toBe(packageJson.version)
    expect(CURRENT_VERSION).toBe(packageJson.version)
  })
})
