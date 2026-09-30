import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { INSTALL_SHELL_ENV, installShellLine, type InstallMethod } from '../lib/agentInstall'
import {
  agentCliVersion,
  killPty,
  listenPtyData,
  listenPtyExit,
  refreshCliLauncher,
  spawnPty,
  writePty,
} from '../lib/tauri'
import { resolveAgentCliCommand } from '../lib/agentProviders'
import type { AgentType } from '../lib/types'

export type AgentInstallStatus = 'idle' | 'running' | 'success' | 'failed'

/**
 * Set only when a run finished with the installer reporting success and the resolver still
 * finding a binary, but the version at that binary never moved — the installer likely updated a
 * different install of the same CLI than the one PATH resolves to. Holds that binary's path so
 * the caller can name it.
 */
export type AgentInstallShadowConflict = { path: string }

const MAX_LOG_CHARS = 12_000
const PROMPT_SETTLE_MS = 400
/**
 * A native script that only edits PATH may never hand its shell back, so waiting for the PTY to
 * exit is not enough to notice it finished: the resolver is asked on this interval while it runs.
 * Package managers are left to exit on their own — their files land before they are done, and
 * killing one then (an MSI mid-install) can roll the whole install back.
 */
const VERIFY_POLL_MS = 1_500

function trimLog(value: string): string {
  return value.length > MAX_LOG_CHARS ? value.slice(value.length - MAX_LOG_CHARS) : value
}

export { trimLog as trimInstallLog }

/*
 * Package managers serialize badly: two `npm -g` runs fight over the same global directory, and
 * WinGet refuses to run twice at once. Only one agent operation is allowed at a time, app-wide.
 */
let busyAgent: string | null = null
const busyListeners = new Set<() => void>()

function setBusyAgent(agent: string | null): void {
  busyAgent = agent
  for (const listener of busyListeners) listener()
}

/** Takes the app-wide package-manager lock, or returns false when another run already holds it. */
export function acquireAgentOperation(key: string): boolean {
  if (busyAgent !== null) return false
  setBusyAgent(key)
  return true
}

export function releaseAgentOperation(key: string): void {
  if (busyAgent === key) setBusyAgent(null)
}

/** The agent whose install/uninstall is running right now, or null when nothing is. */
export function useAgentOperationBusy(): string | null {
  return useSyncExternalStore(
    (onChange) => {
      busyListeners.add(onChange)
      return () => busyListeners.delete(onChange)
    },
    () => busyAgent,
  )
}

/**
 * `lockKey` identifies the run that holds the app-wide lock. It defaults to the agent, and only
 * differs when the same screen also installs something else for that agent — the Node toolchain —
 * which must not look like the agent's own run or the two would be allowed to run together.
 */
export function useAgentInstall(agent: AgentType, lockKey: string = agent) {
  const [status, setStatus] = useState<AgentInstallStatus>('idle')
  const [log, setLog] = useState('')
  const [shadowConflict, setShadowConflict] = useState<AgentInstallShadowConflict | null>(null)
  const ptyIdRef = useRef<string | null>(null)
  const cleanupRef = useRef<Array<() => void>>([])
  const disposedRef = useRef(false)
  const settledRef = useRef(false)
  // Bumped by every run and by reset(), so an in-flight run can tell it was cancelled.
  const runRef = useRef(0)

  const teardown = useCallback(() => {
    cleanupRef.current.forEach((stop) => stop())
    cleanupRef.current = []
    const ptyId = ptyIdRef.current
    ptyIdRef.current = null
    if (ptyId) void killPty(ptyId).catch(() => undefined)
    // Never leave the app-wide lock held by a run that is gone.
    if (busyAgent === lockKey) setBusyAgent(null)
  }, [lockKey])

  /** First outcome wins: the shell exiting and the resolver noticing race each other. */
  const settle = useCallback(
    (outcome: 'success' | 'failed') => {
      if (settledRef.current) return
      settledRef.current = true
      teardown()
      setStatus(outcome)
    },
    [teardown],
  )

  useEffect(() => {
    disposedRef.current = false
    return () => {
      disposedRef.current = true
      teardown()
    }
  }, [teardown])

  const install = useCallback(
    async (method: InstallMethod) => {
      if (status === 'running' || busyAgent !== null) return
      const run = ++runRef.current
      const stale = () => disposedRef.current || runRef.current !== run
      teardown()
      setLog('')
      setShadowConflict(null)
      settledRef.current = false
      setStatus('running')
      setBusyAgent(lockKey)

      const command = method.verifyCommand ?? resolveAgentCliCommand(agent)
      // Only meaningful for an update of something already on PATH — a fresh install has
      // nothing to compare against, and verifyAbsent (uninstall) checks absence, not a version.
      const beforeVersion = command && !method.verifyAbsent ? await agentCliVersion(command) : null
      if (stale()) return

      /**
       * Whether the machine now shows what this run was supposed to produce. The environment is
       * re-read every time: an installer that adds itself to PATH only reaches processes started
       * after it, so the app would otherwise keep answering from the PATH it booted with.
       */
      const verify = async (): Promise<boolean> => {
        if (!command) return false
        const found = await refreshCliLauncher(command).catch(() => null)
        if (method.verifyAbsent) return !found
        if (!found) return false
        if (!beforeVersion) return true
        // An update only counts once the version at that path actually moves.
        const afterVersion = await agentCliVersion(command).catch(() => null)
        return Boolean(afterVersion && afterVersion !== beforeVersion)
      }

      // Polling can only tell this run's effect apart from the state the machine was already in
      // when the two differ. When the check passes before the installer even starts — a
      // re-install, or a CLI whose version cannot be read — only the shell exiting settles it.
      const alreadySatisfied = await verify()
      if (stale()) return

      const ptyId = `agent-install:${lockKey}:${Date.now()}`
      try {
        // A bare shell, then the command written into it: the native installers
        // are pipelines (`irm ... | iex`), which cannot be expressed as a
        // launcher plus argv.
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
          setLog((current) => trimLog(current + chunk))
        })
        if (!keep(stopData)) return
        const stopExit = await listenPtyExit(spawned.id, (payload) => {
          if (stale()) return
          ptyIdRef.current = null
          if (settledRef.current) return
          // `installShellLine` ends the shell with a bare `exit`, which carries the
          // installer command's own exit status. A non-zero code means the installer
          // itself reported failure (network error, permission denied, ...) — trust it
          // instead of falling through to the resolver, which would still find the
          // previous binary on PATH and misreport the run as a success.
          if (payload.code !== 0 || !command) {
            settle('failed')
            return
          }
          // A zero exit code still doesn't confirm the binary landed somewhere we
          // can launch it from, so ask the resolver.
          void verify()
            .then(async (worked) => {
              if (stale() || settledRef.current) return
              if (worked) {
                settle('success')
                return
              }
              // The installer exited clean and a binary is still there, but its version never
              // moved: the run likely reached a different install of this CLI than the one PATH
              // resolves to — a shadowing copy the update never touched. Name it for the caller.
              const found = beforeVersion
                ? await refreshCliLauncher(command).catch(() => null)
                : null
              if (stale()) return
              if (found) setShadowConflict({ path: found })
              settle('failed')
            })
            .catch(() => {
              if (!stale()) settle('failed')
            })
        })
        if (!keep(stopExit)) return

        // The shell exiting is only one of the two ways a native run can end — see VERIFY_POLL_MS.
        if (method.id === 'native' && !alreadySatisfied) {
          const poll = window.setInterval(() => {
            void verify().then((worked) => {
              if (worked && !stale()) settle('success')
            })
          }, VERIFY_POLL_MS)
          cleanupRef.current.push(() => window.clearInterval(poll))
        }

        await new Promise((resolve) => setTimeout(resolve, PROMPT_SETTLE_MS))
        if (stale()) return
        await writePty(spawned.id, installShellLine(method.command))
      } catch (error) {
        if (stale()) return
        setLog((current) => trimLog(`${current}\n${String(error)}`))
        setStatus('failed')
        teardown()
      }
    },
    [agent, lockKey, settle, status, teardown],
  )

  const reset = useCallback(() => {
    runRef.current += 1
    teardown()
    settledRef.current = false
    setLog('')
    setShadowConflict(null)
    setStatus('idle')
  }, [teardown])

  return { status, log, shadowConflict, install, reset }
}
