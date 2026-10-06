import { Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { askConfirm } from '../../lib/dialog'
import { formatRelativeTimestamp } from '../../lib/greeting'
import { type MessageKey, useT } from '../../lib/i18n'
import { basename, sameCwd } from '../../lib/paths'
import { checkoutBusy, resolveProjectCheckout } from '../../lib/projectCheckout'
import {
  type GitCheckout,
  type GitCheckouts,
  orchestratorJobs,
  worktreeRemoveCheckout,
} from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import controls from './controls.module.css'
import { Modal } from './Modal'
import styles from './WorktreePickerModal.module.css'

/** Refusals `worktree_remove_checkout` reports, as the user reads them. */
const REFUSALS: Record<string, MessageKey> = {
  worktree_dirty: 'worktreePicker.refusedDirty',
  worktree_is_main: 'worktreePicker.refusedMain',
  worktree_in_use_terminal: 'worktreePicker.busyTerminal',
  worktree_in_use_worker: 'worktreePicker.busyWorker',
  worktree_being_removed: 'worktreePicker.beingRemoved',
}

/** The repository's worktrees for a project: pick the one it uses, remove a stale one. */
export function WorktreePickerModal() {
  const open = useUiStore((s) => s.openModal === 'worktreePicker')
  const projectId = useUiStore(
    (s) => (s.modalContext as { projectId?: string } | null)?.projectId ?? null,
  )
  if (!open || !projectId) return null
  return <WorktreePicker key={projectId} projectId={projectId} />
}

function WorktreePicker({ projectId }: { projectId: string }) {
  const t = useT()
  const closeModal = useUiStore((s) => s.closeModal)
  const projectName = useProjectsStore((s) => s.projects.find((p) => p.id === projectId)?.name)
  const setProjectCheckout = useProjectsStore((s) => s.setProjectCheckout)
  const retireCheckout = useProjectsStore((s) => s.retireCheckout)
  const [found, setFound] = useState<{ checkouts: GitCheckouts | null; root: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(
    () => resolveProjectCheckout(projectId, true).then(setFound),
    [projectId],
  )
  useEffect(() => {
    void load()
  }, [load])

  const choose = (path: string) => {
    setProjectCheckout(projectId, path)
    closeModal()
  }

  /** Why `path` can't go right now, or null. Workers that can't be listed refuse too. */
  const blocker = async (path: string, name: string): Promise<string | null> => {
    const jobs = await orchestratorJobs().then(
      (snapshot) => snapshot.jobs,
      () => null,
    )
    if (!jobs) return t('worktreePicker.workersUnknown', { name })
    const busy = checkoutBusy(path, useProjectsStore.getState().projects, jobs)
    if (busy === 'terminal') return t('worktreePicker.busyTerminal', { name })
    return busy === 'worker' ? t('worktreePicker.busyWorker', { name }) : null
  }

  const remove = async (checkout: GitCheckout) => {
    setNotice(null)
    const name = basename(checkout.path)
    const refusal =
      (checkout.uncommitted ? t('worktreePicker.refusedDirty', { name }) : null) ??
      (await blocker(checkout.path, name))
    if (refusal) {
      setNotice(refusal)
      return
    }
    const message = t('worktreePicker.confirmRemove', { name, branch: checkout.branch ?? '—' })
    if (!(await askConfirm(message))) return
    // A terminal or a worker may have started there while the confirmation was open.
    const meanwhile = await blocker(checkout.path, name)
    if (meanwhile) {
      setNotice(meanwhile)
      return
    }
    try {
      await worktreeRemoveCheckout(checkout.path)
      if (found?.checkouts?.main) retireCheckout(checkout.path, found.checkouts.main)
      await load()
    } catch (error) {
      const refusal = REFUSALS[String(error)]
      setNotice(
        refusal
          ? t(refusal, { name })
          : `${t('merge.worktreeRemoveFailedTitle')}: ${String(error).slice(0, 300)}`,
      )
    }
  }

  const main = found?.checkouts?.main
  return (
    <Modal
      open
      onClose={closeModal}
      title={t('worktreePicker.title', { name: projectName ?? '' })}
      width={520}
    >
      <p className={controls.hint}>{t('worktreePicker.hint')}</p>
      {found?.checkouts?.main && found.checkouts.base === null ? (
        <p className={styles.notice}>{t('worktreePicker.baseUnknown')}</p>
      ) : null}
      {!found ? (
        <p className={styles.notice}>{t('worktreePicker.loading')}</p>
      ) : !found.checkouts ? (
        <p className={styles.notice}>{t('worktreePicker.notGit')}</p>
      ) : (
        <ul className={styles.list}>
          {found.checkouts.worktrees.map((checkout) => {
            const name = basename(checkout.path)
            const isMain = Boolean(main && sameCwd(checkout.path, main))
            const picked = sameCwd(checkout.path, found.root)
            return (
              <li key={checkout.path} className={styles.row}>
                <button
                  type="button"
                  title={checkout.path}
                  aria-pressed={picked}
                  className={`${controls.modeChoice} ${picked ? controls.modeChoiceActive : ''}`}
                  onClick={() => choose(checkout.path)}
                >
                  <span className={controls.modeChoiceIndicator} />
                  <span className={controls.modeChoiceBody}>
                    <strong className={styles.name}>
                      {name}
                      {isMain ? (
                        <span className={styles.badge}>{t('worktreePicker.main')}</span>
                      ) : null}
                      {checkout.stale ? (
                        <span
                          className={`${styles.badge} ${styles.stale}`}
                          title={t('worktreePicker.staleHint')}
                        >
                          {t('worktreePicker.stale')}
                        </span>
                      ) : null}
                      {checkout.uncommitted ? (
                        <span className={styles.badge}>
                          {t('worktreePicker.uncommitted', { count: checkout.uncommitted })}
                        </span>
                      ) : null}
                    </strong>
                    <small>
                      {checkout.branch ?? t('worktreePicker.detached')} ·{' '}
                      {checkout.lastCommitMs ? formatRelativeTimestamp(checkout.lastCommitMs) : '—'}
                    </small>
                  </span>
                </button>
                {!isMain && (checkout.stale || !checkout.branch) ? (
                  <button
                    type="button"
                    className={controls.iconBtnSm}
                    aria-label={t('worktreePicker.remove', { name })}
                    title={t('worktreePicker.remove', { name })}
                    onClick={() => void remove(checkout)}
                  >
                    <Trash2 size={13} />
                  </button>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      {notice ? (
        <p role="alert" className={styles.notice}>
          {notice}
        </p>
      ) : null}
    </Modal>
  )
}
