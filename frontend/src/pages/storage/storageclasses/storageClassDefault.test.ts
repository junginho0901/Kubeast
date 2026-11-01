import { describe, expect, it } from 'vitest'
import type { StorageClassInfo } from '@/services/api'
import { markEffectiveDefault } from './storageClassHelpers'
import { applyStorageClassWatchEvent } from './storageClassWatchNormalize'

const sc = (name: string, isDefault: boolean, createdAt: string): StorageClassInfo =>
  ({ name, provisioner: 'example.com/disk', is_default: isDefault, created_at: createdAt }) as StorageClassInfo

describe('StorageClass default', () => {
  it('marks the newest class with a default annotation alone, as kubectl get prints "(default)"', () => {
    const rows = markEffectiveDefault([
      sc('old', true, '2026-10-01T00:00:00Z'),
      sc('new', true, '2026-10-02T00:00:00Z'),
      sc('plain', false, '2026-10-03T00:00:00Z'),
    ])!
    expect(rows.map((r) => [r.name, r.is_default])).toEqual([['old', false], ['new', true], ['plain', false]])
  })

  it('at the same time, the first name', () => {
    const rows = markEffectiveDefault([sc('b', true, '2026-10-01T00:00:00Z'), sc('a', true, '2026-10-01T00:00:00Z')])!
    expect(rows.filter((r) => r.is_default).map((r) => r.name)).toEqual(['a'])
  })

  it('reads the beta annotation from a raw object, and a live update replaces the row', () => {
    const prev = [{ ...sc('fast', false, '2026-10-01T00:00:00Z'), mount_options: ['debug'] }]
    const next = applyStorageClassWatchEvent(prev, {
      type: 'MODIFIED',
      object: {
        metadata: { name: 'fast', creationTimestamp: '2026-10-01T00:00:00Z', annotations: { 'storageclass.beta.kubernetes.io/is-default-class': 'true' } },
        provisioner: 'example.com/disk',
      },
    })
    expect(next[0].is_default).toBe(true)
    expect(next[0].mount_options).toEqual([])
  })
})
