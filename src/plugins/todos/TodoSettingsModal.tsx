import { Folder, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'

import controls from '../../components/modals/controls.module.css'
import { Modal } from '../../components/modals/Modal'
import { pickDirectory } from '../../lib/dialog'
import { useT } from '../../lib/i18n'
import { DEFAULT_NIGHT_SETTINGS, type NightSettings } from '../../lib/nightScheduler'
import { ensureTodoTemplate } from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { TODO_SETTINGS_MODAL_ID } from './manifest'
import { type ListSource, useTodosStore } from './store'
import styles from './TodoSidebar.module.css'

/** A whole count from 1 to `max`; `fallback` for anything else. */
const count = (value: number, max: number, fallback: number) =>
  Number.isFinite(value) && value >= 1 ? Math.min(max, Math.round(value)) : fallback

const isClock = (value: string) => /^\d{2}:\d{2}$/.test(value)

/** The draft as it would be saved: an emptied or invalid field keeps the saved value. */
function nightToSave(draft: NightSettings, saved: NightSettings): NightSettings {
  return {
    enabled: draft.enabled,
    start: isClock(draft.start) ? draft.start : saved.start,
    end: isClock(draft.end) ? draft.end : saved.end,
    maxMinutesPerTask: count(draft.maxMinutesPerTask, 600, saved.maxMinutesPerTask),
    maxTasks: count(draft.maxTasks, 50, saved.maxTasks),
  }
}

export function TodoSettingsModal() {
  const t = useT()
  const open = useUiStore((state) => state.openModal === TODO_SETTINGS_MODAL_ID)
  const closeModal = useUiStore((state) => state.closeModal)
  const savedPath = useTodosStore((state) => state.storagePath)
  const setStoragePath = useTodosStore((state) => state.setStoragePath)
  const resetTodosToDefault = useTodosStore((state) => state.resetTodosToDefault)
  const savedSource = useTodosStore((state) => state.listSource)
  const setListSource = useTodosStore((state) => state.setListSource)
  const savedWorkMinutes = useProjectsStore((state) => state.preferences.pomodoroWorkMinutes)
  const savedShortBreakMinutes = useProjectsStore(
    (state) => state.preferences.pomodoroShortBreakMinutes,
  )
  const savedLongBreakMinutes = useProjectsStore(
    (state) => state.preferences.pomodoroLongBreakMinutes,
  )
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  const projectId = useProjectsStore((state) => state.activeProjectId)
  const savedNight = useTodosStore((state) =>
    projectId ? state.nightSettings[projectId] : undefined,
  )
  const setNightSettings = useTodosStore((state) => state.setNightSettings)
  const [night, setNight] = useState<NightSettings>(DEFAULT_NIGHT_SETTINGS)
  const [path, setPath] = useState('')
  const [source, setSource] = useState<ListSource>(savedSource)
  const [saving, setSaving] = useState(false)
  const [workMinutes, setWorkMinutes] = useState(savedWorkMinutes)
  const [shortBreakMinutes, setShortBreakMinutes] = useState(savedShortBreakMinutes)
  const [longBreakMinutes, setLongBreakMinutes] = useState(savedLongBreakMinutes)

  useEffect(() => {
    if (open) setPath(savedPath)
  }, [open, savedPath])

  useEffect(() => {
    if (open) setSource(savedSource)
  }, [open, savedSource])

  useEffect(() => {
    if (open) setNight(savedNight ?? DEFAULT_NIGHT_SETTINGS)
  }, [open, savedNight])

  useEffect(() => {
    if (!open) return
    setWorkMinutes(savedWorkMinutes)
    setShortBreakMinutes(savedShortBreakMinutes)
    setLongBreakMinutes(savedLongBreakMinutes)
  }, [open, savedWorkMinutes, savedShortBreakMinutes, savedLongBreakMinutes])

  const clampMinutes = (value: number) => Math.min(120, Math.max(1, Math.round(value)))

  const browse = async () => {
    const selected = await pickDirectory({ defaultPath: path || savedPath || undefined })
    if (selected) setPath(selected)
  }

  const save = async () => {
    const finalPath = path.trim()
    setSaving(true)
    try {
      if (finalPath) {
        await ensureTodoTemplate(finalPath)
      }
      setStoragePath(finalPath)
      setListSource(source)
      if (projectId) {
        const saved = savedNight ?? DEFAULT_NIGHT_SETTINGS
        const next = nightToSave(night, saved)
        // Unchanged settings are not saved: a save reconsiders a night that already ended.
        if (JSON.stringify(next) !== JSON.stringify(saved)) setNightSettings(projectId, next)
      }
      setPreferences({
        pomodoroWorkMinutes: clampMinutes(workMinutes),
        pomodoroShortBreakMinutes: clampMinutes(shortBreakMinutes),
        pomodoroLongBreakMinutes: clampMinutes(longBreakMinutes),
      })
      closeModal()
    } catch (error) {
      window.alert(t('todo.templateError', { message: String(error) }))
    } finally {
      setSaving(false)
    }
  }

  const resetDefault = () => {
    if (!window.confirm(t('todo.resetDefaultConfirm'))) return
    resetTodosToDefault()
    closeModal()
  }

  return (
    <Modal
      open={open}
      onClose={closeModal}
      title={t('todo.settingsTitle')}
      width={520}
      footer={
        <>
          <button type="button" className={controls.btn} onClick={closeModal}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={`${controls.btn} ${controls.btnPrimary}`}
            onClick={() => void save()}
            disabled={saving}
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className={controls.field}>
        <span className={controls.label}>{t('todo.sourceLabel')}</span>
        <div className={controls.pillRow}>
          {(['campaign', 'mine'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={`${controls.pill} ${source === value ? controls.pillActive : ''}`}
              aria-pressed={source === value}
              onClick={() => setSource(value)}
            >
              {t(value === 'campaign' ? 'todo.sourceActiveCampaign' : 'todo.personalTitle')}
            </button>
          ))}
        </div>
        <span className={controls.hint}>{t('todo.sourceHint')}</span>
      </div>
      {projectId ? (
        <div className={controls.field}>
          <span className={controls.label}>{t('todo.nightMode.title')}</span>
          <label className={controls.checkboxRow}>
            <input
              type="checkbox"
              checked={night.enabled}
              onChange={(event) => setNight({ ...night, enabled: event.target.checked })}
            />
            <span className={controls.checkboxLabel}>{t('todo.nightMode.enable')}</span>
          </label>
          {night.enabled ? (
            <>
              <div className={controls.cwdRow}>
                <label className={styles.nightField}>
                  <span className={controls.hint}>{t('todo.nightMode.start')}</span>
                  <input
                    type="time"
                    className={controls.input}
                    value={night.start}
                    onChange={(event) => setNight({ ...night, start: event.target.value })}
                  />
                </label>
                <label className={styles.nightField}>
                  <span className={controls.hint}>{t('todo.nightMode.end')}</span>
                  <input
                    type="time"
                    className={controls.input}
                    value={night.end}
                    onChange={(event) => setNight({ ...night, end: event.target.value })}
                  />
                </label>
              </div>
              <div className={controls.cwdRow}>
                <label className={styles.nightField}>
                  <span className={controls.hint}>{t('todo.nightMode.maxMinutes')}</span>
                  <input
                    type="number"
                    min={1}
                    max={600}
                    className={controls.input}
                    value={night.maxMinutesPerTask}
                    onChange={(event) =>
                      setNight({ ...night, maxMinutesPerTask: Number(event.target.value) })
                    }
                  />
                </label>
                <label className={styles.nightField}>
                  <span className={controls.hint}>{t('todo.nightMode.maxTasks')}</span>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    className={controls.input}
                    value={night.maxTasks}
                    onChange={(event) =>
                      setNight({ ...night, maxTasks: Number(event.target.value) })
                    }
                  />
                </label>
              </div>
            </>
          ) : null}
          <span className={controls.hint}>{t('todo.nightMode.hint')}</span>
        </div>
      ) : null}
      <div className={controls.field}>
        <label className={controls.label}>{t('todo.pathLabel')}</label>
        <div className={controls.cwdRow}>
          <input
            className={controls.input}
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder={t('todo.pathPlaceholder')}
          />
          <button
            type="button"
            className={controls.btn}
            onClick={browse}
            title={t('todo.choosePath')}
            aria-label={t('todo.choosePath')}
          >
            <Folder size={14} />
          </button>
          <button
            type="button"
            className={controls.btn}
            onClick={() => setPath('')}
            title={t('todo.clearPath')}
            aria-label={t('todo.clearPath')}
          >
            <RotateCcw size={14} />
          </button>
        </div>
        <span className={controls.hint}>{t('todo.pathHint')}</span>
      </div>
      <div className={controls.field}>
        <label className={controls.label}>{t('pomodoro.settingsWorkMinutes')}</label>
        <input
          type="number"
          min={1}
          max={120}
          className={controls.input}
          value={workMinutes}
          onChange={(event) => setWorkMinutes(Number(event.target.value))}
        />
      </div>
      <div className={controls.field}>
        <label className={controls.label}>{t('pomodoro.settingsShortBreakMinutes')}</label>
        <input
          type="number"
          min={1}
          max={120}
          className={controls.input}
          value={shortBreakMinutes}
          onChange={(event) => setShortBreakMinutes(Number(event.target.value))}
        />
      </div>
      <div className={controls.field}>
        <label className={controls.label}>{t('pomodoro.settingsLongBreakMinutes')}</label>
        <input
          type="number"
          min={1}
          max={120}
          className={controls.input}
          value={longBreakMinutes}
          onChange={(event) => setLongBreakMinutes(Number(event.target.value))}
        />
      </div>
      <div className={controls.field}>
        <label className={controls.label}>{t('todo.defaultLabel')}</label>
        <button type="button" className={controls.btn} onClick={resetDefault}>
          {t('todo.resetDefault')}
        </button>
      </div>
    </Modal>
  )
}
