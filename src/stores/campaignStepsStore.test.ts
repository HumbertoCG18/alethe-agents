import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { useCampaignStepsStore, useCampaignStepTitle } from './campaignStepsStore'

beforeEach(() => useCampaignStepsStore.setState({ byProject: {} }))

describe('campaign step titles', () => {
  it('reads only what was published, never an inherited name', () => {
    useCampaignStepsStore.getState().publish('p1', { MOTOR: 'MOTOR-08 2/5' })
    const title = (projectId: string, campaignId: string) =>
      renderHook(() => useCampaignStepTitle(projectId, campaignId)).result.current
    expect(title('p1', 'MOTOR')).toBe('MOTOR-08 2/5')
    expect(title('p1', 'toString')).toBeNull()
    expect(title('constructor', 'MOTOR')).toBeNull()
  })
})
