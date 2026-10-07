import { useCallback, useEffect, useMemo, useState } from 'react'

import { pathInside } from '../../lib/campaigns'
import { isMarkdownPath } from '../../lib/markdownSidebarHistory'
import { basename, normalizeCwd } from '../../lib/paths'
import { resolveProjectCheckout } from '../../lib/projectCheckout'
import { findRelativePath, listProjectMarkdown } from '../../lib/tauri'
import { useCampaignView } from '../../plugins/todos/campaignView'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'

type Document = { path: string; title: string; campaigns: string[] }

type Catalog = {
  projectId: string | null
  roots: string[]
  documents: Document[]
  errors: string[]
}

const empty: Catalog = { projectId: null, roots: [], documents: [], errors: [] }

const groups = ['active', 'campaigns', 'reports', 'other'] as const

export function useMarkdownCatalog() {
  const projectId = useProjectsStore((s) => s.activeProjectId)

  const folder = useProjectsStore((s) => {
    const p = s.projects.find((p) => p.id === s.activeProjectId)
    return `${p?.checkoutPath ?? ''}\n${p?.defaultCwd ?? ''}`
  })

  const history = useUiStore((s) => s.rightSidebarMarkdownTabs)

  const { registry, activeId } = useCampaignView()

  const [result, setResult] = useState<Catalog>(empty)

  const [revision, setRevision] = useState(0)

  const [loading, setLoading] = useState(false)

  const reload = useCallback(() => setRevision((n) => n + 1), [])

  useEffect(() => {
    window.addEventListener('focus', reload)
    return () => window.removeEventListener('focus', reload)
  }, [reload])

  useEffect(() => {
    if (!projectId) {
      setResult(empty)
      setLoading(false)
      return
    }

    let cancelled = false

    setLoading(true)

    void (async () => {
      const { root, checkouts } = await resolveProjectCheckout(projectId)

      const roots = [
        ...new Map(
          [root, ...(checkouts?.worktrees.map((w) => w.path) ?? [])]
            .filter(Boolean)
            .map((p) => [normalizeCwd(p), p]),
        ).values(),
      ]

      const documents = new Map<string, Document>()

      const errors: string[] = []

      const add = (path: string, campaign?: string) => {
        if (!isMarkdownPath(path) || !roots.some((root) => pathInside(path, root))) return

        const key = normalizeCwd(path)

        const doc = documents.get(key) ?? { path, title: basename(path), campaigns: [] }

        if (campaign && !doc.campaigns.includes(campaign)) doc.campaigns.push(campaign)

        documents.set(key, doc)
      }

      await Promise.all(
        roots.map(async (root) => {
          try {
            ;(await listProjectMarkdown(root)).forEach((path) => add(path))
          } catch (error) {
            errors.push(`${root}: ${String(error)}`)
          }
        }),
      )

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
              try {
                const found = await findRelativePath(registry.main, ref)
                if (found) add(found, campaign.id)
              } catch (error) {
                errors.push(`${ref}: ${String(error)}`)
              }
            }
          }),
        )

      if (!cancelled) setResult({ projectId, roots, documents: [...documents.values()], errors })
    })()
      .catch((error) => {
        if (!cancelled) setResult({ ...empty, projectId, errors: [String(error)] })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [projectId, folder, registry, revision])

  const current = result.projectId === projectId ? result : empty

  const sections = useMemo(() => {
    const docs = new Map(current.documents.map((d) => [normalizeCwd(d.path), d]))

    for (const tab of history) {
      if (
        current.roots.some((root) => pathInside(tab.path, root)) &&
        !docs.has(normalizeCwd(tab.path))
      )
        docs.set(normalizeCwd(tab.path), { ...tab, campaigns: [] })
    }

    const grouped: Record<(typeof groups)[number], Document[]> = {
      active: [],
      campaigns: [],
      reports: [],
      other: [],
    }

    for (const doc of docs.values()) {
      const path = doc.path.replace(/\\/g, '/')

      const group =
        activeId && doc.campaigns.includes(activeId)
          ? 'active'
          : doc.campaigns.length || /\/(?:campaigns|campanhas|\.workflow)\//i.test(path)
            ? 'campaigns'
            : /(?:report|relatorio|relatório)/i.test(path)
              ? 'reports'
              : 'other'

      grouped[group].push(doc)
    }

    return groups
      .map((id) => ({
        id,
        documents: grouped[id].sort(
          (a, b) => a.title.localeCompare(b.title) || a.path.localeCompare(b.path),
        ),
      }))
      .filter((g) => g.documents.length)
  }, [current, history, activeId])

  return { ...current, sections, loading, reload }
}
