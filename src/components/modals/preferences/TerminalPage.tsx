import { Activity, Minus, Plus, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'

import { cliPathMatchesAgent } from '../../../lib/agentCliPath'
import { askConfirm, pickFile } from '../../../lib/dialog'
import { useT, useTDynamic } from '../../../lib/i18n'
import { isMacOS } from '../../../lib/platform'
import { countLiveResumablePanes, resetLastSession } from '../../../lib/resetLastSession'
import {
  discoverShells,
  installedFontFamilies,
  type ShellOption,
} from '../../../lib/tauri/terminalSettings'
import { BUNDLED_TERMINAL_FONT } from '../../../lib/terminalPreferences'
import { agentCliCommand, type AgentType,isShellAgentType } from '../../../lib/types'
import { SPAWN_CONCURRENCY_LIMITS, useProjectsStore } from '../../../stores/projectsStore'
import { useUiStore } from '../../../stores/uiStore'
import { AgentIcon } from '../../icons/AgentIcons'
import { Dropdown } from '../../ui/Dropdown'
import styles from '../PreferencesModal.module.css'
import { SettingsSection } from './primitives'

const AGENTS: { id: AgentType; label: string }[] = [
  { id: 'shell', label: 'Shell' },
  { id: 'wsl', label: 'WSL' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'copilot', label: 'GitHub Copilot' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'freebuff', label: 'Freebuff' },
  { id: 'mimo', label: 'Mimo Code' },
  { id: 'kiro', label: 'Kiro CLI' },
  { id: 'kimi', label: 'Kimi Code' },
  { id: 'grok', label: 'Grok Build' },
  { id: 'codewhale', label: 'Codewhale' },
]

export function TerminalPage({ enabledCount }: { enabledCount: number }) {
  const t = useT()
  const tDynamic = useTDynamic()
  const preferences = useProjectsStore((state) => state.preferences)
  const setAgentEnabled = useProjectsStore((state) => state.setAgentEnabled)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  const cliPaths = useProjectsStore((state) => state.cliPaths)
  const setCliPath = useProjectsStore((state) => state.setCliPath)
  const pushToast = useUiStore((state) => state.pushToast)
  const openModal = useUiStore((state) => state.openModal_)
  const [resetting, setResetting] = useState(false)
  const [shells, setShells] = useState<ShellOption[]>([])
  const [fonts, setFonts] = useState<string[]>([])
  const [shellError, setShellError] = useState(false)
  const [fontError, setFontError] = useState(false)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let active = true
    void Promise.all([
      discoverShells()
        .then((items) => {
          if (active) setShells(items)
        })
        .catch(() => {
          if (active) setShellError(true)
        }),
      installedFontFamilies()
        .then((items) => {
          if (active) setFonts(items)
        })
        .catch(() => {
          if (active) setFontError(true)
        }),
    ]).finally(() => {
      if (active) setLoading(false)
    })
    return () => {
      active = false
    }
  }, [])
  const concurrency = preferences.spawnConcurrency
  const setConcurrency = (n: number) =>
    setPreferences({
      spawnConcurrency: Math.min(
        SPAWN_CONCURRENCY_LIMITS.max,
        Math.max(SPAWN_CONCURRENCY_LIMITS.min, n),
      ),
    })

  const onPickCliPath = async (agent: AgentType) => {
    const picked = await pickFile({
      title: t('prefs.cliPathPick', { agent }),
      filters: [
        { name: 'Executable', extensions: ['cmd', 'exe', 'bat', 'ps1'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (!picked) return
    if (!cliPathMatchesAgent(agent, picked)) {
      pushToast({
        title: t('prefs.cliPathMismatch'),
        body: t('prefs.cliPathMismatchBody', { agent, command: agentCliCommand(agent) ?? agent }),
      })
      return
    }
    setCliPath(agent, picked)
  }

  const onResetLastSession = async () => {
    if (resetting) return
    const count = countLiveResumablePanes()
    if (count === 0) {
      pushToast({ title: t('prefs.resetSessionEmpty'), body: t('prefs.resetSessionEmptyBody') })
      return
    }

    if (count > 1 && !(await askConfirm(t('prefs.resetSessionConfirm', { count })))) return
    setResetting(true)
    try {
      const { resumed, total } = await resetLastSession()
      if (total === 0) {
        pushToast({ title: t('prefs.resetSessionEmpty'), body: t('prefs.resetSessionEmptyBody') })
      } else {
        pushToast({
          title: t('prefs.resetSessionDone'),
          body: t('prefs.resetSessionDoneBody', { count: resumed }),
        })
      }
    } catch (err) {
      pushToast({ title: t('prefs.resetSessionFailed'), body: String(err) })
    } finally {
      setResetting(false)
    }
  }

  return (
    <>
      <SettingsSection
        id="default-shell"
        title={t('prefs.defaultShell')}
        description={t('prefs.defaultShellDesc')}
      >
        <Dropdown
          className={styles.select}
          value={preferences.defaultShell ?? ''}
          ariaLabel={t('prefs.defaultShell')}
          searchable
          searchPlaceholder={t('prefs.shellSearch')}
          onChange={(shell) => setPreferences({ defaultShell: shell || null })}
          displayValue={
            shells.find((item) => item.id === preferences.defaultShell)?.label ??
            preferences.defaultShell ??
            t('prefs.shellAutomatic')
          }
          options={[
            { value: '', label: t('prefs.shellAutomatic') },
            ...shells.map((item) => ({
              value: item.id,
              label: item.label,
              searchText: `${item.label} ${item.id}`,
            })),
          ]}
        />
        {shellError ? <p role="alert">{t('prefs.shellDiscoveryError')}</p> : null}
        {!loading &&
        preferences.defaultShell &&
        !shells.some((item) => item.id === preferences.defaultShell) ? (
          <p role="alert">{t('prefs.shellMissing')}</p>
        ) : null}
      </SettingsSection>
      <SettingsSection
        id="terminal-font"
        title={t('prefs.terminalFont')}
        description={t('prefs.terminalFontDesc')}
      >
        <Dropdown
          className={styles.select}
          value={preferences.terminalFontFamily ?? ''}
          ariaLabel={t('prefs.terminalFont')}
          searchable
          searchPlaceholder={t('prefs.fontSearch')}
          displayValue={preferences.terminalFontFamily || BUNDLED_TERMINAL_FONT}
          onChange={(family) => setPreferences({ terminalFontFamily: family || null })}
          options={[
            { value: '', label: BUNDLED_TERMINAL_FONT },
            ...fonts
              .filter((family) => family !== BUNDLED_TERMINAL_FONT)
              .map((family) => ({ value: family, label: family })),
          ]}
        />
        {loading ? <p role="status">{t('prefs.terminalDiscoveryLoading')}</p> : null}
        {fontError ? <p role="alert">{t('prefs.fontDiscoveryError')}</p> : null}
        {!loading &&
        preferences.terminalFontFamily &&
        preferences.terminalFontFamily !== BUNDLED_TERMINAL_FONT &&
        !fonts.includes(preferences.terminalFontFamily) ? (
          <p role="alert">{t('prefs.fontMissing')}</p>
        ) : null}
      </SettingsSection>
      <SettingsSection
        id="resource-policy"
        title={t('prefs.resourcePolicy')}
        description={t('prefs.resourcePolicyDesc')}
      >
        <div className={styles.resourceControls}>
          <p className={styles.resourceHint}>{t('prefs.resourcePolicyManualHint')}</p>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => openModal('memoryAnalytics')}
          >
            <Activity size={15} />
            {t('ui.titlebar.openMemoryAnalytics')}
          </button>
        </div>
      </SettingsSection>

      <SettingsSection
        id="spawn-concurrency"
        title={t('prefs.spawnConcurrency')}
        description={t('prefs.spawnConcurrencyDesc')}
      >
        <div className={styles.zoomControl}>
          <button
            type="button"
            onClick={() => setConcurrency(concurrency - SPAWN_CONCURRENCY_LIMITS.step)}
            disabled={concurrency <= SPAWN_CONCURRENCY_LIMITS.min}
            aria-label={t('prefs.spawnConcurrencyDecrease')}
          >
            <Minus size={15} />
          </button>
          <strong>{concurrency}</strong>
          <button
            type="button"
            onClick={() => setConcurrency(concurrency + SPAWN_CONCURRENCY_LIMITS.step)}
            disabled={concurrency >= SPAWN_CONCURRENCY_LIMITS.max}
            aria-label={t('prefs.spawnConcurrencyIncrease')}
          >
            <Plus size={15} />
          </button>
          <button
            type="button"
            onClick={() => setConcurrency(3)}
            disabled={concurrency === 3}
            aria-label={t('prefs.spawnConcurrencyReset')}
          >
            <RotateCcw size={15} />
          </button>
        </div>
      </SettingsSection>

      <SettingsSection
        id="agents"
        title={t('prefs.enabledAgents', { count: enabledCount })}
        description={t('prefs.agentsDesc')}
      >
        <div className={styles.agentList}>
          {AGENTS.map((agent) => {
            const checked = preferences.enabledAgents[agent.id]
            const disabled = checked && enabledCount === 1
            return (
              <label key={agent.id} className={disabled ? styles.agentDisabled : undefined}>
                <span className={styles.agentIcon}>
                  <AgentIcon
                    type={agent.id}
                    size={20}
                    theme={preferences.terminalTheme ?? preferences.uiTheme}
                  />
                </span>
                <span className={styles.agentCopy}>
                  <strong>{agent.label}</strong>
                  <span>{tDynamic(`agent.${agent.id}.desc`)}</span>
                </span>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={(event) => setAgentEnabled(agent.id, event.target.checked)}
                />
              </label>
            )
          })}
        </div>
      </SettingsSection>

      <SettingsSection
        id="cli-paths"
        title={t('prefs.cliPaths')}
        description={t('prefs.cliPathsDesc')}
      >
        <div className={styles.agentList}>
          {AGENTS.filter((agent) => !isShellAgentType(agent.id)).map((agent) => {
            const override = cliPaths[agent.id]
            const mismatch = override ? !cliPathMatchesAgent(agent.id, override) : false
            return (
              <div key={agent.id} className={styles.cliPathRow}>
                <span className={styles.agentIcon}>
                  <AgentIcon
                    type={agent.id}
                    size={20}
                    theme={preferences.terminalTheme ?? preferences.uiTheme}
                  />
                </span>
                <span className={styles.agentCopy}>
                  <strong>{agent.label}</strong>
                  <span
                    className={mismatch ? styles.cliPathWarning : styles.cliPathValue}
                    title={override ?? undefined}
                  >
                    {override ?? t('prefs.cliPathAuto')}
                  </span>
                </span>
                <span className={styles.cliPathActions}>
                  <button type="button" onClick={() => void onPickCliPath(agent.id)}>
                    {t('prefs.cliPathSet')}
                  </button>
                  {override ? (
                    <button type="button" onClick={() => setCliPath(agent.id, null)}>
                      {t('prefs.cliPathReset')}
                    </button>
                  ) : null}
                </span>
              </div>
            )
          })}
        </div>
      </SettingsSection>

      <SettingsSection
        id="limit-reset-notify"
        title={t('prefs.limitResetNotify')}
        description={t('prefs.limitResetNotifyDesc')}
      >
        <div className={styles.segmented}>
          <button
            type="button"
            className={preferences.notifyOnLimitReset ? styles.segmentActive : undefined}
            onClick={() => setPreferences({ notifyOnLimitReset: true })}
          >
            {t('prefs.limitResetNotifyOn')}
          </button>
          <button
            type="button"
            className={!preferences.notifyOnLimitReset ? styles.segmentActive : undefined}
            onClick={() => setPreferences({ notifyOnLimitReset: false })}
          >
            {t('prefs.limitResetNotifyOff')}
          </button>
        </div>
      </SettingsSection>

      {isMacOS() ? (
        <SettingsSection
          id="native-terminal-macos"
          title={t('prefs.nativeTerminalMacos')}
          description={t('prefs.nativeTerminalMacosDesc')}
        >
          <label className={styles.checkboxCard}>
            <input
              type="checkbox"
              checked={preferences.nativeTerminalMacos ?? false}
              onChange={(e) => setPreferences({ nativeTerminalMacos: e.target.checked })}
            />
            <span>{t('prefs.nativeTerminalMacosEnable')}</span>
          </label>
        </SettingsSection>
      ) : null}

      <SettingsSection
        id="reset-session"
        title={t('prefs.resetSession')}
        description={t('prefs.resetSessionDesc')}
      >
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={() => void onResetLastSession()}
          disabled={resetting}
        >
          <RotateCcw size={15} />
          {resetting ? t('prefs.resetSessionBusy') : t('prefs.resetSessionButton')}
        </button>
      </SettingsSection>
    </>
  )
}
