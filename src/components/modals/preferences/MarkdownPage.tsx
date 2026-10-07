import { useEffect, useState } from 'react'

import { useT } from '../../../lib/i18n'
import {
  DEFAULT_MARKDOWN_SUMMARY,
  MARKDOWN_MAX_AGE_OPTIONS,
  normalizeMarkdownMaxAge,
} from '../../../lib/markdownSummary'
import { type DiscoveredModel, discoverProviderModels } from '../../../lib/tauri/agents'
import type { MarkdownSummarySettings } from '../../../lib/types'
import { useProjectsStore } from '../../../stores/projectsStore'
import { Dropdown } from '../../ui/Dropdown'
import styles from '../PreferencesModal.module.css'
import { SettingsSection } from './primitives'

export function MarkdownPage() {
  const t = useT()
  const settings =
    useProjectsStore((s) => s.preferences.markdownSummary) ?? DEFAULT_MARKDOWN_SUMMARY
  const maxAge = normalizeMarkdownMaxAge(
    useProjectsStore((s) => s.preferences.markdownCatalogMaxAgeDays),
  )
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
  const ageLabel = (days: number) =>
    days ? t('markdown.maxAgeDays', { count: days }) : t('markdown.maxAgeNever')
  return (
    <>
      <SettingsSection
        id="markdown-summaries"
        title={t('markdown.summaries')}
        description={t('markdown.privacy')}
      >
        <label className={styles.checkboxCard}>
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => save({ enabled: e.target.checked })}
          />
          <span>{t('markdown.enabled')}</span>
        </label>
      </SettingsSection>
      <SettingsSection
        id="markdown-agent"
        title={t('markdown.agent')}
        description={t('markdown.agentDesc')}
      >
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
      </SettingsSection>
      <SettingsSection
        id="markdown-model"
        title={t('markdown.model')}
        description={t('markdown.modelDesc')}
      >
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
        {status === 'loading' ? (
          <p className={styles.resourceHint} role="status">
            {t('markdown.modelsLoading')}
          </p>
        ) : null}
        {status === 'error' ? (
          <p className={styles.resourceHint} role="alert">
            {t('markdown.modelsError')}
          </p>
        ) : null}
      </SettingsSection>
      <SettingsSection
        id="markdown-style"
        title={t('markdown.style')}
        description={t('markdown.styleDesc')}
      >
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
      </SettingsSection>
      <SettingsSection
        id="markdown-max-age"
        title={t('markdown.maxAge')}
        description={t('markdown.maxAgeDesc')}
      >
        <Dropdown
          className={styles.select}
          value={String(maxAge)}
          ariaLabel={t('markdown.maxAge')}
          displayValue={ageLabel(maxAge)}
          onChange={(days) => setPreferences({ markdownCatalogMaxAgeDays: Number(days) })}
          options={MARKDOWN_MAX_AGE_OPTIONS.map((days) => ({
            value: String(days),
            label: ageLabel(days),
          }))}
        />
      </SettingsSection>
    </>
  )
}
