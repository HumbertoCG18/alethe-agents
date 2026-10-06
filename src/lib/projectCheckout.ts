/**
 * Which checkout of its repository a project uses: the one picked in the worktree picker, else the
 * main checkout. New terminals start there and the right sidebar's Markdown tab reads it.
 */

import { useEffect } from 'react'

import { useProjectsStore } from '../stores/projectsStore'
import { pathInside } from './campaigns'
import { sameCwd } from './paths'
import { type GitCheckouts, type OrchestratorJob, worktreeCheckouts } from './tauri'
import { getProjectDefaultCwd } from './terminalFactory'
import type { Project } from './types'

/**
 * The picked checkout while git still lists it; else the main checkout when the project folder is
 * one of the checkouts' roots (a subfolder or a folder outside git stays as it is).
 */
export function effectiveCheckout(
  project: Pick<Project, 'checkoutPath' | 'defaultCwd'>,
  checkouts: GitCheckouts | null,
): string {
  const listed = (path?: string) =>
    Boolean(path && checkouts?.worktrees.some((checkout) => sameCwd(checkout.path, path)))
  const { checkoutPath, defaultCwd } = project
  if (checkoutPath && (!checkouts || listed(checkoutPath))) return checkoutPath
  if (checkouts?.main && (checkoutPath || listed(defaultCwd))) return checkouts.main
  return defaultCwd ?? ''
}

/** Whether `folder` is where `project` starts new terminals, trailing separators and case aside. */
export function isProjectFolder(project: Project | null, folder: string): boolean {
  const bare = (path: string) =>
    path
      .trim()
      .replace(/[\\/]+$/, '')
      .toLowerCase()
  return Boolean(project) && bare(getProjectDefaultCwd(project)) === bare(folder)
}

/**
 * The project's checkouts and the checkout it uses. When git names a different one than new
 * terminals would take (a project sitting on a linked worktree, a picked worktree that is gone),
 * it is saved, so new terminals follow it too. `status` asks for the picker's counts and marks.
 */
export async function resolveProjectCheckout(
  projectId: string,
  status = false,
): Promise<{ checkouts: GitCheckouts | null; root: string }> {
  const find = () => useProjectsStore.getState().projects.find((item) => item.id === projectId)
  const asked = find()
  if (!asked) return { checkouts: null, root: '' }
  let checkouts: GitCheckouts | null = null
  for (const path of [asked.checkoutPath, asked.defaultCwd]) {
    if (path && !checkouts) checkouts = await worktreeCheckouts(path, status).catch(() => null)
  }
  // The user may have picked a checkout while git answered: that choice wins over this answer.
  const project = find()
  if (!project) return { checkouts, root: '' }
  const root = effectiveCheckout(project, checkouts)
  const current = project.checkoutPath || project.defaultCwd || ''
  const unchanged = project.checkoutPath === asked.checkoutPath
  if (checkouts && root && unchanged && !sameCwd(root, current)) {
    useProjectsStore.getState().setProjectCheckout(projectId, root)
  }
  return { checkouts, root }
}

/** One anchoring per profile, project folder and pick, shared while it runs and kept once git
 *  answered. */
const anchors = new Map<string, Promise<void>>()

/** Anchors the project at its checkout, sharing a run already under way. */
export function ensureProjectAnchored(projectId: string): Promise<void> {
  const { projects, activeProfileId } = useProjectsStore.getState()
  const project = projects.find((item) => item.id === projectId)
  if (!project) return Promise.resolve()
  const key = [activeProfileId, projectId, project.defaultCwd ?? '', project.checkoutPath ?? '']
  const id = key.join('\n')
  let anchor = anchors.get(id)
  if (!anchor) {
    // A failed attempt is forgotten, so the next call asks git again.
    anchor = resolveProjectCheckout(projectId).then(
      ({ checkouts }) => {
        if (!checkouts) anchors.delete(id)
      },
      () => {
        anchors.delete(id)
      },
    )
    anchors.set(id, anchor)
  }
  return anchor
}

/**
 * Where a new terminal of the project starts: `typed` when the user changed the folder `offered`,
 * else the project's checkout once its anchor has landed, or after `timeoutMs` with what is known.
 */
export async function anchoredCwd(
  projectId: string,
  { typed = '', offered = '', timeoutMs = 2000 } = {},
): Promise<string> {
  const chosen = typed.trim()
  if (chosen && chosen !== offered.trim()) return chosen
  let timer: ReturnType<typeof setTimeout> | undefined
  const waited = new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))
  await Promise.race([ensureProjectAnchored(projectId), waited])
  clearTimeout(timer)
  const { projects } = useProjectsStore.getState()
  return getProjectDefaultCwd(
    projects.find((item) => item.id === projectId),
    projects,
  )
}

/**
 * Anchors every project once the projects are loaded, and again when the profile or a project's
 * folder changes, plus the active one whenever it changes, so new terminals start in the main
 * checkout without any panel being opened.
 */
export function useProjectCheckoutAnchors(hydrated: boolean): void {
  const activeProjectId = useProjectsStore((state) => state.activeProjectId)
  const profileId = useProjectsStore((state) => state.activeProfileId)
  const folders = useProjectsStore((state) =>
    state.projects.map((project) => `${project.id}\t${project.defaultCwd ?? ''}`).join('\n'),
  )
  useEffect(() => {
    if (!hydrated) return
    for (const project of useProjectsStore.getState().projects) {
      void ensureProjectAnchored(project.id)
    }
  }, [hydrated, folders, profileId])
  useEffect(() => {
    if (hydrated && activeProjectId) void ensureProjectAnchored(activeProjectId)
  }, [hydrated, activeProjectId])
}

/** Orchestrator statuses whose worker still runs, or holds its slot, in its folder. */
const LIVE_JOBS: ReadonlySet<OrchestratorJob['status']> = new Set(['queued', 'running', 'blocked'])

/** Why `path` can't leave the disk yet: a terminal of any project or a live worker is in it. */
export function checkoutBusy(
  path: string,
  projects: Project[],
  jobs: OrchestratorJob[],
): 'terminal' | 'worker' | null {
  const inside = (cwd?: string | null) => Boolean(cwd && pathInside(cwd, path))
  const terminalInside = projects.some((project) =>
    project.terminals.some(
      (terminal) =>
        inside(terminal.cwd) ||
        inside(terminal.filePath) ||
        terminal.tabs.some((tab) => inside(tab.cwd)),
    ),
  )
  if (terminalInside) return 'terminal'
  return jobs.some((job) => LIVE_JOBS.has(job.status) && inside(job.cwd)) ? 'worker' : null
}
