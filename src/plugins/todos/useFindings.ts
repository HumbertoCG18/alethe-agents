import { useEffect, useState } from 'react'

import { type Finding, parseFindings, workflowPath } from '../../lib/campaigns'
import { listenFileChanged, readTextFile } from '../../lib/tauri'
import { createWatchSet } from './watchSet'

/**
 * The new findings in `<main>/.workflow/achados.json`. The file is watched; while it is absent
 * so is its folder, whose events name the file once it is written. Coming back to the window
 * re-reads it too, which also retries a watch that failed. Read once by the Todo tab, for the
 * Findings card and the task details.
 */
export function useFindings(main: string | null): Finding[] {
  const [state, setState] = useState<{ main: string; findings: Finding[] } | null>(null)

  useEffect(() => {
    if (!main) return
    const file = workflowPath(main, 'achados.json')
    const folder = workflowPath(main)
    let cancelled = false
    let latest = 0
    const watches = createWatchSet()
    const reload = async () => {
      const request = ++latest
      watches.watch(file)
      const source = await readTextFile(file).catch(() => null)
      if (cancelled || request !== latest) return
      if (source === null) watches.watch(folder)
      else watches.unwatch(folder)
      setState({ main, findings: source === null ? [] : parseFindings(source) })
    }
    void reload()
    const unlisten = listenFileChanged((path) => {
      if (path === file || path === folder) void reload()
    })
    const retry = () => {
      if (document.visibilityState !== 'hidden') void reload()
    }
    window.addEventListener('focus', retry)
    document.addEventListener('visibilitychange', retry)
    return () => {
      cancelled = true
      window.removeEventListener('focus', retry)
      document.removeEventListener('visibilitychange', retry)
      watches.clear()
      void unlisten.then((stop) => stop()).catch(() => {})
    }
  }, [main])

  return state && state.main === main ? state.findings : []
}
