import { describe, expect, it } from 'vitest'
import type { DeviceClassItem, ResourceClaimItem, ResourceClaimTemplateItem, ResourceSliceItem } from '@/services/api'
import { applyDeviceClassWatchEvent } from './device-classes/deviceClassesHelpers'
import { claimCards } from './resourceclaims/resourceClaimsHelpers'
import { applyResourceClaimWatchEvent } from './resourceclaims/resourceClaimsWatchNormalize'
import { applyResourceClaimTemplateWatchEvent } from './resourceclaimtemplates/resourceClaimTemplatesWatchNormalize'
import { applyResourceSliceWatchEvent } from './resourceslices/resourceSlicesWatch'

// The server sends a DRA object's whole list row (k8s-service internal/drarow) as its live update, so the row is
// replaced: a claim whose devices were released reads pending, not the allocation merged from before.
describe('DRA rows on a live update', () => {
  it('a released claim reads pending', () => {
    const before: ResourceClaimItem = { name: 'c', namespace: 'ml', request_count: 1, state: 'allocated,reserved', labels: {} }
    const [row] = applyResourceClaimWatchEvent([before], { type: 'MODIFIED', object: { ...before, state: 'pending' } })
    expect(row).toEqual({ ...before, state: 'pending' })
  })

  it('a slice, a class and a template are replaced, added and removed', () => {
    const slice: ResourceSliceItem = { name: 's', node_name: 'n1', driver_name: 'gpu.example.com', pool_name: 'n1', device_count: 8, all_nodes: false }
    expect(applyResourceSliceWatchEvent([slice], { type: 'MODIFIED', object: { ...slice, node_name: '', all_nodes: true, device_count: 0 } }))
      .toEqual([{ ...slice, node_name: '', all_nodes: true, device_count: 0 }])
    const cls: DeviceClassItem = { name: 'gpu.example.com', selector_count: 2, labels: { team: 'ml' } }
    expect(applyDeviceClassWatchEvent([cls], { type: 'MODIFIED', object: { ...cls, labels: {}, selector_count: 0 } }))
      .toEqual([{ ...cls, labels: {}, selector_count: 0 }])
    const tmpl: ResourceClaimTemplateItem = { name: 't', namespace: 'ml', request_count: 2 }
    const other: ResourceClaimTemplateItem = { name: 't', namespace: 'other', request_count: 1 }
    expect(applyResourceClaimTemplateWatchEvent([tmpl], { type: 'ADDED', object: other })).toEqual([tmpl, other])
    expect(applyResourceClaimTemplateWatchEvent([tmpl, other], { type: 'DELETED', object: tmpl })).toEqual([other])
  })
})

// The cards count kubectl's STATE words: a claim in use is Allocated and Reserved, one being deleted is not Pending.
describe('ResourceClaims cards', () => {
  it('count the words of kubectl STATE', () => {
    const c = (name: string, state: string): ResourceClaimItem => ({ name, namespace: 'ml', state })
    const items = [c('a', 'pending'), c('b', 'allocated'), c('c', 'allocated,reserved'), c('d', 'deleted,allocated,reserved'), c('e', 'deleted')]
    expect(claimCards(items)).toEqual({ total: 5, allocated: 3, reserved: 2, pending: 1 })
  })
})
