import { useCallback, useEffect, useRef, useState } from 'react'

import {
  listenFileChanged,
  readRepositoryTextFile,
  readTextFile,
  unwatchFile,
  watchFile,
} from '../lib/tauri'

/**
 * Selection, reload and unmount all invalidate earlier file reads. A `scope`, the checkout of a
 * document named by repository text, reads it only while it is really inside the repository; a
 * result belongs to its path and scope together, so one read under another scope is never shown.
 */
export function useMarkdownFile(path: string | null, scope?: string | null) {
  const generation = useRef(0)
  // Any string, blank included, is a scope: only null or undefined read as a picked file.
  const key = path === null ? null : typeof scope === 'string' ? `${scope}\0${path}` : path
  const activeKey = useRef(key)
  const mounted = useRef(true)
  activeKey.current = key
  const [result, setResult] = useState<{
    key: string | null
    content: string | null
    error: string | null
  }>({ key: null, content: null, error: null })
  const reload = useCallback(async () => {
    if (!mounted.current || activeKey.current !== key) return
    const request = ++generation.current
    setResult((previous) =>
      previous.key === key ? { ...previous, error: null } : { key, content: null, error: null },
    )
    if (!path) return
    try {
      const content = await (typeof scope === 'string'
        ? readRepositoryTextFile(scope, path)
        : readTextFile(path))
      if (generation.current === request) setResult({ key, content, error: null })
    } catch (error) {
      if (generation.current === request) setResult({ key, content: null, error: String(error) })
    }
  }, [key, path, scope])
  useEffect(() => {
    const version = generation
    const lifecycle = mounted
    lifecycle.current = true
    void reload()
    if (!path)
      return () => {
        lifecycle.current = false
        version.current++
      }
    let active = true
    const normalize = (value: string) => value.replace(/\\/g, '/').toLowerCase()
    const watched = watchFile(path)
      .then(() => true)
      .catch(() => false)
    const listener = listenFileChanged((changed) => {
      if (active && normalize(changed) === normalize(path)) void reload()
    }).catch(() => () => {})
    return () => {
      active = false
      lifecycle.current = false
      version.current++
      void watched
        .then((ok) => {
          if (ok) return unwatchFile(path)
        })
        .catch(() => {})
      void listener.then((off) => off()).catch(() => {})
    }
  }, [path, reload])
  return {
    content: result.key === key ? result.content : null,
    error: result.key === key ? result.error : null,
    reload,
  }
}
