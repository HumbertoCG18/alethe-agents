import { describe, expect, it } from 'vitest'

import type { McpCatalogEntry } from '../../../lib/tauri'
import { registryReviewAllowsSubmit, registryReviewReducer } from './registryReview'

const ENTRY: McpCatalogEntry = {
  id: 'io.example/server',
  suggestedName: 'server',
  title: 'Example server',
  description: 'Example',
  version: '1.2.3',
  repositoryUrl: 'https://example.com/repository',
  installs: [],
}

describe('registry review acknowledgement', () => {
  // A registry listing is untrusted input, and the app's webview can reach every command.
  it('keeps only an http(s) repository address from the registry', () => {
    for (const repositoryUrl of ['javascript:alert(1)', 'file:///etc/passwd', 'tauri://x']) {
      const selected = registryReviewReducer(null, {
        type: 'select',
        entry: { ...ENTRY, repositoryUrl },
      })
      expect(selected?.repositoryUrl, repositoryUrl).toBeNull()
    }
    const plain = registryReviewReducer(null, {
      type: 'select',
      entry: { ...ENTRY, repositoryUrl: null },
    })
    expect(plain?.repositoryUrl).toBeNull()
  })

  it('blocks a newly selected registry config until explicitly acknowledged', () => {
    const selected = registryReviewReducer(null, { type: 'select', entry: ENTRY })

    expect(selected).toMatchObject({
      origin: ENTRY.id,
      title: ENTRY.title,
      version: ENTRY.version,
      repositoryUrl: ENTRY.repositoryUrl,
      acknowledged: false,
    })
    expect(registryReviewAllowsSubmit(selected)).toBe(false)

    const acknowledged = registryReviewReducer(selected, { type: 'acknowledge', value: true })
    expect(registryReviewAllowsSubmit(acknowledged)).toBe(true)
  })

  it('resets acknowledgement for a new selection and removes gating when registry review is reset', () => {
    const selected = registryReviewReducer(null, { type: 'select', entry: ENTRY })
    const acknowledged = registryReviewReducer(selected, { type: 'acknowledge', value: true })
    const replacement = registryReviewReducer(acknowledged, {
      type: 'select',
      entry: { ...ENTRY, id: 'io.example/other', title: 'Other server' },
    })

    expect(replacement?.acknowledged).toBe(false)
    expect(registryReviewAllowsSubmit(replacement)).toBe(false)

    const reset = registryReviewReducer(replacement, { type: 'reset' })
    expect(reset).toBeNull()
    expect(registryReviewAllowsSubmit(reset)).toBe(true)
  })
})
