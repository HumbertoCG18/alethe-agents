import { Bell, Check, Copy, X } from 'lucide-react'
import { type CSSProperties, useEffect, useState } from 'react'

import { agentAccentVar } from '../lib/agentProviders'
import { useT } from '../lib/i18n'
import { writeClipboardText } from '../lib/tauri'
import { useProjectsStore } from '../stores/projectsStore'
import { type InAppToast, useUiStore } from '../stores/uiStore'
import { AgentIcon } from './icons/AgentIcons'
import styles from './InAppNotifications.module.css'

function ToastItem({ toast }: { toast: InAppToast }) {
  const t = useT()
  const dismissToast = useUiStore((s) => s.dismissToast)
  const uiTheme = useProjectsStore((s) => s.preferences.uiTheme)

  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    // Someone reading the whole message must not lose it mid-sentence; the X still closes it.
    if (expanded) return
    // A toast that asks something has to outlive a glance, or the offer is gone before it is read.
    const timer = window.setTimeout(
      () => dismissToast(toast.id),
      toast.actions?.length ? 20000 : 6500,
    )
    return () => window.clearTimeout(timer)
  }, [dismissToast, toast.id, toast.actions, expanded])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = () => {
    const text = `${toast.title}\n${toast.body}`
    void writeClipboardText(text)
      .catch(() => navigator.clipboard.writeText(text))
      .then(() => setCopied(true))
      .catch(() => {})
  }

  const accentStyle = {
    '--toast-accent': toast.agent ? agentAccentVar(toast.agent) : 'var(--accent)',
  } as CSSProperties

  return (
    <div
      className={`${styles.toast} ${expanded ? styles.toastExpanded : ''}`}
      role="status"
      style={accentStyle}
    >
      <div className={styles.toastIcon} aria-hidden>
        {toast.agent ? (
          <AgentIcon type={toast.agent} size={16} theme={uiTheme} />
        ) : (
          <Bell size={14} />
        )}
      </div>
      <div className={styles.toastText}>
        <button
          type="button"
          className={styles.toastMain}
          onClick={() => setExpanded((value) => !value)}
          // The message itself names the button; the state is in aria-expanded.
          aria-expanded={expanded}
          title={t(expanded ? 'notif.collapse' : 'notif.expand')}
        >
          <strong>{toast.title}</strong>
          <span>{toast.body}</span>
        </button>
        {toast.actions?.length ? (
          <div className={styles.toastActions}>
            {toast.actions.map((action, index) => (
              <button
                key={action.label}
                type="button"
                className={
                  action.quiet
                    ? styles.toastActionQuiet
                    : index === 0
                      ? styles.toastAction
                      : styles.toastActionSecondary
                }
                onClick={() => {
                  action.run()
                  dismissToast(toast.id)
                }}
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {toast.body ? (
        <button
          type="button"
          className={styles.toastClose}
          onClick={copy}
          aria-label={t(copied ? 'notif.copied' : 'notif.copy')}
          title={t(copied ? 'notif.copied' : 'notif.copy')}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      ) : null}
      <button
        type="button"
        className={styles.toastClose}
        onClick={() => dismissToast(toast.id)}
        aria-label={t('common.close')}
        title={t('common.close')}
      >
        <X size={14} />
      </button>
    </div>
  )
}

export function InAppNotifications() {
  const toasts = useUiStore((s) => s.toasts)
  if (toasts.length === 0) return null

  return (
    <div className={styles.toastStack} aria-live="polite" aria-relevant="additions">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  )
}
