import { listen } from '@tauri-apps/api/event'
import { useEffect } from 'react'

import { useAgentCanvasStore } from '../stores/agentCanvasStore'
import { agentCanvasMirror, setAgentCanvasMirror } from './tauri'

const MIRROR_EVENT = 'agent-canvas://mirror'
const PUBLISH_DEBOUNCE_MS = 300

let publishing = false
let publishedSeq = 0

function snapshot(): string {
  const { nodes, tasks, teamName, incarnations, pendingPrompts } = useAgentCanvasStore.getState()
  // Clock-based so a reloaded main window still publishes newer snapshots than before.
  publishedSeq = Math.max(publishedSeq + 1, Date.now())
  return JSON.stringify({ seq: publishedSeq, nodes, tasks, teamName, incarnations, pendingPrompts })
}

/**
 * Starts publishing the main window's subagent canvas so a detached orchestration board shows the
 * same subagents, including the ones that started before it opened (#247). Idempotent; it only
 * starts once a board has been detached, so nothing is published while none has.
 */
export function startAgentCanvasMirror(): void {
  if (publishing) return
  publishing = true
  const publish = () => void setAgentCanvasMirror(snapshot()).catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | null = null
  publish()
  useAgentCanvasStore.subscribe(() => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      publish()
    }, PUBLISH_DEBOUNCE_MS)
  })
}

/**
 * Resumes publishing after the main window reloads. The backend keeps the last snapshot for the
 * whole run, so one being there means a board was detached and may still be open; without this,
 * that board's canvas would stop updating until another board is detached.
 */
export function resumeAgentCanvasMirror(): void {
  void agentCanvasMirror()
    .then((raw) => {
      if (raw) startAgentCanvasMirror()
    })
    .catch(() => undefined)
}

/**
 * Keeps a detached board's canvas equal to what the main window publishes. The first read and the
 * live updates can arrive in either order, so only a newer snapshot replaces the one on screen.
 */
export function useAgentCanvasMirror(): void {
  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined
    let appliedSeq = 0
    const apply = (raw: string | null) => {
      if (cancelled || !raw) return
      try {
        const { seq, ...state } = JSON.parse(raw) as { seq: number } & Record<string, unknown>
        if (seq <= appliedSeq) return
        appliedSeq = seq
        useAgentCanvasStore.setState(state)
      } catch {
        // A malformed snapshot leaves the last good one on screen.
      }
    }
    void listen<string>(MIRROR_EVENT, (event) => apply(event.payload)).then((off) => {
      if (cancelled) off()
      else unlisten = off
    })
    void agentCanvasMirror()
      .then(apply)
      .catch(() => undefined)
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])
}
