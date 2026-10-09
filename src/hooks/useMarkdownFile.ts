import { useCallback, useEffect, useRef, useState } from 'react'

import { listenFileChanged, readTextFile, unwatchFile, watchFile } from '../lib/tauri'

/** Selection, reload and unmount all invalidate earlier file reads. */
export function useMarkdownFile(path: string | null) {
  const generation = useRef(0)
  const activePath = useRef(path)
  const mounted = useRef(true)
  activePath.current = path
  const [result, setResult] = useState<{
    path: string | null
    content: string | null
    error: string | null
  }>({ path: null, content: null, error: null })
  const reload = useCallback(async () => {
    if (!mounted.current || activePath.current !== path) return
    const request = ++generation.current
    setResult((previous) =>
      previous.path === path ? { ...previous, error: null } : { path, content: null, error: null },
    )
    if (!path) return
    try {
      const content = await readTextFile(path)
      if (generation.current === request) setResult({ path, content, error: null })
    } catch (error) {
      if (generation.current === request) setResult({ path, content: null, error: String(error) })
    }
  }, [path])
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
    content: result.path === path ? result.content : null,
    error: result.path === path ? result.error : null,
    reload,
  }
}
