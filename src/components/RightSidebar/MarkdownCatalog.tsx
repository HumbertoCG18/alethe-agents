import { useT } from '../../lib/i18n'
import { normalizeCwd } from '../../lib/paths'
import { useUiStore } from '../../stores/uiStore'
import styles from './RightSidebar.module.css'
import type { useMarkdownCatalog } from './useMarkdownCatalog'

export function MarkdownCatalog({ catalog }: { catalog: ReturnType<typeof useMarkdownCatalog> }) {
  const t = useT()

  const open = useUiStore((s) => s.openMarkdownSidebar)

  const selected = useUiStore((s) => s.rightSidebarMarkdown?.path)

  return (
    <nav className={styles.markdownCatalog} aria-label={t('rightSidebar.catalog.title')}>
      {catalog.loading ? <span role="status">{t('ui.markdown.loading')}</span> : null}

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

      {catalog.sections.map((group) => (
        <details key={group.id} open>
          <summary>
            {t(`rightSidebar.catalog.${group.id}`)} <span>{group.documents.length}</span>
          </summary>

          {group.documents.map((doc) => (
            <button
              key={doc.path}
              type="button"
              aria-current={
                selected && normalizeCwd(selected) === normalizeCwd(doc.path) ? 'page' : undefined
              }
              title={doc.path}
              onClick={() => open(doc.path, doc.title)}
            >
              {doc.title}
            </button>
          ))}
        </details>
      ))}
    </nav>
  )
}
