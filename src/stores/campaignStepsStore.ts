import { create } from 'zustand'

/**
 * Where each campaign is by its steps, as "TASK done/total", by project id then campaign id. The
 * Todo plugin publishes it from the active project's registry; the terminal titles, which have no
 * registry of their own, read it.
 */
type CampaignStepsState = {
  byProject: Record<string, Readonly<Record<string, string>>>
  /** Sets a project's titles; none, or null once its registry is gone, removes its entry. */
  publish: (projectId: string, titles: Record<string, string> | null) => void
}

export const useCampaignStepsStore = create<CampaignStepsState>((set, get) => ({
  byProject: {},
  publish: (projectId, titles) => {
    const { [projectId]: previous, ...others } = get().byProject
    const next = titles && Object.keys(titles).length > 0 ? titles : null
    if (JSON.stringify(previous ?? null) === JSON.stringify(next)) return
    set({ byProject: next ? { ...others, [projectId]: next } : others })
  },
}))

// Ids come from the registry: a campaign named "toString" must not read the prototype's.
const own = <T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined =>
  record && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined

/** The step title of a campaign tab of `projectId`; null for a tab with none. */
export const useCampaignStepTitle = (projectId: string, campaignId: string | undefined) =>
  useCampaignStepsStore((state) =>
    campaignId ? (own(own(state.byProject, projectId), campaignId) ?? null) : null,
  )
