import { describe, expect, it } from 'vitest'
import type { VPAInfo } from '@/services/api'
import { applyVPAWatchEvent, normalizeWatchVPAObject } from './vpaWatchNormalize'

describe('VPA rows', () => {
  it('Provided is the RecommendationProvided condition, not the first one', () => {
    const raw = (conditions: unknown[]) => ({
      metadata: { name: 'web', namespace: 'shop' },
      spec: { targetRef: { kind: 'Deployment', name: 'web' } },
      status: { conditions },
    })
    expect(normalizeWatchVPAObject(raw([{ type: 'LowConfidence', status: 'True' }, { type: 'RecommendationProvided', status: 'False' }])).provided).toBe('False')
    expect(normalizeWatchVPAObject(raw([{ type: 'LowConfidence', status: 'True' }])).provided).toBe('')
  })

  it('a live update replaces the row: a recommendation or condition that went shows empty', () => {
    const before = { name: 'web', namespace: 'shop', update_mode: 'Off', cpu_target: '25m', memory_target: '64Mi', provided: 'True', created_at: '' } as VPAInfo
    const [after] = applyVPAWatchEvent([before], { type: 'MODIFIED', object: { ...before, cpu_target: '', memory_target: '', provided: '' } })
    expect(after.cpu_target).toBe('')
    expect(after.provided).toBe('')
  })
})
