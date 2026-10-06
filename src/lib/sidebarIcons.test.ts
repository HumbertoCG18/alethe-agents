import { describe, expect, it } from 'vitest'

import { arrangeSidebarIcons, sidebarIconIds, visibleSidebarIcons } from './sidebarIcons'

describe('sidebar icons', () => {
  it('lists each bar in its default order, with the views placed in it', () => {
    expect(sidebarIconIds('left', ['git'])).toEqual(['projects', 'files', 'git'])
    expect(sidebarIconIds('right', ['todos'], { mcp: true, prs: false, gsdSync: false })).toEqual([
      'markdown',
      'todos',
      'mcp',
      'jev',
      'plugins',
    ])
  })

  it('follows the saved order and forgets icons the bar no longer has', () => {
    expect(arrangeSidebarIcons(['projects', 'files'], ['files', 'gone', 'projects'])).toEqual([
      'files',
      'projects',
    ])
  })

  it('puts a view the saved order does not know right after its default predecessor', () => {
    const ids = sidebarIconIds('right', ['todos', 'new.view'])
    expect(arrangeSidebarIcons(ids, ['plugins', 'jev', 'todos', 'markdown'])).toEqual([
      'plugins',
      'jev',
      'todos',
      'new.view',
      'markdown',
    ])
    expect(arrangeSidebarIcons(['first', 'projects'], ['projects'])).toEqual(['first', 'projects'])
  })

  it('reads a partial setting, as an older synced one, without failing', () => {
    const partial = { left: ['files'], right: [] } as unknown as Parameters<
      typeof visibleSidebarIcons
    >[2]
    expect(visibleSidebarIcons('left', ['projects', 'files'], partial)).toEqual([
      'projects',
      'files',
    ])
    expect(visibleSidebarIcons('right', ['markdown'], {} as typeof partial)).toEqual(['markdown'])
  })

  it('leaves hidden icons out of a bar, but never the ones that keep the app reachable', () => {
    const prefs = { left: [], right: [], hidden: ['projects', 'git', 'markdown', 'jev'] }
    expect(visibleSidebarIcons('left', ['projects', 'files', 'git'], prefs)).toEqual([
      'projects',
      'files',
    ])
    expect(visibleSidebarIcons('right', ['markdown', 'jev', 'plugins'], prefs)).toEqual([
      'markdown',
      'plugins',
    ])
  })
})
