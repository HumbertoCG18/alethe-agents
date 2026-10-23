import { describe, expect, it } from 'vitest'

import { canFallBackTo, isValidRole } from './orchestrationSettings'

const row = (agent: string, readOnly: boolean) => ({
  name: `${agent}-${readOnly ? 'reader' : 'writer'}`,
  agent,
  model: null,
  effort: null,
  readOnly,
  timeoutSeconds: null,
})

// A Claude worker can run read-only on Read, Grep and Glob; agy has no read-only mode (#207).
describe('isValidRole', () => {
  it('accepts a read-only Claude role', () => {
    expect(isValidRole(row('claude', true))).toBe(true)
  })

  it('refuses a read-only Antigravity role', () => {
    expect(isValidRole(row('antigravity', true))).toBe(false)
  })
})

describe('canFallBackTo', () => {
  it('lets a read-only Codex reviewer fall back to a read-only Claude row', () => {
    expect(canFallBackTo(row('codex', true), row('claude', true))).toBe(true)
  })

  it('never lets a read-only Claude row fall back to a writable one', () => {
    expect(canFallBackTo(row('claude', true), row('claude', false))).toBe(false)
  })
})
