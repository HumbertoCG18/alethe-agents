import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { pathInside } from '../../lib/campaigns'
import { useT } from '../../lib/i18n'
import { isMarkdownPath } from '../../lib/markdownSidebarHistory'
import { normalizeMarkdownMaxAge } from '../../lib/markdownSummary'
import { basename, normalizeCwd } from '../../lib/paths'
import { resolveProjectCheckout } from '../../lib/projectCheckout'
import { readScopedStorage, writeScopedStorage } from '../../lib/storageNamespace'
import { findRelativePath, listProjectMarkdown } from '../../lib/tauri'
import { useCampaignView } from '../../plugins/todos/campaignView'
import { useProjectsStore } from '../../stores/projectsStore'

type Document = {
  path: string
  title: string
  campaigns: string[]
  relative: string
  variants: string[]
}
type Catalog = { key: string; roots: string[]; documents: Document[]; errors: string[] }
const empty: Catalog = { key: '', roots: [], documents: [], errors: [] }
const groups = ['active', 'campaigns', 'reports', 'other'] as const
// Share overlapping discovery, including focus events, without retaining every project forever.
const scans = new Map<string, { promise: Promise<string[]>; pending: boolean; expires: number }>()
function scan(root: string, refresh: boolean, timeoutMessage: string) {
  const key = normalizeCwd(root)
  const saved = scans.get(key)
  if (saved && (saved.pending || (!refresh && saved.expires > Date.now()))) return saved.promise
  let timer: ReturnType<typeof setTimeout>
  const entry = {
    promise: Promise.race([
      listProjectMarkdown(root),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), 10_000)
      }),
    ]),
    pending: true,
    expires: 0,
  }
  scans.set(key, entry)
  void entry.promise.then(
    () => {
      clearTimeout(timer)
      entry.pending = false
      entry.expires = Date.now() + 30_000
    },
    () => {
      clearTimeout(timer)
      if (scans.get(key) === entry) scans.delete(key)
    },
  )
  if (scans.size > 32)
    for (const [key, value] of scans) {
      if (!value.pending && scans.size > 32) scans.delete(key)
    }
  return entry.promise
}
function cached(key: string): Catalog {
  try {
    const raw = readScopedStorage(key)
    if (!raw || raw.length > 2_000_000) return empty
    const value = JSON.parse(raw) as Catalog
    if (
      value.key !== key ||
      !Array.isArray(value.roots) ||
      !value.roots.every((r) => typeof r === 'string') ||
      !Array.isArray(value.documents) ||
      value.documents.length > 20_000
    )
      return empty
    const documents = value.documents.filter(
      (d) =>
        d &&
        typeof d.path === 'string' &&
        typeof d.title === 'string' &&
        typeof d.relative === 'string' &&
        Array.isArray(d.campaigns) &&
        d.campaigns.every((c) => typeof c === 'string') &&
        Array.isArray(d.variants) &&
        d.variants.every(
          (p) => typeof p === 'string' && value.roots.some((r) => pathInside(p, r)),
        ) &&
        value.roots.some((r) => pathInside(d.path, r)),
    )
    return { key, roots: value.roots, documents, errors: [] }
  } catch {
    return empty
  }
}

/** Recover a missing prefix only when one logical project document matches, never by name alone. */
export function recoverCatalogPath(
  path: string,
  roots: string[],
  documents: Document[],
): string | null {
  const root = roots.filter((r) => pathInside(path, r)).sort((a, b) => b.length - a.length)[0]
  if (!root) return null
  const relative = normalizeCwd(path)
    .replace(/\\/g, '/')
    .slice(normalizeCwd(root).length + 1)
  if (relative.split('/').length < 2) return null
  const matches = documents.filter(
    (d) =>
      normalizeCwd(d.relative).replace(/\\/g, '/') === relative ||
      normalizeCwd(d.relative)
        .replace(/\\/g, '/')
        .endsWith('/' + relative),
  )
  return matches.length === 1 ? matches[0].path : null
}

export function useMarkdownCatalog() {
  const timeoutMessage = useT()('rightSidebar.catalog.timeout')
  const projectId = useProjectsStore((s) => s.activeProjectId)
  const profileId = useProjectsStore((s) => s.activeProfileId)
  const folder = useProjectsStore((s) => {
    const p = s.projects.find((p) => p.id === s.activeProjectId)
    return `${p?.checkoutPath ?? ''}\n${p?.defaultCwd ?? ''}`
  })
  const key = `markdown-development-catalog-v1:${profileId}:${projectId}:${folder}`
  const { registry, activeId } = useCampaignView()
  // Parsed once per project key; the stored index can be up to 2 MB.
  const stored = useMemo(() => cached(key), [key])
  const [result, setResult] = useState<Catalog>(stored)
  const [revision, setRevision] = useState({ id: 0, force: false })
  const [loading, setLoading] = useState(false)
  const [showCompleted, setShowCompleted] = useState(false)
  const lastRun = useRef(0)
  const reload = useCallback(() => setRevision((n) => ({ id: n.id + 1, force: true })), [])
  useEffect(() => {
    // Focus revalidation uses the shared short-lived index, unlike explicit Refresh, and is
    // throttled so switching windows does not rebuild the index each time.
    const focus = () => {
      if (Date.now() - lastRun.current >= 60_000)
        setRevision((n) => ({ id: n.id + 1, force: false }))
    }
    window.addEventListener('focus', focus)
    return () => window.removeEventListener('focus', focus)
  }, [])
  useEffect(() => {
    if (!projectId) {
      setResult(empty)
      setLoading(false)
      return
    }
    lastRun.current = Date.now()
    let cancelled = false
    const saved = stored
    setResult((previous) => (previous.key === key ? previous : saved))
    setLoading(true)
    let timer: ReturnType<typeof setTimeout>
    const work = (async () => {
      const { root, checkouts } = await resolveProjectCheckout(projectId)
      const roots = [
        ...new Map(
          [root, ...(checkouts?.worktrees.map((w) => w.path) ?? [])]
            .filter(Boolean)
            .map((p) => [normalizeCwd(p), p]),
        ).values(),
      ]
      if (cancelled) return
      // Scope and error recovery must not wait for the complete document index.
      setResult((previous) => ({ ...(previous.key === key ? previous : empty), key, roots }))
      const documents = new Map<string, Document>()
      const errors: string[] = []
      const add = (path: string, campaign?: string) => {
        if (!isMarkdownPath(path)) return
        const root = roots.filter((r) => pathInside(path, r)).sort((a, b) => b.length - a.length)[0]
        if (!root) return
        const relative = normalizeCwd(path)
          .slice(normalizeCwd(root).length + 1)
          .replace(/\\/g, '/')
        const id = normalizeCwd(relative)
        const doc = documents.get(id) ?? {
          path,
          title: basename(path),
          relative,
          campaigns: [],
          variants: [],
        }
        if (!doc.variants.some((p) => normalizeCwd(p) === normalizeCwd(path)))
          doc.variants.push(path)
        if (campaign && !doc.campaigns.includes(campaign)) doc.campaigns.push(campaign)
        documents.set(id, doc)
      }
      // Preserve root ordering: prefer the selected checkout, while exposing other versions.
      const files = await Promise.all(
        roots.map(async (r) => {
          try {
            return await scan(r, revision.force || saved.key !== key, timeoutMessage)
          } catch (e) {
            errors.push(`${r}: ${String(e)}`)
            return []
          }
        }),
      )
      if (cancelled) return
      files.forEach((paths) => paths.forEach((p) => add(p)))
      const references = new Map<string, Promise<Array<string | null>>>()
      if (registry)
        await Promise.all(
          registry.campaigns.map(async (campaign) => {
            const refs = [
              ...new Set(
                [campaign.handoff, ...campaign.tasks.map((t) => t.evidence)].filter(
                  (p): p is string => Boolean(p && isMarkdownPath(p)),
                ),
              ),
            ]
            for (const ref of refs) {
              if (cancelled) return
              try {
                const source = roots
                  .filter((r) => pathInside(ref, r))
                  .sort((a, b) => b.length - a.length)[0]
                const relative = source
                  ? normalizeCwd(ref).slice(normalizeCwd(source).length + 1)
                  : ref
                let copies = references.get(relative)
                if (!copies) {
                  copies = Promise.all(
                    roots.map(async (r) => {
                      const found = await findRelativePath(r, relative)
                      return found && pathInside(found, r) ? found : null
                    }),
                  )
                  references.set(relative, copies)
                }
                const found = await copies
                if (!cancelled)
                  found.forEach((path) => {
                    if (path) add(path, campaign.id)
                  })
              } catch (e) {
                errors.push(`${ref}: ${String(e)}`)
              }
            }
          }),
        )
      if (cancelled) return
      const next = { key, roots, documents: [...documents.values()], errors }
      setResult(next)
      try {
        const raw = JSON.stringify({ ...next, errors: [] })
        // ponytail: at most 2 MB per project index; large catalogs still work without disk caching.
        if (raw.length <= 2_000_000) writeScopedStorage(key, raw)
      } catch {
        /* Storage availability must not block discovery. */
      }
    })()
    void Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), 15_000)
      }),
    ])
      .catch((error) => {
        if (!cancelled)
          setResult((previous) => ({
            ...(previous.key === key ? previous : empty),
            key,
            errors: [String(error)],
          }))
      })
      .finally(() => {
        clearTimeout(timer)
        if (!cancelled) setLoading(false)
        cancelled = true
      })
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [projectId, profileId, folder, key, stored, registry, revision, timeoutMessage])
  const current = result.key === key ? result : stored
  const maxAge = normalizeMarkdownMaxAge(
    useProjectsStore((s) => s.preferences.markdownCatalogMaxAgeDays),
  )
  const { sections, hidden } = useMemo(() => {
    const docs = new Map(current.documents.map((d) => [normalizeCwd(d.relative), d]))
    const concluded = new Set(
      registry?.campaigns.filter((c) => c.situation.kind === 'done').map((c) => c.id),
    )
    const cutoff = maxAge ? Date.now() - maxAge * 86_400_000 : null
    const grouped: Record<(typeof groups)[number], Document[]> = {
      active: [],
      campaigns: [],
      reports: [],
      other: [],
    }
    let hidden = 0
    for (const doc of docs.values()) {
      const openCampaign = doc.campaigns.some((id) => !concluded.has(id))
      const old = cutoff !== null && !openCampaign && pathDate(doc.relative) < cutoff
      if (!showCompleted && (old || (doc.campaigns.length > 0 && !openCampaign))) {
        hidden++
        continue
      }
      const group =
        activeId && doc.campaigns.includes(activeId)
          ? 'active'
          : doc.campaigns.length
            ? 'campaigns'
            : /(?:report|relatorio|relatório)/i.test(doc.relative)
              ? 'reports'
              : 'other'
      grouped[group].push(doc)
    }
    const sections = groups
      .map((id) => ({
        id,
        documents: grouped[id].sort(
          (a, b) => a.title.localeCompare(b.title) || a.relative.localeCompare(b.relative),
        ),
      }))
      .filter((g) => g.documents.length)
    return { sections, hidden }
  }, [current, activeId, registry, showCompleted, maxAge])
  return { ...current, sections, hidden, loading, reload, showCompleted, setShowCompleted }
}

/** Newest YYYY-MM-DD in a document path, as a timestamp; undated paths never count as old. */
function pathDate(relative: string): number {
  const dates = [...relative.matchAll(/(?<!\d)(20\d\d-[01]\d-[0-3]\d)(?!\d)/g)]
    .map((m) => Date.parse(m[1]))
    .filter((time) => !Number.isNaN(time))
  return dates.length ? Math.max(...dates) : Infinity
}
