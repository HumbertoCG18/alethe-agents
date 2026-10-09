import { ExternalLink, GitPullRequest, LoaderCircle, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

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
  const projects = useProjectsStore((state) => state.projects)
  const activeId = useProjectsStore((state) => state.activeProjectId)
  const [selection, setSelection] = useState<{ activeId: string | null; id: string } | null>(null)
  const available = projects.filter((project) => !project.archived)
  const selectedId = selection?.activeId === activeId ? selection.id : activeId
  const project = available.find((item) => item.id === selectedId)
  const repo = project?.checkoutPath || project?.defaultCwd || getProjectRepoRoot(project)
  const [result, setResult] = useState<{
    repo: string
    prs: MyPullRequestSummary[]
    loading: boolean
    error: string | null
  }>({ repo: '', prs: [], loading: false, error: null })
  const refresh = useRef<() => void>(() => {})
  // Scope every response to the effect that requested it. A project switch invalidates it.
  useEffect(() => {
    let active = true
    let pending = false
    const load = async () => {
      if (!repo || pending) return
      pending = true
      setResult((current) => ({
        repo,
        prs: current.repo === repo ? current.prs : [],
        loading: true,
        error: null,
      }))
      try {
        const prs = await githubPrListMine(repo)
        if (active) setResult({ repo, prs, loading: false, error: null })
      } catch (error) {
        if (active) setResult({ repo, prs: [], loading: false, error: String(error) })
      } finally {
        pending = false
      }
    }
    const refreshVisible = () => {
      if (!document.hidden) void load()
    }
    refresh.current = () => {
      void load()
    }
    void load()
    const timer = window.setInterval(refreshVisible, 30_000)
    window.addEventListener('focus', refreshVisible)
    document.addEventListener('visibilitychange', refreshVisible)
    return () => {
      active = false
      refresh.current = () => {}
      window.clearInterval(timer)
      window.removeEventListener('focus', refreshVisible)
      document.removeEventListener('visibilitychange', refreshVisible)
    }
  }, [repo])
  const current = result.repo === repo
  const prs = current ? result.prs : []
  const loading = Boolean(repo) && (!current || result.loading)
  const error = current ? result.error : null

  const isLinked = (pr: MyPullRequestSummary) =>
    todos.some((todo) => todo.prRepo === pr.repo && todo.prNumber === pr.number)

  return (
    <aside className={styles.sidebar} aria-label={t('prs.title')}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <GitPullRequest size={16} />
          <span>{t('prs.title')}</span>
          <span className={styles.scope} title={repo || undefined}>
            {project?.name}
          </span>
        </div>
        <button
          type="button"
          className={styles.refreshButton}
          onClick={() => refresh.current()}
          disabled={loading || !repo}
          title={t('prs.refresh')}
          aria-label={t('prs.refresh')}
        >
          <RefreshCw size={13} className={loading ? styles.spinning : undefined} />
        </button>
      </header>

      <label className={styles.projectPicker}>
        {t('prs.project')}
        <select
          aria-label={t('prs.project')}
          value={project?.id ?? ''}
          onChange={(event) => setSelection({ activeId, id: event.target.value })}
        >
          <option value="" disabled>
            {t('prs.selectProject')}
          </option>
          {available.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <div className={styles.content}>
        {!repo ? (
          <div className={styles.empty}>{t('prs.noRepository')}</div>
        ) : loading ? (
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
            <strong>{t('prs.emptyTitle')}</strong>
            <span>{t('prs.emptyDescriptionProject')}</span>
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
