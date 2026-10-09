import { basename } from './paths'
import { readScopedStorage, writeScopedStorage } from './storageNamespace'

export const MAX_MARKDOWN_SIDEBAR_HISTORY = 12
// v1 saved no scope, so a document named by repository text would come back unrestricted: it is
// not restored.
const STORAGE_KEY = 'markdown-sidebar-history-v2'
const MARKDOWN_PATH_PATTERN = /\.(md|markdown|mdx)$/i

export type MarkdownSidebarHistoryEntry = {
  path: string
  title: string
  /**
   * The checkout of a document named by repository text, or null for one opened by hand. Always
   * saved; an entry without it is dropped.
   */
  scope?: string | null
}

export type MarkdownSidebarHistory = {
  tabs: MarkdownSidebarHistoryEntry[]
  activePath: string | null
}

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_PATH_PATTERN.test(path.trim())
}

export function addMarkdownSidebarHistoryEntry(
  tabs: MarkdownSidebarHistoryEntry[],
  entry: MarkdownSidebarHistoryEntry,
): MarkdownSidebarHistoryEntry[] {
  const normalized = normalizeEntry(entry)
  if (!normalized) return tabs
  return [...tabs.filter((tab) => tab.path !== normalized.path), normalized].slice(
    -MAX_MARKDOWN_SIDEBAR_HISTORY,
  )
}

export function parseMarkdownSidebarHistory(raw: string | null): MarkdownSidebarHistory {
  if (!raw) return { tabs: [], activePath: null }
  try {
    const value = JSON.parse(raw) as { tabs?: unknown; activePath?: unknown }
    const source = Array.isArray(value.tabs) ? value.tabs : []
    let tabs: MarkdownSidebarHistoryEntry[] = []
    for (const candidate of source) {
      if (!candidate || typeof candidate !== 'object') continue
      const entry = candidate as { path?: unknown; title?: unknown; scope?: unknown }
      if (typeof entry.path !== 'string' || typeof entry.title !== 'string') continue
      if (entry.scope !== null && typeof entry.scope !== 'string') continue
      tabs = addMarkdownSidebarHistoryEntry(tabs, {
        path: entry.path,
        title: entry.title,
        scope: entry.scope,
      })
    }
    const requestedActivePath = typeof value.activePath === 'string' ? value.activePath.trim() : ''
    const activePath = tabs.some((tab) => tab.path === requestedActivePath)
      ? requestedActivePath
      : (tabs[tabs.length - 1]?.path ?? null)
    return { tabs, activePath }
  } catch {
    return { tabs: [], activePath: null }
  }
}

export function readMarkdownSidebarHistory(): MarkdownSidebarHistory {
  return parseMarkdownSidebarHistory(readScopedStorage(STORAGE_KEY, true))
}

export function writeMarkdownSidebarHistory(
  tabs: MarkdownSidebarHistoryEntry[],
  activePath: string | null,
): void {
  try {
    writeScopedStorage(STORAGE_KEY, JSON.stringify({ tabs, activePath }))
  } catch (error) {
    console.warn('[markdown-sidebar] could not persist history:', error)
  }
}

function normalizeEntry(entry: MarkdownSidebarHistoryEntry): MarkdownSidebarHistoryEntry | null {
  const path = entry.path.trim()
  if (!path || !isMarkdownPath(path)) return null
  return {
    path,
    title: entry.title.trim() || basename(path) || path,
    scope: entry.scope || null,
  }
}
