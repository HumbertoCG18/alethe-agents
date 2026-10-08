import { ExternalLink, GitPullRequest, LoaderCircle, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useT } from '../../lib/i18n'
import { githubPrListMine, type MyPullRequestSummary, openInBrowser } from '../../lib/tauri'
import { getProjectRepoRoot } from '../../lib/terminalFactory'
import { useTodosStore } from '../../plugins/todos/store'
import { useProjectsStore } from '../../stores/projectsStore'
import styles from './PullRequestsSidebar.module.css'

export function PullRequestsSidebar() {
  const t = useT()
  const todos = useTodosStore((state) => state.todos)
  const createTodoFromPullRequest = useTodosStore((state) => state.createTodoFromPullRequest)
  const activeProject = useProjectsStore((state) =>
    state.projects.find((project) => project.id === state.activeProjectId),
  )
  // The project's own folder first: it may have no terminal, and PRs must never come from elsewhere.
  const repo =
    activeProject?.checkoutPath || activeProject?.defaultCwd || getProjectRepoRoot(activeProject)
  const [prs, setPrs] = useState<MyPullRequestSummary[]>([])
  const [loading, setLoading] = useState(Boolean(repo))
  const [error, setError] = useState<string | null>(null)
  // Only the latest request fills the panel: a project switch outdates the one still running.
  const latest = useRef(0)

  const load = useCallback(async () => {
    const request = ++latest.current
    setError(null)
    if (!repo) {
      setPrs([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const result = await githubPrListMine(repo)
      if (request === latest.current) setPrs(result)
    } catch (err) {
      if (request === latest.current) setError(String(err))
    } finally {
      if (request === latest.current) setLoading(false)
    }
  }, [repo])

  useEffect(() => {
    void load()
  }, [load])

  const isLinked = (pr: MyPullRequestSummary) =>
    todos.some((todo) => todo.prRepo === pr.repo && todo.prNumber === pr.number)

  return (
    <aside className={styles.sidebar} aria-label={t('prs.title')}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <GitPullRequest size={16} />
          <span>{t('prs.title')}</span>
          <span className={styles.scope} title={repo || undefined}>
            {t('prs.scopeProject', { project: activeProject?.name ?? '' })}
          </span>
        </div>
        <button
          type="button"
          className={styles.refreshButton}
          onClick={() => void load()}
          disabled={loading}
          title={t('prs.refresh')}
          aria-label={t('prs.refresh')}
        >
          <RefreshCw size={13} className={loading ? styles.spinning : undefined} />
        </button>
      </header>

      <div className={styles.content}>
        {loading ? (
          <div className={styles.state}>
            <LoaderCircle size={16} className={styles.spin} />
            <span>{t('prs.loading')}</span>
          </div>
        ) : error ? (
          <div className={styles.error}>{error}</div>
        ) : prs.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.emptyIcon}>
              <GitPullRequest size={20} />
            </div>
            <strong>{t(repo ? 'prs.emptyTitle' : 'prs.noRepoTitle')}</strong>
            <span>{t(repo ? 'prs.emptyDescriptionProject' : 'prs.noRepoDescription')}</span>
          </div>
        ) : (
          <div className={styles.list}>
            {prs.map((pr) => {
              const linked = isLinked(pr)
              return (
                <article key={`${pr.repo}#${pr.number}`} className={styles.card}>
                  <div className={styles.cardTop}>
                    <span className={styles.repo} title={pr.repo}>
                      {pr.repo}
                    </span>
                    <span className={styles.number}>#{pr.number}</span>
                    {pr.isDraft ? (
                      <span className={styles.draftBadge}>{t('prs.draftBadge')}</span>
                    ) : null}
                  </div>
                  <h3 className={styles.title} title={pr.title}>
                    {pr.title}
                  </h3>
                  <p className={styles.meta}>
                    {pr.author} ·{' '}
                    {t('prs.updatedLabel', { date: new Date(pr.updatedAt).toLocaleDateString() })}
                  </p>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={styles.actionLink}
                      onClick={() => void openInBrowser(pr.url).catch(() => undefined)}
                      title={t('prs.openInBrowser')}
                      aria-label={t('prs.openInBrowser')}
                    >
                      <ExternalLink size={13} />
                    </button>
                    <button
                      type="button"
                      className={`${styles.actionButton} ${linked ? styles.actionButtonDone : ''}`}
                      disabled={linked}
                      onClick={() => createTodoFromPullRequest(pr)}
                    >
                      {linked ? t('prs.alreadyAdded') : t('prs.sendToTodo')}
                    </button>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </div>
    </aside>
  )
}
