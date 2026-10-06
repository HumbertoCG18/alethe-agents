import { useEffect, useState } from 'react'

import { useT } from '../../../lib/i18n'
import { DEFAULT_MARKDOWN_SUMMARY } from '../../../lib/markdownSummary'
import { type DiscoveredModel, discoverProviderModels } from '../../../lib/tauri/agents'
import type { MarkdownSummarySettings } from '../../../lib/types'
import { useProjectsStore } from '../../../stores/projectsStore'
import controls from '../controls.module.css'
import { SettingsSection } from './primitives'

export function MarkdownPage() {
  const t = useT()
  const settings =
    useProjectsStore((s) => s.preferences.markdownSummary) ?? DEFAULT_MARKDOWN_SUMMARY
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const [models, setModels] = useState<DiscoveredModel[]>([])
  const [model, setModel] = useState(settings.model)
  useEffect(() => {
    setModel(settings.model)
  }, [settings.model])
  useEffect(() => {
    let active = true
    setModels([])
    void discoverProviderModels(settings.agent)
      .then((items) => {
        if (active) setModels(items)
      })
      .catch(() => {})
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
      <label className={controls.label}>
        {t('markdown.agent')}
        <select
          className={controls.input}
          value={settings.agent}
          onChange={(e) =>
            save({ agent: e.target.value as MarkdownSummarySettings['agent'], model: '' })
          }
        >
          <option value="antigravity" disabled>
            {t('markdown.agyUnavailable')}
          </option>
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
        </select>
      </label>
      <label className={controls.label}>
        {t('markdown.model')}
        <input
          className={controls.input}
          list="markdown-models"
          value={model}
          maxLength={160}
          placeholder={t('markdown.defaultModel')}
          onChange={(e) => setModel(e.target.value)}
          onBlur={() => save({ model: model.trim() })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
      </label>
      <datalist id="markdown-models">
        {models.map((item) => (
          <option key={item.id} value={item.id}>
            {item.label}
          </option>
        ))}
      </datalist>
      <label className={controls.label}>
        {t('markdown.style')}
        <select
          className={controls.input}
          value={settings.style}
          onChange={(e) => save({ style: e.target.value as MarkdownSummarySettings['style'] })}
        >
          <option value="caveman">{t('markdown.caveman')}</option>
          <option value="medium">{t('markdown.medium')}</option>
          <option value="detailed">{t('markdown.detailed')}</option>
        </select>
      </label>
    </SettingsSection>
  )
}
