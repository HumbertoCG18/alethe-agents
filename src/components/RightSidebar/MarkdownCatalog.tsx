import { ChevronDown, FileText, ListChecks, Search } from 'lucide-react'
import { useState } from 'react'

import { pathInside } from '../../lib/campaigns'
import { useT } from '../../lib/i18n'
import { basename, normalizeCwd } from '../../lib/paths'
import { SectionToggle } from '../../plugins/todos/SectionToggle'
import { useUiStore } from '../../stores/uiStore'
import styles from './RightSidebar.module.css'
import type { useMarkdownCatalog } from './useMarkdownCatalog'

const PAGE = 40
export function MarkdownCatalog({ catalog }: { catalog: ReturnType<typeof useMarkdownCatalog> }) {
  const t = useT()
  const open = useUiStore((s) => s.openMarkdownSidebar)
  const selected = useUiStore((s) => s.rightSidebarMarkdown?.path)
  const [query, setQuery] = useState('')
  const [pages, setPages] = useState<Record<string, number>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    active: true,
    campaigns: true,
    reports: true,
  })
  const [versions, setVersions] = useState<string | null>(null)
  const search = query.trim().toLocaleLowerCase()
  return (
    <nav className={styles.markdownCatalog} aria-label={t('rightSidebar.catalog.title')}>
      <div className={styles.catalogToolbar}>
        <div className={styles.catalogSearch}>
          <Search size={12} />
          <input
            type="search"
            aria-label={t('rightSidebar.catalog.search')}
            placeholder={t('rightSidebar.catalog.search')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setPages({})
            }}
          />
        </div>
        <button
          type="button"
          className={styles.headerAction}
          aria-pressed={catalog.showCompleted}
          aria-label={t('rightSidebar.catalog.completed', { count: catalog.hidden })}
          title={t('rightSidebar.catalog.completed', { count: catalog.hidden })}
          onClick={() => catalog.setShowCompleted(!catalog.showCompleted)}
        >
          <ListChecks size={14} />
        </button>
      </div>
      {catalog.loading ? <span role="status">{t('rightSidebar.catalog.refreshing')}</span> : null}
      {catalog.errors.length ? (
        <div role="alert">
          {t('rightSidebar.catalog.error')}
          <details>
            <summary>{t('rightSidebar.catalog.details')}</summary>
            {catalog.errors.map((e, i) => (
              <p key={i}>{e}</p>
            ))}
          </details>
        </div>
      ) : null}
      {catalog.sections.map((group) => {
        const matches = group.documents.filter(
          (d) => !search || `${d.title} ${d.relative}`.toLocaleLowerCase().includes(search),
        )
        if (!matches.length) return null
        const shown = pages[group.id] ?? PAGE
        const isOpen = Boolean(search || expanded[group.id])
        return (
          <section key={group.id}>
            <SectionToggle
              name={t(`rightSidebar.catalog.${group.id}`)}
              count={matches.length}
              open={isOpen}
              onToggle={() => setExpanded((previous) => ({ ...previous, [group.id]: !isOpen }))}
            />
            {isOpen
              ? matches.slice(0, shown).map((doc) => (
                  <div key={doc.relative} className={styles.catalogRow}>
                    <button
                      type="button"
                      aria-current={
                        selected &&
                        doc.variants.some((p) => normalizeCwd(selected) === normalizeCwd(p))
                          ? 'page'
                          : undefined
                      }
                      title={doc.path}
                      onClick={() => open(doc.path, doc.title)}
                    >
                      <FileText size={12} />
                      <span>{doc.title}</span>
                    </button>
                    {doc.variants.length > 1 ? (
                      <>
                        <button
                          type="button"
                          className={styles.catalogVersions}
                          aria-expanded={versions === doc.relative}
                          aria-label={t('rightSidebar.catalog.versions', {
                            count: doc.variants.length,
                            name: doc.title,
                          })}
                          onClick={() =>
                            setVersions(versions === doc.relative ? null : doc.relative)
                          }
                        >
                          <ChevronDown size={10} />
                          {doc.variants.length}
                        </button>
                        {versions === doc.relative ? (
                          <div className={styles.catalogVariantList}>
                            {doc.variants.map((path) => (
                              <button
                                type="button"
                                key={path}
                                title={path}
                                onClick={() => open(path, doc.title)}
                              >
                                {basename(
                                  catalog.roots
                                    .filter((r) => pathInside(path, r))
                                    .sort((a, b) => b.length - a.length)[0] ?? path,
                                )}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                ))
              : null}
            {isOpen && matches.length > shown ? (
              <div className={styles.catalogPaging}>
                <span>
                  {t('rightSidebar.catalog.page', {
                    shown: Math.min(shown, matches.length),
                    total: matches.length,
                  })}
                </span>
                <button
                  type="button"
                  onClick={() => setPages((p) => ({ ...p, [group.id]: shown + PAGE }))}
                >
                  {t('rightSidebar.catalog.more')}
                </button>
              </div>
            ) : null}
          </section>
        )
      })}
    </nav>
  )
}
