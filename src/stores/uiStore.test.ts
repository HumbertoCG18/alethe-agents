import { beforeEach, describe, expect, it } from 'vitest'

import { useUiStore } from './uiStore'

describe('closeMarkdownSidebarTab', () => {
  beforeEach(() => localStorage.clear())

  it('keeps the Markdown view when the last tab is closed', () => {
    useUiStore.getState().openMarkdownSidebar('/repo/README.md', 'README')
    useUiStore.getState().closeMarkdownSidebarTab('/repo/README.md')

    const state = useUiStore.getState()
    expect(state.rightSidebarMode).toBe('markdown')
    expect(state.rightSidebarMarkdown).toBeNull()
    expect(state.rightSidebarMarkdownTabs).toEqual([])
  })

  it('restores each tab with its checkout, or with an explicit null for one opened by hand', () => {
    const ui = useUiStore.getState()
    ui.openMarkdownSidebar('/repo/docs/x.md', 'x.md', '/repo')
    ui.openMarkdownSidebar('/picked.md', 'picked.md')
    useUiStore.setState({ rightSidebarMarkdown: null, rightSidebarMarkdownTabs: [] })
    useUiStore.getState().restoreMarkdownSidebarHistory()

    expect(useUiStore.getState().rightSidebarMarkdownTabs).toStrictEqual([
      { path: '/repo/docs/x.md', title: 'x.md', scope: '/repo' },
      { path: '/picked.md', title: 'picked.md', scope: null },
    ])
    expect(useUiStore.getState().rightSidebarMarkdown?.scope).toBeNull()
  })
})
