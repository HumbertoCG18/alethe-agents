import { convertFileSrc } from '@tauri-apps/api/core'
import { type ReactNode, useEffect, useMemo, useState } from 'react'

import { useT } from '../../lib/i18n'
import { OUTSIDE_REPOSITORY } from '../../lib/tauri'
import styles from './ScopedMedia.module.css'

/**
 * Renders `children` with the source of an image or video file, by its pane's `scope` (see
 * `Terminal.fileScope`): a file the user picked (null) loads through the asset protocol as before;
 * one named by repository text (its checkout) through `load`, refused with a notice once a link
 * leads it out of the checkouts; a pane saved before scopes (undefined) loads nothing until
 * `onReopen`.
 */
export function ScopedMedia({
  path,
  scope,
  load,
  onReopen,
  children,
}: {
  path: string
  scope: string | null | undefined
  /** Defined at module level: it is an effect dependency. */
  load: (scope: string, path: string) => Promise<string>
  onReopen?: () => void
  children: (src: string) => ReactNode
}) {
  const t = useT()
  // A new request on every change of file, a return to an earlier one included: a result shows only
  // for the request that produced it, so nothing loaded before the change shows unchecked.
  const request = useMemo(() => ({ scope, path }), [scope, path])
  const [loaded, setLoaded] = useState<{ request: object; src: string | null; error: unknown }>()
  useEffect(() => {
    // Any string, blank included, is a checkout for `load` to check.
    if (typeof request.scope !== 'string') return
    let live = true
    void load(request.scope, request.path).then(
      (src) => live && setLoaded({ request, src, error: null }),
      (error: unknown) => live && setLoaded({ request, src: null, error }),
    )
    return () => {
      live = false
    }
  }, [load, request])

  if (scope === undefined)
    return (
      <div className={styles.notice}>
        <span>{t('markdown.legacyPane')}</span>
        {onReopen ? (
          <button type="button" className={styles.reopen} onClick={onReopen}>
            {t('markdown.legacyPaneOpen')}
          </button>
        ) : null}
      </div>
    )
  if (scope === null) return children(convertFileSrc(path))
  const current = loaded?.request === request ? loaded : undefined
  if (current?.src) return children(current.src)
  if (!current) return null
  return (
    <div className={styles.notice}>
      <span>
        {current.error === OUTSIDE_REPOSITORY
          ? t('media.outsideRepository')
          : t('ui.markdown.loadError', { path })}
      </span>
    </div>
  )
}
