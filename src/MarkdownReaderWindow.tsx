import { listen } from '@tauri-apps/api/event'
import { FileText, RefreshCw, Send } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'

import { Dropdown } from './components/ui/Dropdown'
import { writePtyChunked, writePtyWithTimeout } from './components/XTermView/terminalWrite'
import { useMarkdownFile } from './hooks/useMarkdownFile'
import { useT } from './lib/i18n'
import { DEFAULT_MARKDOWN_SUMMARY, markdownQuestion } from './lib/markdownSummary'
import { basename } from './lib/paths'
import { OUTSIDE_REPOSITORY, ptyExists } from './lib/tauri'
import { generateMarkdown } from './lib/tauri/markdown'
import {
  listenOrchestratorJobs,
  type OrchestratorJob,
  orchestratorJobs,
  orchestratorMessage,
} from './lib/tauri/orchestrator'
import { isLightTheme, useAppliedTheme } from './lib/themes'
import styles from './MarkdownReaderWindow.module.css'
import { useProjectsStore } from './stores/projectsStore'

const MarkdownRenderer = lazy(() =>
  import('./components/MarkdownPane/MarkdownRenderer').then((m) => ({
    default: m.MarkdownRenderer,
  })),
)

/** `scope`: the checkout of a document named by repository text, read under its rule. */
export function MarkdownReaderWindow({ path, scope }: { path: string; scope?: string }) {
  const t = useT()
  const hydrate = useProjectsStore((s) => s.hydrate)
  const preferences = useProjectsStore((s) => s.preferences)
  const projects = useProjectsStore((s) => s.projects)
  const theme = useAppliedTheme(preferences.uiTheme)
  const settings = preferences.markdownSummary ?? DEFAULT_MARKDOWN_SUMMARY
  const { content, error, reload } = useMarkdownFile(path, scope)
  const [quote, setQuote] = useState('')
  const [question, setQuestion] = useState('')
  const [target, setTarget] = useState('')
  const [jobs, setJobs] = useState<OrchestratorJob[]>([])
  const [busy, setBusy] = useState(false)
  const [answer, setAnswer] = useState('')
  const [submitted, setSubmitted] = useState({ quote: '', question: '', target: '' })
  const generation = useRef<AbortController | null>(null)
  const [sendError, setSendError] = useState('')
  const documentRef = useRef<HTMLDivElement>(null)
  const request = useRef(0)
  useEffect(() => {
    const version = request
    void hydrate()
    let active = true
    const saved = listen('projects://saved', () => void hydrate()).catch(() => () => {})
    const update = (snapshot: { jobs: OrchestratorJob[] }) => {
      if (active) setJobs(snapshot.jobs)
    }
    const changed = listenOrchestratorJobs(update).catch(() => () => {})
    void orchestratorJobs()
      .then(update)
      .catch(() => {})
    return () => {
      active = false
      version.current++
      generation.current?.abort()
      void saved.then((off) => off()).catch(() => {})
      void changed.then((off) => off()).catch(() => {})
    }
  }, [hydrate])
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.dataset.visualStyle = preferences.visualStyle ?? 'normal'
  }, [theme, preferences.visualStyle])
  useEffect(() => {
    generation.current?.abort()
    setQuote('')
    setAnswer('')
    setSendError('')
    setBusy(false)
    request.current++
  }, [content, path])
  useEffect(() => {
    const selected = () => {
      const selection = window.getSelection()
      if (!selection?.rangeCount || selection.isCollapsed) return
      const range = selection.getRangeAt(0)
      if (documentRef.current?.contains(range.commonAncestorContainer)) {
        setQuote(selection.toString())
      }
    }
    document.addEventListener('selectionchange', selected)
    return () => document.removeEventListener('selectionchange', selected)
  }, [])
  const workers = jobs.filter(
    (job) => job.threadId && ['running', 'done', 'interrupted'].includes(job.status),
  )
  const sessions = projects.flatMap((project) =>
    project.terminals
      .filter((terminal) => !terminal.disabled)
      .flatMap((terminal) =>
        terminal.tabs
          .filter((tab) => tab.ptyId && (tab.type === 'claude' || tab.type === 'codex'))
          .map((tab) => ({ tab, label: `${project.name} / ${terminal.name} / ${tab.type}` })),
      ),
  )
  const chosen = target || settings.agent
  const send = async () => {
    if (!quote.trim() || !question.trim() || quote.length > 24_000 || busy) return
    const id = ++request.current
    const controller = new AbortController()
    generation.current = controller
    setSubmitted({
      quote,
      question,
      target: sessions.find((item) => `session:${item.tab.id}` === chosen)?.label ?? chosen,
    })
    setBusy(true)
    setAnswer('')
    setSendError('')
    try {
      if (chosen.startsWith('worker:')) {
        const worker = workers.find((job) => `worker:${job.id}` === chosen)
        if (!worker) throw new Error(t('markdown.target'))
        await orchestratorMessage(worker.id, markdownQuestion(path, quote, question), false)
        if (request.current === id) setAnswer(t('markdown.sent'))
      } else if (chosen.startsWith('session:')) {
        const sessionId = chosen.slice('session:'.length)
        const tab = useProjectsStore
          .getState()
          .projects.flatMap((project) =>
            project.terminals
              .filter((terminal) => !terminal.disabled)
              .flatMap((terminal) => terminal.tabs),
          )
          .find(
            (item) => item.id === sessionId && (item.type === 'claude' || item.type === 'codex'),
          )
        if (!tab?.ptyId || !(await ptyExists(tab.ptyId))) throw new Error(t('markdown.sessionGone'))
        if (controller.signal.aborted) return
        await writePtyChunked(tab.ptyId, markdownQuestion(path, quote, question), true)
        await writePtyWithTimeout(tab.ptyId, '\r')
        if (request.current === id) setAnswer(t('markdown.sentSession'))
      } else {
        const reply = await generateMarkdown(
          {
            path,
            content: quote,
            question: JSON.stringify({ file: path, question }),
            agent: chosen,
            model: chosen === settings.agent ? settings.model : '',
            style: settings.style,
            language: preferences.language,
          },
          controller.signal,
        )
        if (request.current === id) setAnswer(reply)
      }
    } catch (failure) {
      if (request.current === id) setSendError(String(failure))
    } finally {
      if (request.current === id) setBusy(false)
    }
  }
  return (
    <main className={styles.root}>
      <header className={styles.header}>
        <FileText size={18} />
        <div className={styles.identity}>
          <strong>{basename(path)}</strong>
          <span title={path}>{path}</span>
        </div>
        <button
          type="button"
          className={styles.toolbarButton}
          onClick={() => void reload()}
          aria-label={t('ui.markdown.refresh')}
        >
          <RefreshCw size={14} />
          <span>{t('ui.markdown.refresh')}</span>
        </button>
      </header>
      <div className={styles.workspace}>
        <div ref={documentRef} className={styles.document}>
          {error ? (
            <p role="alert">
              {t('markdown.readError')}{' '}
              {error === OUTSIDE_REPOSITORY ? t('markdown.outsideRepository') : error}
            </p>
          ) : content === null ? (
            <p>{t('ui.markdown.loading')}</p>
          ) : (
            <Suspense fallback={t('ui.markdown.loading')}>
              <MarkdownRenderer content={content} dark={!isLightTheme(theme)} />
            </Suspense>
          )}
        </div>
        <section className={styles.questions} aria-label={t('markdown.ask')}>
          <div className={styles.questionHeading}>
            <strong>{t('markdown.ask')}</strong>
            <p>{t('markdown.selectText')}</p>
          </div>
          <label>
            {t('markdown.quote')}
            <textarea readOnly value={quote} placeholder={t('markdown.selectText')} rows={2} />
          </label>
          {quote.length > 24_000 ? <p role="alert">{t('markdown.selectionTooLarge')}</p> : null}
          <label>
            {t('markdown.question')}
            <textarea
              value={question}
              maxLength={6000}
              onChange={(e) => setQuestion(e.target.value)}
              rows={2}
            />
          </label>
          <div className={styles.actions}>
            <label>
              {t('markdown.target')}
              <Dropdown
                value={chosen}
                onChange={setTarget}
                ariaLabel={t('markdown.target')}
                searchable
                searchPlaceholder={t('rightSidebar.catalog.search')}
                options={[
                  { value: 'antigravity', label: t('markdown.agyUnavailable'), disabled: true },
                  { value: 'claude', label: 'Claude Code' },
                  { value: 'codex', label: 'Codex' },
                  ...sessions.map(({ tab, label }) => ({
                    value: `session:${tab.id}`,
                    label: `${t('markdown.session')} / ${label}`,
                  })),
                  ...workers.map((job) => ({
                    value: `worker:${job.id}`,
                    label: `${t(job.task ? 'markdown.nightWorker' : 'markdown.worker')} · ${job.agent} · ${job.task || job.id} · ${job.cwd}`,
                  })),
                ]}
              />
            </label>
            <button
              type="button"
              className={styles.sendButton}
              disabled={
                busy ||
                chosen === 'antigravity' ||
                !quote.trim() ||
                !question.trim() ||
                quote.length > 24_000
              }
              onClick={() => void send()}
            >
              <Send size={14} />
              {t(busy ? 'markdown.asking' : 'markdown.ask')}
            </button>
          </div>
          {sendError ? <p role="alert">{sendError}</p> : null}
          {answer ? (
            <div className={styles.answer} aria-label={t('markdown.answer')}>
              <p>{submitted.target}</p>
              <blockquote>{submitted.quote}</blockquote>
              <p>{submitted.question}</p>
              <Suspense fallback={t('ui.markdown.loading')}>
                <MarkdownRenderer content={answer} dark={!isLightTheme(theme)} />
              </Suspense>
            </div>
          ) : null}
        </section>
      </div>
    </main>
  )
}
