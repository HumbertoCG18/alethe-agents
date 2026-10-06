import { useProjectsStore } from '../stores/projectsStore'
import type { SidebarSide } from './plugins'
import type { Preferences } from './types'

type SidebarIconPrefs = Preferences['sidebarIcons']

/**
 * Icons that keep the app reachable, so they can't be hidden: Home is the start view, and Projects
 * and Markdown are where the left and right bars fall back when their open view goes away.
 */
export const LOCKED_SIDEBAR_ICONS: ReadonlySet<string> = new Set(['home', 'projects', 'markdown'])

/**
 * A bar's movable icons in their default order: its built-in views around the contributed views
 * placed in it. Home stays first in the left bar, outside the order.
 */
export function sidebarIconIds(
  side: SidebarSide,
  contributed: readonly string[],
  shown: { gsdSync?: boolean; mcp?: boolean; prs?: boolean } = {},
): string[] {
  if (side === 'left') return ['projects', 'files', ...contributed]
  return [
    'markdown',
    ...(shown.gsdSync ? ['gsdSync'] : []),
    ...contributed,
    ...(shown.mcp ? ['mcp'] : []),
    'jev',
    ...(shown.prs ? ['prs'] : []),
    'plugins',
  ]
}

/**
 * `ids`, a bar's icons in default order, in the `saved` order. An icon the saved order does not
 * know yet, such as a newly added view, goes right after its default predecessor.
 */
export function arrangeSidebarIcons(ids: readonly string[], saved: readonly string[]): string[] {
  const order = saved.filter((id) => ids.includes(id))
  ids.forEach((id, index) => {
    if (order.includes(id)) return
    const before = ids
      .slice(0, index)
      .reverse()
      .find((previous) => order.includes(previous))
    order.splice(before ? order.indexOf(before) + 1 : 0, 0, id)
  })
  return order
}

/** The setting with every list present, whatever shape was stored or synced. */
export function sidebarIconPrefs(raw: Partial<SidebarIconPrefs> | undefined): SidebarIconPrefs {
  const list = (value: unknown) => (Array.isArray(value) ? (value as string[]) : [])
  return { left: list(raw?.left), right: list(raw?.right), hidden: list(raw?.hidden) }
}

export const sidebarIconHidden = (id: string, prefs: Partial<SidebarIconPrefs> | undefined) =>
  !LOCKED_SIDEBAR_ICONS.has(id) && sidebarIconPrefs(prefs).hidden.includes(id)

/** What a bar shows of `ids`: arranged as the user saved it, hidden icons left out. */
export function visibleSidebarIcons(
  side: SidebarSide,
  ids: readonly string[],
  raw: Partial<SidebarIconPrefs> | undefined,
): string[] {
  const prefs = sidebarIconPrefs(raw)
  return arrangeSidebarIcons(ids, prefs[side]).filter((id) => !sidebarIconHidden(id, prefs))
}

export function useVisibleSidebarIcons(side: SidebarSide, ids: readonly string[]): string[] {
  const prefs = useProjectsStore((state) => state.preferences.sidebarIcons)
  return visibleSidebarIcons(side, ids, prefs)
}
