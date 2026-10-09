import { describe, expect, it } from 'vitest'

import {
  addMarkdownSidebarHistoryEntry,
  isMarkdownPath,
  MAX_MARKDOWN_SIDEBAR_HISTORY,
  parseMarkdownSidebarHistory,
  readMarkdownSidebarHistory,
  writeMarkdownSidebarHistory,
} from './markdownSidebarHistory'
import { writeScopedStorage } from './storageNamespace'

describe('markdown sidebar history', () => {
  it('accepts Markdown variants and rejects unrelated files', () => {
    expect(isMarkdownPath('README.md')).toBe(true)
    expect(isMarkdownPath('guide.MDX')).toBe(true)
    expect(isMarkdownPath('notes.markdown')).toBe(true)
    expect(isMarkdownPath('notes.txt')).toBe(false)
  })

  it('keeps the most recent unique 12 entries', () => {
    let tabs: { path: string; title: string }[] = []
    for (let index = 0; index < MAX_MARKDOWN_SIDEBAR_HISTORY + 2; index += 1) {
      tabs = addMarkdownSidebarHistoryEntry(tabs, {
        path: `C:\\docs\\${index}.md`,
        title: `${index}.md`,
      })
    }
    tabs = addMarkdownSidebarHistoryEntry(tabs, tabs[0])

    expect(tabs).toHaveLength(MAX_MARKDOWN_SIDEBAR_HISTORY)
    expect(tabs.at(-1)?.path).toBe('C:\\docs\\2.md')
    expect(tabs.filter((tab) => tab.path === 'C:\\docs\\2.md')).toHaveLength(1)
  })

  it('sanitizes malformed persisted data and restores a valid active path', () => {
    const history = parseMarkdownSidebarHistory(
      JSON.stringify({
        tabs: [
          { path: 'C:\\docs\\README.md', title: '', scope: null },
          { path: 'C:\\docs\\ignored.txt', title: 'ignored', scope: null },
          null,
        ],
        activePath: 'missing.md',
      }),
    )

    expect(history).toEqual({
      tabs: [{ path: 'C:\\docs\\README.md', title: 'README.md', scope: null }],
      activePath: 'C:\\docs\\README.md',
    })
  })

  it('round-trips a checkout scope and an explicit null; entries without either are dropped', () => {
    localStorage.clear()
    const tabs = [
      { path: 'C:\\repo\\docs\\x.md', title: 'x.md', scope: 'C:\\repo' },
      { path: 'C:\\docs\\picked.md', title: 'picked.md', scope: null },
    ]
    writeMarkdownSidebarHistory(tabs, 'C:\\docs\\picked.md')
    expect(readMarkdownSidebarHistory()).toStrictEqual({ tabs, activePath: 'C:\\docs\\picked.md' })

    const legacy = parseMarkdownSidebarHistory(
      JSON.stringify({ tabs: [{ path: 'C:\\docs\\old.md', title: 'old.md' }] }),
    )
    expect(legacy).toEqual({ tabs: [], activePath: null })
  })

  it('does not restore a history saved before scopes were recorded', () => {
    localStorage.clear()
    const v1 = { tabs: [{ path: 'C:\\repo\\docs\\x.md', title: 'x.md' }], activePath: null }
    writeScopedStorage('markdown-sidebar-history-v1', JSON.stringify(v1))
    expect(readMarkdownSidebarHistory()).toEqual({ tabs: [], activePath: null })
  })
})
