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
})
