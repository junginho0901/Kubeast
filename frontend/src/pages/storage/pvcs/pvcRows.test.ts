import { describe, expect, it } from 'vitest'
import type { PVCInfo } from '@/services/api'
import { pvcToRawJson } from './pvcHelpers'
import { applyPvcWatchEvent, normalizeWatchPvcObject } from './pvcWatchNormalize'

const raw = (volumeName?: string) => ({
  metadata: { name: 'data', namespace: 'qa', creationTimestamp: '2026-11-01T00:00:00Z' },
  spec: { accessModes: ['ReadWriteOnce', 'ReadOnlyMany'], volumeName, resources: { requests: { storage: '1Gi' } } },
  status: volumeName ? { phase: 'Bound', accessModes: ['ReadWriteOnce'], capacity: { storage: '2Gi' } } : { phase: 'Pending' },
})

describe('PersistentVolumeClaim rows', () => {
  it('a claim not bound has no access modes or capacity yet; what it asks for is kept apart, as kubectl prints it', () => {
    const pending = normalizeWatchPvcObject(raw())
    expect(pending.access_modes).toEqual([])
    expect(pending.capacity).toBeNull()
    expect(pending.requested_access_modes).toEqual(['ReadWriteOnce', 'ReadOnlyMany'])
    const bound = normalizeWatchPvcObject(raw('pv-1'))
    expect(bound.access_modes).toEqual(['ReadWriteOnce'])
    expect(bound.capacity).toBe('2Gi')
  })

  it('the row handed to the drawer keeps the granted modes in status and the requested ones in spec', () => {
    const row: PVCInfo = { name: 'data', namespace: 'qa', status: 'Bound', access_modes: ['ReadWriteOnce'], requested_access_modes: ['ReadWriteOnce', 'ReadOnlyMany'], created_at: '' }
    const json = pvcToRawJson(row) as any
    expect(json.status.accessModes).toEqual(['ReadWriteOnce'])
    expect(json.spec.accessModes).toEqual(['ReadWriteOnce', 'ReadOnlyMany'])
  })

  it('a live update replaces the row', () => {
    const before: PVCInfo = { name: 'data', namespace: 'qa', status: 'Bound', capacity: '2Gi', access_modes: ['ReadWriteOnce'], created_at: '' }
    const [after] = applyPvcWatchEvent([before], { type: 'MODIFIED', object: { ...before, status: 'Lost', capacity: '', access_modes: [] } })
    expect(after.access_modes).toEqual([])
    expect(after.capacity).toBe('')
  })
})
