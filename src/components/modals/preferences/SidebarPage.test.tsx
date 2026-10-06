import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Star } from 'lucide-react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { sidebarTabContributions } from '../../../lib/plugins'
import { EMPTY_PROJECTS_FILE } from '../../../lib/types'
import { useProjectsStore } from '../../../stores/projectsStore'
import { SidebarPage } from './SidebarPage'

const icons = () => useProjectsStore.getState().preferences.sidebarIcons
const rows = (bar: string) =>
  within(screen.getByRole('list', { name: bar }))
    .getAllByRole('switch')
    .map((toggle) => toggle.getAttribute('aria-label'))

beforeEach(() => {
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: false })
})
afterEach(cleanup)

describe('Sidebar preferences', () => {
  it('lists both bars, Home and the fallback views locked on', () => {
    render(<SidebarPage />)

    expect(rows('Left sidebar')).toEqual(['Home', 'Projects', 'Files'])
    expect(rows('Right sidebar')).toEqual(['Markdown', 'MCP', 'Jev history', 'PRs', 'Plugins'])
    for (const name of ['Home', 'Projects', 'Markdown']) {
      const locked = screen.getByRole('switch', { name })
      expect(locked).toBeDisabled()
      expect(locked).toHaveAttribute('aria-checked', 'true')
    }
  })

  it('hides and shows an icon', () => {
    render(<SidebarPage />)
    const jev = screen.getByRole('switch', { name: 'Jev history' })

    fireEvent.click(jev)
    expect(icons().hidden).toEqual(['jev'])
    expect(jev).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(jev)
    expect(icons().hidden).toEqual([])
  })

  it('reorders within a bar from the keyboard and keeps the order', () => {
    render(<SidebarPage />)

    fireEvent.keyDown(screen.getByRole('button', { name: 'Move Files' }), { key: 'ArrowUp' })
    expect(icons().left).toEqual(['files', 'projects'])
    expect(rows('Left sidebar')).toEqual(['Home', 'Files', 'Projects'])
    fireEvent.keyDown(screen.getByRole('button', { name: 'Move Plugins' }), { key: 'ArrowDown' })
    expect(icons().right).toEqual([])
  })

  it('puts a newly added view at its default place in a saved order', () => {
    useProjectsStore.getState().setPreferences({
      sidebarIcons: { left: [], right: ['plugins', 'markdown'], hidden: [] },
    })
    const view = sidebarTabContributions.add('test', {
      id: 'test.view',
      pluginId: 'test',
      side: 'right',
      icon: Star,
      label: 'Test view',
      component: null,
    })
    try {
      render(<SidebarPage />)
      expect(rows('Right sidebar')).toEqual([
        'Plugins',
        'Markdown',
        'Test view',
        'MCP',
        'Jev history',
        'PRs',
      ])
    } finally {
      view.dispose()
    }
  })
})
