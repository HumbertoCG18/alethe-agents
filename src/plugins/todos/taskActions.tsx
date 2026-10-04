/**
 * What the Todo tab does with a task waiting on you, from a night entry or a Gate 2 row: open its
 * evidence, and the actions menu.
 */
import { useState } from 'react'

import { isMarkdownFilePath } from '../../components/XTermView/terminalLinks'
import { type Campaign, campaignCwd, evidenceIsPath, inCheckouts } from '../../lib/campaigns'
import { type TFunction, useT } from '../../lib/i18n'
import {
  findRelativePath,
  type GitCheckouts,
  listDirectory,
  openInFileExplorer,
} from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './CampaignsSection.module.css'
import { type CampaignEdits, continueCampaign, openCampaign, type Registry } from './campaignView'
import { useMenuFocus } from './menuFocus'

/**
 * Whether evidence names a path inside the repository's checkouts before anything is looked up: as
 * given when rooted (a drive, even without a separator, a share, or a leading slash), else under
 * `base`. The diary is written by agents, so the disk is never asked about anything else. A leading
 * slash without a drive, which Windows would read on the current drive, lies in no Windows checkout.
 */
function evidenceInCheckouts(base: string, evidence: string, checkouts: GitCheckouts): boolean {
  const separator = base.includes('\\') ? '\\' : '/'
  const path = /^(?:[A-Za-z]:|[\\/])/.test(evidence)
    ? evidence
    : `${base.replace(/[\\/]+$/, '')}${separator}${evidence.replace(/[\\/]/g, separator)}`
  return inCheckouts(path, checkouts)
}

function openFile(projectId: string, filePath: string) {
  const store = useProjectsStore.getState()
  const pane = store.createFilePane(projectId, { filePath })
  store.openPane(projectId, pane.id)
  useUiStore.getState().requestPaneFocus(pane.id)
}

/** A folder's report: the first of these it holds, in any case, else its only Markdown file. */
const FOLDER_REPORTS = ['relatorio.md', 'readme.md', 'handoff.md']

export const taskCampaign = (campaigns: readonly Campaign[], taskId: string) =>
  campaigns.find((campaign) => campaign.tasks.some((task) => task.id === taskId))

/**
 * Opens a task's evidence, looked up at the click from its campaign's checkout as it is then (else
 * the main one) and the other worktrees: Markdown in the viewer and anything else in a pane, as the
 * terminal's link menu opens a file; a folder's report in the viewer, else the folder in the file
 * explorer. A path outside the checkouts, or found nowhere, opens nothing and says so.
 */
export async function openEvidence(
  registry: Registry,
  taskId: string,
  evidence: string,
  t: TFunction,
) {
  const { projectId, main, checkouts, campaigns } = registry
  const campaign = taskCampaign(campaigns, taskId)
  const base = (campaign && campaignCwd(campaign, checkouts)) ?? main
  const found = evidenceInCheckouts(base, evidence, checkouts)
    ? await findRelativePath(base, evidence).catch(() => null)
    : null
  const ui = useUiStore.getState()
  if (!found || !inCheckouts(found, checkouts)) {
    ui.pushToast({
      title: t('todo.night.openEvidenceItem'),
      body: t('todo.night.evidenceMissing', { path: evidence }),
    })
    return
  }
  // list_directory lists a folder and fails for a file.
  const entries = await listDirectory(found).catch(() => null)
  if (!entries) {
    if (isMarkdownFilePath(found)) ui.openLinkViewer(found)
    else openFile(projectId, found)
    return
  }
  const files = entries.filter((entry) => !entry.is_dir)
  const markdown = files.filter((entry) => isMarkdownFilePath(entry.name))
  const report =
    FOLDER_REPORTS.map((name) => files.find((entry) => entry.name.toLowerCase() === name)).find(
      Boolean,
    ) ?? (markdown.length === 1 ? markdown[0] : undefined)
  if (report) ui.openLinkViewer(report.path)
  else await openInFileExplorer(found).catch(() => {})
}

export type TaskActions = ReturnType<typeof useTaskActions>

/**
 * The actions of a task waiting on you, opened from its row: Conclude (Gate 2) through `conclude`,
 * Open evidence when `evidence` looks like a path, Continue in the terminal (the campaign's tab, else
 * a new Claude Code tab with its board), and Back to the queue when `requeue`. The row renders a
 * button with `toggle` and the `menu`, and handles `onKeyDown`; without a `campaign` there is no
 * menu. Once an action took the row away, the focus goes to `fallback()`.
 */
export function useTaskActions({
  taskId,
  campaign,
  registry,
  edits,
  conclude,
  evidence,
  requeue,
  fallback,
}: {
  taskId: string
  campaign: Campaign | undefined
  registry: Registry
  edits: CampaignEdits
  /** Null when the task has no Conclude. */
  conclude: (() => unknown) | null
  evidence: string | null
  requeue: boolean
  fallback?: () => HTMLElement | null | undefined
}) {
  const t = useT()
  const [menu, setMenu] = useState(false)
  const { projectId } = registry
  const { trigger, onKeyDown, choose } = useMenuFocus(menu, () => setMenu(false), fallback)
  const item = (key: string, label: string, onClick: () => void, disabled = false) => (
    <button
      key={key}
      type="button"
      role="menuitem"
      className={styles.menuItem}
      onClick={onClick}
      disabled={disabled}
    >
      {label}
    </button>
  )

  return {
    onKeyDown,
    toggle: {
      ref: trigger,
      onClick: () => setMenu((current) => !current),
      'aria-expanded': menu,
      'aria-haspopup': 'menu' as const,
    },
    menu:
      campaign && menu ? (
        <div
          className={styles.menu}
          role="menu"
          aria-label={t('todo.night.actions', { id: taskId })}
        >
          {conclude
            ? item('conclude', t('todo.night.conclude'), choose(conclude), edits.busy)
            : null}
          {evidence && evidenceIsPath(evidence)
            ? item(
                'evidence',
                t('todo.night.openEvidenceItem'),
                choose(() => openEvidence(registry, taskId, evidence, t)),
              )
            : null}
          {item(
            'continue',
            t('todo.night.continue'),
            choose(
              () =>
                continueCampaign(projectId, campaign) ||
                openCampaign(projectId, campaign, 'claude', registry),
            ),
          )}
          {requeue
            ? item(
                'requeue',
                t('todo.night.requeue'),
                choose(() => edits.requeue(taskId)),
                edits.busy,
              )
            : null}
        </div>
      ) : null,
  }
}
