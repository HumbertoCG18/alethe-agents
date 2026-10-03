/**
 * Night scheduler rules (Modo noite): when a project's window is open, which campaign task to run
 * next, when the running one is done, and when the night ends. Pure; the runner lives in the Todo
 * plugin. The task rules mirror `campanhas.py listar --noite` ("livre") and the diary mirrors
 * `campanhas.py noite`.
 */
import { USAGE_FALLBACK_THRESHOLD } from './agentCanvasConfig'
import type { AgentFitness } from './agentFitness'
import {
  type Campaign,
  type CampaignTask,
  isoDay,
  type NightDiary,
  type NightEntry,
} from './campaigns'

export type NightSettings = {
  enabled: boolean
  /** Local "HH:MM"; the window may cross midnight. */
  start: string
  end: string
  maxMinutesPerTask: number
  maxTasks: number
}

export const DEFAULT_NIGHT_SETTINGS: NightSettings = {
  enabled: false,
  start: '23:00',
  end: '06:00',
  maxMinutesPerTask: 90,
  maxTasks: 5,
}

/** Why a night ended: window end, no free task, task maximum, 2 failures in a row, Claude quota. */
export type StopReason = 'window' | 'none' | 'max' | 'failures' | 'quota' | 'diary'
/** `falhou` or `parou` this many times in a row ends the night. */
const MAX_FAILURES = 2

/** Minutes since midnight of a "HH:MM" time; null when malformed. */
function clockMinutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value)
  return match ? Number(match[1]) * 60 + Number(match[2]) : null
}

/** campanhas.py `data_da_noite`: a night belongs to the day it began; before noon, yesterday. */
export function nightDate(now: Date): string {
  const day = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - (now.getHours() < 12 ? 1 : 0),
  )
  return isoDay(day)
}

/**
 * When the window holding `now` ends, as a real instant (a daylight saving jump inside it counts),
 * or null outside the window. Membership goes by the wall clock: start included, end excluded.
 */
export function windowEnd(now: Date, start: string, end: string): Date | null {
  const from = clockMinutes(start)
  const to = clockMinutes(end)
  if (from === null || to === null || from === to) return null
  const minute = now.getHours() * 60 + now.getMinutes()
  const inside = from < to ? minute >= from && minute < to : minute >= from || minute < to
  if (!inside) return null
  // Across midnight, the evening part of the window ends tomorrow.
  const tomorrow = from > to && minute >= from ? 1 : 0
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + tomorrow,
    Math.floor(to / 60),
    to % 60,
  )
}

/** Real minutes left in the window at `now`; 0 outside it. */
export function windowMinutesLeft(now: Date, start: string, end: string): number {
  const until = windowEnd(now, start, end)
  return until ? (until.getTime() - now.getTime()) / 60_000 : 0
}

export const inWindow = (now: Date, start: string, end: string) =>
  windowEnd(now, start, end) !== null

/**
 * The next free night task: effective window `noite`, state `pronta`, every prerequisite (its
 * campaign's and its own) finished, not in tonight's diary and not `attempted` tonight already.
 * Campaigns come by priority.
 */
export function nextNightTask(
  campaigns: readonly Campaign[],
  diary: NightDiary | null,
  attempted: readonly string[] = [],
): { campaign: Campaign; task: CampaignTask } | null {
  const tried = new Set([...(diary?.entries.map((entry) => entry.task) ?? []), ...attempted])
  for (const campaign of campaigns) {
    for (const task of campaign.tasks) {
      if (task.window !== 'noite' || task.state !== 'pronta' || task.unmet.length > 0) continue
      if (!tried.has(task.id)) return { campaign, task }
    }
  }
  return null
}

/** When a diary entry was written: `hora` on the night's date, or the next day before noon. */
function entryTime(date: string, time: string): number | null {
  const minutes = clockMinutes(time)
  const [year, month, day] = date.split('-').map(Number)
  if (minutes === null || !year || !month || !day) return null
  const hours = Math.floor(minutes / 60)
  return new Date(year, month - 1, day + (hours < 12 ? 1 : 0), hours, minutes % 60).getTime()
}

/** The latest entry for `taskId` written at or after `startedAt` (`hora` has minute precision). */
export function taskDone(
  diary: NightDiary | null,
  taskId: string,
  startedAt: number,
): NightEntry | null {
  const start = Math.floor(startedAt / 60_000) * 60_000
  const matches = (diary?.entries ?? []).filter((entry) => {
    const time = entry.task === taskId ? entryTime(diary!.date, entry.time) : null
    return time !== null && time >= start
  })
  return matches.at(-1) ?? null
}

export type StopInput = {
  now: Date
  settings: NightSettings
  /** Tasks started this night. */
  started: number
  /** `falhou`/`parou` results in a row. */
  failures: number
  hasTask: boolean
  /** Claude's usage, when it was read. */
  usage: AgentFitness | null
}

/** Why the night must not start another task, or null when it may. */
export function shouldStop(input: StopInput): StopReason | null {
  const { settings } = input
  // A task that could not finish inside the window is never started.
  const left = windowMinutesLeft(input.now, settings.start, settings.end)
  if (left === 0 || left < settings.maxMinutesPerTask) return 'window'
  if (input.started >= settings.maxTasks) return 'max'
  if (input.failures >= MAX_FAILURES) return 'failures'
  if (!input.hasTask) return 'none'
  const usage = input.usage
  if (usage && (usage.rateLimited || usage.used >= USAGE_FALLBACK_THRESHOLD)) return 'quota'
  return null
}

/**
 * The diary text with `entry` appended, in campanhas.py's shape; `source` is the file as read,
 * null when there is none yet. Null when the file is not a diary.
 */
export function appendNightEntry(
  source: string | null,
  night: string,
  entry: NightEntry,
): string | null {
  let data: unknown = { data: night, entradas: [] }
  if (source !== null) {
    try {
      data = JSON.parse(source)
    } catch {
      return null
    }
  }
  const diary = data as { entradas?: unknown }
  if (typeof data !== 'object' || data === null || !Array.isArray(diary.entradas)) return null
  diary.entradas.push({
    tarefa: entry.task,
    resultado: entry.result,
    resumo: entry.summary,
    evidencia: entry.evidence,
    hora: entry.time,
  })
  return `${JSON.stringify(data, null, 2)}\n`
}
