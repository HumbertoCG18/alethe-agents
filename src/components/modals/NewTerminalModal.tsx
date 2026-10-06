import {
  Folder,
  FolderSearch,
  Grid2X2,
  ListChecks,
  SquareTerminal,
  Waypoints,
  Workflow,
  Zap,
} from 'lucide-react'
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'

import { useRouter9Runtime } from '../../hooks/useRouter9Runtime'
import {
  agentLabel,
  isAgentEnabled,
  resolveUnrestrictedFlag,
  useAgentTypes,
} from '../../lib/agentProviders'
import { pickDirectory } from '../../lib/dialog'
import { useT } from '../../lib/i18n'
import { createOrchestratedTerminal } from '../../lib/orchestrationOnTerminal'
import { basename, pathSegments } from '../../lib/paths'
import { formatShortcut } from '../../lib/platform'
import { anchoredCwd } from '../../lib/projectCheckout'
import { DEFAULT_GRID_ID } from '../../lib/projectGrids'
import { router9SupportsAgent } from '../../lib/router9'
import {
  type AgentRuntimeProfile,
  type AgentType,
  isShellAgentType,
  type TerminalCreationPreset,
} from '../../lib/types'
import { getProjectDefaultCwd, useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { AgentIcon } from '../icons/AgentIcons'
import controls from './controls.module.css'
import { Modal } from './Modal'
import styles from './NewTerminalModal.module.css'
import { RowSelect, type RowSelectOption } from './RowSelect'

const PLANNER_AGENTS: AgentType[] = ['claude', 'codex']

const BROWSE_OPTION = '__browse__'
const UNGROUPED_GRID = '__ungrouped__'

type SessionMode = 'terminal' | 'orchestration'

function shortenPath(path: string): string {
  const segments = pathSegments(path)
  if (segments.length <= 2) return path
  const separator = path.includes('\\') ? '\\' : '/'
  return `…${separator}${segments.slice(-2).join(separator)}`
}

export function NewTerminalModal() {
  const t = useT()
  const open = useUiStore((s) => s.openModal === 'newTerminal')
  const context = useUiStore((s) => s.modalContext) as {
    projectId?: string
    gridId?: string
    cwd?: string
    onCreate?: (creation: TerminalCreationPreset) => Promise<boolean>
    // Callers that need a particular kind of terminal narrow the choice rather than opening a
    // second modal that would drift from this one.
    only?: AgentType[]
    titleKey?: 'term.newTerminalTitle' | 'term.newPlannerTitle'
  } | null
  const closeModal = useUiStore((s) => s.closeModal)
  const createAgentTerminal = useProjectsStore((s) => s.createAgentTerminal)
  const alwaysStartUnrestricted = useProjectsStore((s) => s.preferences.alwaysStartUnrestricted)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const project = useProjectsStore((s) =>
    context?.projectId ? (s.projects.find((p) => p.id === context.projectId) ?? null) : null,
  )
  const projects = useProjectsStore((s) => s.projects)
  const enabled = useProjectsStore((s) => s.preferences.enabledAgents)
  const terminalTheme = useProjectsStore(
    (s) => s.preferences.terminalTheme ?? s.preferences.uiTheme,
  )

  const router9 = useRouter9Runtime(open)
  const [useRouter9, setUseRouter9] = useState(false)
  const [mode, setMode] = useState<SessionMode>('terminal')
  const [type, setType] = useState<AgentType>('claude')
  const [goal, setGoal] = useState('')
  const [createMore, setCreateMore] = useState(false)
  const [runtimeProfile, setRuntimeProfile] = useState<AgentRuntimeProfile>('lean')
  const [cwd, setCwd] = useState('')
  const [unrestricted, setUnrestricted] = useState<Partial<Record<AgentType, boolean>>>({})
  const [selectedGridId, setSelectedGridId] = useState(UNGROUPED_GRID)

  const only = context?.only
  const isPlannerContext = context?.titleKey === 'term.newPlannerTitle'
  const allAgents = useAgentTypes().map((type) => ({ type, label: agentLabel(type) }))
  const visibleAgents = allAgents.filter(
    (agent) => isAgentEnabled(enabled, agent.type) && (!only || only.includes(agent.type)),
  )
  const plannerAgents = visibleAgents.filter((a) => PLANNER_AGENTS.includes(a.type))
  const canOrchestrate = !context?.onCreate && !isPlannerContext && plannerAgents.length > 0
  const orchestrating = canOrchestrate && mode === 'orchestration'
  const modeAgents = orchestrating ? plannerAgents : visibleAgents
  const defaultType =
    visibleAgents.find((agent) => agent.type === 'claude')?.type ??
    visibleAgents[0]?.type ??
    'shell'
  const selectedAgent = allAgents.find((agent) => agent.type === type) ?? allAgents[0]
  const inheritedCwd = useMemo(
    () => context?.cwd ?? getProjectDefaultCwd(project, projects),
    [context?.cwd, project, projects],
  )
  const recentFolders = useMemo(() => {
    const folders = new Map<string, { path: string; lastUsedAt: number }>()
    for (const candidate of projects) {
      for (const terminal of candidate.terminals) {
        const paths = [terminal.cwd, ...terminal.tabs.map((tab) => tab.cwd)]
        for (const path of paths) {
          const trimmed = path?.trim()
          if (!trimmed) continue
          const key = trimmed.replace(/[\\/]+$/, '').toLowerCase()
          const lastUsedAt = terminal.lastUsedAt ?? 0
          const previous = folders.get(key)
          if (!previous || lastUsedAt > previous.lastUsedAt) {
            folders.set(key, { path: trimmed, lastUsedAt })
          }
        }
      }
    }
    return [...folders.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, 4)
  }, [projects])

  /** The folder last offered. While the field still holds it, the field follows the project's
   *  folder (its anchor may land with the modal open); a folder the user chose stays. */
  const offeredCwd = useRef('')
  const wasOpen = useRef(false)
  useEffect(() => {
    if (!open) {
      wasOpen.current = false
      return
    }
    const opening = !wasOpen.current
    const offered = offeredCwd.current
    wasOpen.current = true
    offeredCwd.current = inheritedCwd
    setCwd((current) => (opening || current === offered ? inheritedCwd : current))
  }, [open, inheritedCwd])

  useEffect(() => {
    if (!open) return
    setType(defaultType)
    setMode('terminal')
    setGoal('')
    setCreateMore(false)
    setUseRouter9(router9.config.defaultForNewAgents)
    setUnrestricted({
      shell: alwaysStartUnrestricted,
      claude: alwaysStartUnrestricted,
      codex: alwaysStartUnrestricted,
      copilot: alwaysStartUnrestricted,
      antigravity: alwaysStartUnrestricted,
      opencode: alwaysStartUnrestricted,
      freebuff: alwaysStartUnrestricted,
      mimo: alwaysStartUnrestricted,
      kiro: alwaysStartUnrestricted,
      kimi: alwaysStartUnrestricted,
      grok: alwaysStartUnrestricted,
      codewhale: alwaysStartUnrestricted,
    })
    setSelectedGridId(context?.gridId ?? UNGROUPED_GRID)
  }, [
    open,
    context?.projectId,
    context?.gridId,
    defaultType,
    alwaysStartUnrestricted,
    router9.config.defaultForNewAgents,
  ])

  const reset = () => {
    setType(defaultType)
    setMode('terminal')
    setGoal('')
    setCreateMore(false)
    setRuntimeProfile('lean')
    setUseRouter9(false)
    setCwd('')
    setUnrestricted({
      shell: false,
      claude: false,
      codex: false,
      copilot: false,
      antigravity: false,
      opencode: false,
      freebuff: false,
      mimo: false,
      kiro: false,
      kimi: false,
      grok: false,
      codewhale: false,
    })
    setSelectedGridId(UNGROUPED_GRID)
  }

  // Without a key the injected environment would be empty, so the toggle would silently do nothing.
  const routingAvailable = Boolean(
    router9.config.enabled &&
    router9.config.apiKey.trim() &&
    router9.hasInstall &&
    router9SupportsAgent(type),
  )

  const submitting = useRef(false)
  const [saving, setSaving] = useState(false)
  const submit = async () => {
    if (!context?.projectId || submitting.current) return
    submitting.current = true
    setSaving(true)
    try {
      const finalName = selectedAgent.label
      const finalCwd = context.onCreate
        ? cwd.trim()
        : await anchoredCwd(context.projectId, {
            typed: cwd,
            offered: offeredCwd.current,
          })
      const flag = resolveUnrestrictedFlag(type)
      const extraArgs = unrestricted[type] && flag ? [flag] : undefined
      const trimmedGoal = goal.trim()
      const creation = {
        name: finalName,
        cwd: finalCwd,
        firstTab: {
          type,
          cwd: finalCwd,
          extraArgs,
          runtimeProfile,
          useRouter9: routingAvailable && useRouter9,
          initialInput: orchestrating && trimmedGoal ? trimmedGoal : undefined,
        },
      }
      if (!finalCwd) return
      if (context.onCreate) {
        if (!(await context.onCreate(creation))) return
        if (
          useUiStore.getState().openModal === 'newTerminal' &&
          useUiStore.getState().modalContext === context
        ) {
          reset()
          closeModal()
        }
        return
      }
      setPreferences({ lastTerminalCreation: creation })
      const { projectId } = context
      const create = () =>
        createAgentTerminal(projectId, {
          ...creation,
          gridId: selectedGridId === UNGROUPED_GRID ? undefined : selectedGridId,
        })
      await (orchestrating ? createOrchestratedTerminal(projectId, finalCwd, create) : create())
      if (createMore && !orchestrating) return
      if (
        useUiStore.getState().openModal === 'newTerminal' &&
        useUiStore.getState().modalContext === context
      ) {
        reset()
        closeModal()
      }
    } finally {
      submitting.current = false
      setSaving(false)
    }
  }

  const browse = async () => {
    const dir = await pickDirectory({ defaultPath: cwd || inheritedCwd || undefined })
    if (dir) setCwd(dir)
  }

  const chooseMode = (next: SessionMode) => {
    setMode(next)
    const allowed = next === 'orchestration' ? plannerAgents : visibleAgents
    if (!allowed.some((agent) => agent.type === type)) setType(allowed[0]?.type ?? defaultType)
  }

  const modeOptions: RowSelectOption[] = [
    {
      value: 'terminal',
      title: t('term.openAsTerminal'),
      description: t('term.openAsTerminalDesc'),
      icon: <SquareTerminal size={15} />,
    },
    {
      value: 'orchestration',
      title: t('term.openAsOrchestration'),
      description: t('term.openAsOrchestrationDesc'),
      icon: <Workflow size={15} />,
    },
  ]

  const agentOptions: RowSelectOption[] = modeAgents.map((agent) => ({
    value: agent.type,
    title: agent.label,
    icon: <AgentIcon type={agent.type} size={17} theme={terminalTheme} />,
  }))

  const folderPaths = [inheritedCwd, ...recentFolders.map((folder) => folder.path)].filter(
    (path, index, list) =>
      Boolean(path) &&
      list.findIndex((other) => other.toLowerCase() === path.toLowerCase()) === index,
  )
  const folderOptions: RowSelectOption[] = [
    ...folderPaths.map((path) => ({
      value: path,
      title: basename(path) || path,
      description: path,
      icon: <Folder size={15} />,
    })),
    {
      value: BROWSE_OPTION,
      title: t('term.chooseFolder'),
      icon: <FolderSearch size={15} />,
    },
  ]
  const gridOptions: RowSelectOption[] = [
    { value: UNGROUPED_GRID, title: t('term.gridUngrouped'), icon: <SquareTerminal size={15} /> },
    ...(project?.grids ?? [])
      .filter((grid) => grid.id !== DEFAULT_GRID_ID)
      .map((grid) => ({ value: grid.id, title: grid.name, icon: <Grid2X2 size={15} /> })),
  ]

  const handleShortcut = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
    event.preventDefault()
    if (context?.projectId) void submit()
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (submitting.current) return
        reset()
        closeModal()
      }}
      className={styles.modal}
      title={t(context?.titleKey ?? 'term.newTerminalTitle')}
      width={500}
      footer={
        <>
          {!orchestrating && !context?.onCreate ? (
            <button
              type="button"
              className={styles.createMore}
              aria-pressed={createMore}
              onClick={() => setCreateMore((value) => !value)}
            >
              <span
                className={`${styles.switchTrack} ${createMore ? styles.switchTrackOn : ''}`}
                aria-hidden="true"
              />
              {t('term.createMore')}
            </button>
          ) : null}
          <span className={styles.footerFill} />
          <button
            type="button"
            className={controls.btn}
            onClick={() => {
              if (!submitting.current) closeModal()
            }}
            disabled={saving}
          >
            {t('term.cancel')}
          </button>
          <button
            type="button"
            className={`${controls.btn} ${controls.btnPrimary} ${styles.submitButton}`}
            onClick={() => void submit()}
            disabled={!context?.projectId || saving}
          >
            {orchestrating
              ? t('term.createOrchestration')
              : t('term.openAgent', { agent: selectedAgent.label })}
            <span className={styles.shortcut}>{formatShortcut('Ctrl+↵')}</span>
          </button>
        </>
      }
    >
      <div onKeyDown={handleShortcut}>
        <div className={styles.fields}>
          {isPlannerContext && project ? (
            <div className={styles.contextLine}>
              <span className={styles.contextIcon}>
                <Workflow size={15} />
              </span>
              <span>{t('term.plannerContext', { project: project.name })}</span>
            </div>
          ) : null}

          {canOrchestrate ? (
            <div className={styles.field}>
              <span className={styles.fieldLabel}>
                <span className={styles.fieldLabelText}>{t('term.openAs')}</span>
              </span>
              <RowSelect
                field="mode"
                autoFocus
                ariaLabel={t('term.openAs')}
                value={mode}
                options={modeOptions}
                onChange={(value) => chooseMode(value as SessionMode)}
                icon={orchestrating ? <Workflow size={15} /> : <SquareTerminal size={15} />}
                title={orchestrating ? t('term.openAsOrchestration') : t('term.openAsTerminal')}
                side={
                  orchestrating ? t('term.openAsOrchestrationSide') : t('term.openAsTerminalSide')
                }
              />
            </div>
          ) : null}

          <div className={styles.field}>
            <span className={styles.fieldLabel}>
              <span className={styles.fieldLabelText}>
                {orchestrating || isPlannerContext ? t('term.plannerLabel') : t('term.agentLabel')}
              </span>
            </span>
            <RowSelect
              field="agent"
              autoFocus={!canOrchestrate}
              ariaLabel={orchestrating ? t('term.plannerLabel') : t('term.agentLabel')}
              value={type}
              options={agentOptions}
              onChange={(value) => setType(value as AgentType)}
              icon={<AgentIcon type={type} size={17} theme={terminalTheme} />}
              title={selectedAgent.label}
              side={orchestrating ? t('term.plannerSide') : undefined}
            />
          </div>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>
              <span className={styles.fieldLabelText}>
                {orchestrating ? t('term.projectLabel') : t('term.folderLabel')}
              </span>
              <button type="button" className={styles.fieldAction} onClick={() => void browse()}>
                {t('term.chooseFolder')}
              </button>
            </span>
            <RowSelect
              field="folder"
              ariaLabel={orchestrating ? t('term.projectLabel') : t('term.folderLabel')}
              value={cwd}
              options={folderOptions}
              onChange={(value) => {
                if (value === BROWSE_OPTION) void browse()
                else setCwd(value)
              }}
              icon={<Folder size={15} />}
              title={basename(cwd) || cwd || t('term.shellDefaultPlaceholder')}
              side={cwd ? shortenPath(cwd) : undefined}
            />
          </div>

          {orchestrating ? (
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="new-terminal-goal">
                <span className={styles.fieldLabelText}>{t('term.goalLabel')}</span>
                <span className={styles.fieldNote}>{t('term.optional')}</span>
              </label>
              <div className={styles.goalRow}>
                <ListChecks size={15} className={styles.goalIcon} />
                <textarea
                  id="new-terminal-goal"
                  className={styles.goalInput}
                  rows={2}
                  value={goal}
                  onChange={(event) => setGoal(event.target.value)}
                  placeholder={t('term.goalPlaceholder')}
                />
              </div>
            </div>
          ) : null}
        </div>

        <details className={styles.advanced}>
          <summary>
            {t('term.advancedOptions')}
            <span className={styles.advancedHint}>{t('term.advancedHint')}</span>
          </summary>
          <div className={styles.advancedBody}>
            {project && gridOptions.length > 1 ? (
              <div className={styles.field}>
                <span className={styles.fieldLabel}>
                  <span className={styles.fieldLabelText}>{t('term.gridLabel')}</span>
                </span>
                <RowSelect
                  field="grid"
                  ariaLabel={t('term.gridLabel')}
                  value={selectedGridId}
                  options={gridOptions}
                  onChange={setSelectedGridId}
                  icon={
                    selectedGridId === UNGROUPED_GRID ? (
                      <SquareTerminal size={15} />
                    ) : (
                      <Grid2X2 size={15} />
                    )
                  }
                  title={
                    gridOptions.find((option) => option.value === selectedGridId)?.title ??
                    t('term.gridUngrouped')
                  }
                />
              </div>
            ) : null}
            {resolveUnrestrictedFlag(type) ? (
              <>
                <button
                  type="button"
                  className={`${styles.permissionToggle} ${unrestricted[type] ? styles.permissionToggleActive : ''}`}
                  onClick={() => setUnrestricted((value) => ({ ...value, [type]: !value[type] }))}
                  aria-pressed={unrestricted[type]}
                >
                  <span className={styles.permissionToggleIcon}>
                    <Zap size={16} />
                  </span>
                  <span className={styles.permissionToggleCopy}>
                    <span className={styles.permissionToggleTitle}>{t('term.unrestricted')}</span>
                    <span className={styles.permissionToggleDescription}>
                      {t('term.unrestrictedDescription')}
                    </span>
                  </span>
                  <span className={styles.permissionToggleState}>
                    {unrestricted[type] ? t('term.unrestrictedOn') : t('term.unrestrictedOff')}
                  </span>
                </button>
                <label className={styles.checkboxLine}>
                  <input
                    type="checkbox"
                    checked={alwaysStartUnrestricted}
                    onChange={(event) =>
                      setPreferences({ alwaysStartUnrestricted: event.target.checked })
                    }
                  />
                  <span>{t('term.alwaysUnrestricted')}</span>
                </label>
              </>
            ) : null}

            {routingAvailable ? (
              <>
                <button
                  type="button"
                  className={`${styles.permissionToggle} ${useRouter9 ? styles.permissionToggleActive : ''}`}
                  onClick={() => setUseRouter9((value) => !value)}
                  aria-pressed={useRouter9}
                >
                  <span className={styles.permissionToggleIcon}>
                    <Waypoints size={16} />
                  </span>
                  <span className={styles.permissionToggleCopy}>
                    <span className={styles.permissionToggleTitle}>{t('router9.routeToggle')}</span>
                    <span className={styles.permissionToggleDescription}>
                      {t('router9.routeToggleDesc')}
                    </span>
                  </span>
                  <span className={styles.permissionToggleState}>
                    {useRouter9 ? t('term.unrestrictedOn') : t('term.unrestrictedOff')}
                  </span>
                </button>

                {useRouter9 && !router9.status?.running ? (
                  <button
                    type="button"
                    className={styles.router9Start}
                    disabled={router9.busy}
                    onClick={() => void router9.start().catch(() => undefined)}
                  >
                    {router9.busy ? t('router9.starting') : t('router9.stoppedStart')}
                  </button>
                ) : null}

                <label className={styles.checkboxLine}>
                  <input
                    type="checkbox"
                    checked={router9.config.defaultForNewAgents}
                    onChange={(event) =>
                      setPreferences({
                        router9: { ...router9.config, defaultForNewAgents: event.target.checked },
                      })
                    }
                  />
                  <span>{t('router9.alwaysRoute')}</span>
                </label>
              </>
            ) : null}

            {!isShellAgentType(type) ? (
              <div className={controls.field}>
                <span className={controls.label}>{t('term.runtimeProfile')}</span>
                <div className={controls.pillRow}>
                  {(['full', 'lean', 'diagnostic'] as const).map((profile) => (
                    <button
                      key={profile}
                      type="button"
                      className={`${controls.pill} ${runtimeProfile === profile ? controls.pillActive : ''}`}
                      onClick={() => setRuntimeProfile(profile)}
                      title={t(`term.runtimeProfile.${profile}.desc`)}
                    >
                      {t(`term.runtimeProfile.${profile}`)}
                    </button>
                  ))}
                </div>
                <span className={controls.hint}>
                  {t(`term.runtimeProfile.${runtimeProfile}.desc`)}
                </span>
              </div>
            ) : null}

            <div className={controls.field}>
              <label className={controls.label} htmlFor="new-terminal-path">
                {t('term.folderCwd')}
              </label>
              <input
                id="new-terminal-path"
                className={styles.pathInput}
                value={cwd}
                onChange={(event) => setCwd(event.target.value)}
                placeholder={inheritedCwd || t('term.shellDefaultPlaceholder')}
              />
            </div>
          </div>
        </details>
      </div>
    </Modal>
  )
}
