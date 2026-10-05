/** How the Todo tab names registry, diary and findings values, shared by its cards and task details. */
import type { CampaignWindow, FindingType, NightResult } from '../../lib/campaigns'
import { intlLocale, type Locale, type MessageKey } from '../../lib/i18n'

export const WINDOW_KEYS: Record<CampaignWindow, MessageKey> = {
  assistida: 'todo.campaigns.windowAssisted',
  noite: 'todo.campaigns.windowNight',
  qualquer: 'todo.campaigns.windowAny',
}

export const RESULT_KEYS: Record<NightResult, MessageKey> = {
  ok: 'todo.night.resultOk',
  'aguarda-voce': 'todo.night.resultWaiting',
  falhou: 'todo.night.resultFailed',
  parou: 'todo.night.resultStopped',
}

export const TYPE_KEYS: Record<FindingType, MessageKey> = {
  bug: 'todo.findings.bug',
  risco: 'todo.findings.risk',
  ideia: 'todo.findings.idea',
  divida: 'todo.findings.debt',
}

/** A diary's `YYYY-MM-DD` as day and month in the app's language. */
export function nightDay(iso: string, locale: Locale): string {
  const [year, month, day] = iso.split('-').map(Number)
  return new Intl.DateTimeFormat(intlLocale(locale), { day: '2-digit', month: '2-digit' }).format(
    new Date(year, month - 1, day),
  )
}
