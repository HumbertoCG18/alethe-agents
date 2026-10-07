import { useEffect, useState } from 'react'

import { useT } from '../../../lib/i18n'
import { DEFAULT_MARKDOWN_SUMMARY } from '../../../lib/markdownSummary'
import { type DiscoveredModel, discoverProviderModels } from '../../../lib/tauri/agents'
import type { MarkdownSummarySettings } from '../../../lib/types'
import { useProjectsStore } from '../../../stores/projectsStore'
import { Dropdown } from '../../ui/Dropdown'
import controls from '../controls.module.css'
import styles from '../PreferencesModal.module.css'
import { SettingsSection } from './primitives'

export function MarkdownPage() {
  const t = useT()
  const settings =
    useProjectsStore((s) => s.preferences.markdownSummary) ?? DEFAULT_MARKDOWN_SUMMARY
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const [models, setModels] = useState<DiscoveredModel[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  useEffect(() => {
    let active = true
    setModels([])
    setStatus('loading')
    void discoverProviderModels(settings.agent)
      .then((items) => {
        if (active) {
          setModels(items)
          setStatus('ready')
        }
      })
      .catch(() => {
        if (active) setStatus('error')
      })
    return () => {
      active = false
    }
  }, [settings.agent])
  const save = (patch: Partial<MarkdownSummarySettings>) =>
    setPreferences({ markdownSummary: { ...settings, ...patch } })
  return (
    <SettingsSection
      id="markdown"
      title={t('markdown.settings')}
      description={t('markdown.settingsDesc')}
    >
      <label>
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(e) => save({ enabled: e.target.checked })}
        />{' '}
        {t('markdown.enabled')}
      </label>
      <p>{t('markdown.privacy')}</p>
      <div className={controls.label}>
        {t('markdown.agent')}
        <Dropdown
          className={styles.select}
          value={settings.agent}
          ariaLabel={t('markdown.agent')}
          onChange={(agent) =>
            save({ agent: agent as MarkdownSummarySettings['agent'], model: '' })
          }
          options={[
            { value: 'antigravity', label: t('markdown.agyUnavailable'), disabled: true },
            { value: 'claude', label: 'Claude Code' },
            { value: 'codex', label: 'Codex' },
          ]}
        />
      </div>
      <div className={controls.label}>
        {t('markdown.model')}
        <Dropdown
          className={styles.select}
          value={settings.model}
          displayValue={
            models.find((item) => item.id === settings.model)?.label ??
            (settings.model || t('markdown.defaultModel'))
          }
          ariaLabel={t('markdown.model')}
          searchable
          allowCustomValue
          searchPlaceholder={t('markdown.modelSearch')}
          onChange={(model) => save({ model: model.trim().slice(0, 160) })}
          options={[
            { value: '', label: t('markdown.defaultModel') },
            ...models.map((item) => ({ value: item.id, label: item.label })),
          ]}
        />
        {status === 'loading' ? <span role="status">{t('markdown.modelsLoading')}</span> : null}
        {status === 'error' ? <span role="alert">{t('markdown.modelsError')}</span> : null}
      </div>
      <div className={controls.label}>
        {t('markdown.style')}
        <Dropdown
          className={styles.select}
          value={settings.style}
          ariaLabel={t('markdown.style')}
          onChange={(style) => save({ style: style as MarkdownSummarySettings['style'] })}
          options={(['caveman', 'medium', 'detailed'] as const).map((style) => ({
            value: style,
            label: t(`markdown.${style}`),
          }))}
        />
      </div>
    </SettingsSection>
  )
}
