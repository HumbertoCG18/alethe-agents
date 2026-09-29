import { useCallback, useEffect, useRef, useState } from 'react'

import { INSTALL_SHELL_ENV, installShellLine } from '../lib/agentInstall'
import {
  killPty,
  listenPtyData,
  listenPtyExit,
  router9InstallCommand,
  router9Status,
  router9Stop,
  router9UninstallCommand,
  spawnPty,
  writePty,
} from '../lib/tauri'
import {
  acquireAgentOperation,
  type AgentInstallStatus,
  releaseAgentOperation,
  trimInstallLog,
} from './useAgentInstall'

export type Router9InstallAction = 'install' | 'uninstall'

const LOCK_KEY = 'router9'
const PROMPT_SETTLE_MS = 400

export function useRouter9Install(onSettled?: () => void) {
  const [status, setStatus] = useState<AgentInstallStatus>('idle')
  const [action, setAction] = useState<Router9InstallAction | null>(null)
  const [log, setLog] = useState('')
  const ptyIdRef = useRef<string | null>(null)
  const cleanupRef = useRef<Array<() => void>>([])
  const disposedRef = useRef(false)
  // Bumped by every run and by reset(), so an in-flight run can tell it was cancelled.
  const runRef = useRef(0)
  const settledRef = useRef(onSettled)
  settledRef.current = onSettled

  const teardown = useCallback(() => {
    cleanupRef.current.forEach((stop) => stop())
    cleanupRef.current = []
    const ptyId = ptyIdRef.current
    ptyIdRef.current = null
    if (ptyId) void killPty(ptyId).catch(() => undefined)
    releaseAgentOperation(LOCK_KEY)
  }, [])

  useEffect(() => {
    disposedRef.current = false
    return () => {
      disposedRef.current = true
      teardown()
    }
  }, [teardown])

  const run = useCallback(
    async (next: Router9InstallAction) => {
      if (status === 'running') return
      const token = ++runRef.current
      const stale = () => disposedRef.current || runRef.current !== token
      teardown()
      if (!acquireAgentOperation(LOCK_KEY)) return
      setLog('')
      setAction(next)
      setStatus('running')

      // Removing the package under a live process would leave an orphan holding the port.
      if (next === 'uninstall') await router9Stop().catch(() => undefined)
      if (stale()) return

      const ptyId = `router9-${next}:${Date.now()}`
      try {
        const command =
          next === 'install' ? await router9InstallCommand() : await router9UninstallCommand()
        if (stale()) return
        const spawned = await spawnPty({ cols: 100, rows: 24, id: ptyId, env: INSTALL_SHELL_ENV })
        if (stale()) {
          void killPty(spawned.id).catch(() => undefined)
          return
        }
        ptyIdRef.current = spawned.id

        // Checked after each await: a cancel meanwhile already ran teardown(), which never sees a
        // listener that registers later.
        const keep = (stop: () => void): boolean => {
          if (stale()) {
            stop()
            return false
          }
          cleanupRef.current.push(stop)
          return true
        }

        const stopData = await listenPtyData(spawned.id, (chunk) => {
          if (stale()) return
          setLog((current) => trimInstallLog(current + chunk))
        })
        if (!keep(stopData)) return
        const stopExit = await listenPtyExit(spawned.id, (payload) => {
          if (stale()) return
          ptyIdRef.current = null
          releaseAgentOperation(LOCK_KEY)
          if (payload.code !== 0) {
            setStatus('failed')
            return
          }
          // npm exiting clean is not proof the package landed: ask the backend what is on disk.
          void router9Status()
            .then((result) => {
              if (stale()) return
              const worked =
                next === 'install' ? result.managed.installed : !result.managed.installed
              setStatus(worked ? 'success' : 'failed')
              settledRef.current?.()
            })
            .catch(() => {
              if (!stale()) setStatus('failed')
            })
        })
        if (!keep(stopExit)) return

        await new Promise((resolve) => setTimeout(resolve, PROMPT_SETTLE_MS))
        if (stale()) return
        await writePty(spawned.id, installShellLine(command))
      } catch (error) {
        if (stale()) return
        setLog((current) => trimInstallLog(`${current}\n${String(error)}`))
        setStatus('failed')
        teardown()
      }
    },
    [status, teardown],
  )

  const reset = useCallback(() => {
    runRef.current += 1
    teardown()
    setLog('')
    setAction(null)
    setStatus('idle')
  }, [teardown])

  return { status, action, log, run, reset }
}
