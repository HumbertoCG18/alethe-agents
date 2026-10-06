import { lazy, Suspense, useEffect, useState } from 'react'

import { useT } from '../../lib/i18n'
import {
  DEFAULT_MARKDOWN_SUMMARY,
  openMarkdownReader,
  summarizeMarkdown,
} from '../../lib/markdownSummary'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './MarkdownSummary.module.css'

const MarkdownRenderer = lazy(() =>
  import('./MarkdownRenderer').then((m) => ({ default: m.MarkdownRenderer })),
)

export function MarkdownSummary({
  path,
  content,
  dark,
}: {
  path: string
  content: string
  dark: boolean
}) {
  const t = useT()
  const settings =
    useProjectsStore((s) => s.preferences.markdownSummary) ?? DEFAULT_MARKDOWN_SUMMARY
  const language = useProjectsStore((s) => s.preferences.language)
  const key = JSON.stringify([path, content, settings, language])
  const [result, setResult] = useState({ key: '', text: '', error: '' })
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!settings.enabled) return
    let active = true
    setResult({ key, text: '', error: '' })
    const summary = summarizeMarkdown(path, content, settings, language)
    void summary.promise.then(
      (text) => {
        if (active) setResult({ key, text, error: '' })
      },
      (error) => {
        if (active) setResult({ key, text: '', error: String(error) })
      },
    )
    return () => {
      active = false
      summary.release()
    }
  }, [key, path, content, settings, language, retry])
  const current = result.key === key ? result : { text: '', error: '' }
  return (
    <div className={styles.root}>
      <div className={styles.actions}>
        <button
          onClick={() =>
            void openMarkdownReader(path).catch((error) =>
              useUiStore.getState().pushToast({ title: t('markdown.reader'), body: String(error) }),
            )
          }
        >
          {t('markdown.openFull')}
        </button>
        <button
          onClick={() => useUiStore.getState().openModal_('preferences', { category: 'markdown' })}
        >
          {t('markdown.settings')}
        </button>
      </div>
      {settings.enabled ? (
        <>
          <small>{t('markdown.generated')}</small>
          {current.error ? (
            <div role="alert">
              {t('markdown.failed')}
              <p>{current.error}</p>
              <button onClick={() => setRetry((n) => n + 1)}>{t('markdown.retry')}</button>
            </div>
          ) : current.text ? (
            <Suspense fallback={t('ui.markdown.loading')}>
              <MarkdownRenderer content={current.text} dark={dark} />
            </Suspense>
          ) : (
            <p role="status">{t('markdown.generating')}</p>
          )}
        </>
      ) : (
        <p>{t('markdown.disabled')}</p>
      )}
    </div>
  )
}
