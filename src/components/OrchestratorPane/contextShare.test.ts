import { describe, expect, it } from 'vitest'

import { contextShare } from './contextShare'

describe('contextShare', () => {
  // #279: the total adds up every turn's re-read prompt; the window only holds the last turn.
  it('measures the last turn against the window, not the running total', () => {
    const tokens = {
      total: { totalTokens: 1_102_331 },
      last: { totalTokens: 96_283 },
      modelContextWindow: 258_400,
    }
    expect(contextShare({ tokens })).toBe(37)
  })

  it('shows nothing without a last-turn count or a window', () => {
    expect(
      contextShare({ tokens: { total: { totalTokens: 500 }, modelContextWindow: 1000 } }),
    ).toBeNull()
    expect(contextShare({ tokens: { last: { totalTokens: 500 } } })).toBeNull()
    expect(contextShare({})).toBeNull()
  })
})
