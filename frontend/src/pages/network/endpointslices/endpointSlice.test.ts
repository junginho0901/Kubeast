import { describe, expect, it } from 'vitest'
import type { EndpointSliceInfo } from '@/services/api'
import { endpointSliceToRawJson, formatEndpointPreview } from './endpointSliceHelpers'
import { applyEndpointSliceWatchEvent, normalizeWatchEndpointSliceObject } from './endpointSliceWatchNormalize'

// a row as the list API and the live updates send it (endpointslice.Info)
const row = (over: Partial<EndpointSliceInfo> = {}): EndpointSliceInfo => ({
  name: 'web-abc',
  namespace: 'qa',
  service_name: 'web',
  address_type: 'IPv4',
  endpoints_total: 1,
  endpoints_ready: 1,
  endpoints_not_ready: 0,
  ports: [{ name: 'http', port: 8080, protocol: 'TCP', app_protocol: 'kubernetes.io/h2c' }],
  endpoints: [{
    addresses: ['10.0.0.1'],
    node_name: 'node-a',
    conditions: { ready: true },
    hints: { for_zones: ['zone-a'], for_nodes: ['node-a'] },
    target_ref: { kind: 'Pod', name: 'web-0', namespace: 'qa' },
  }],
  labels: { 'kubernetes.io/service-name': 'web', team: 'a' },
  annotations: { note: 'kept' },
  created_at: '2026-11-01T00:00:00Z',
  ...over,
})

describe('EndpointSlice rows', () => {
  it('the list row previews its addresses and hands the drawer its hints, ports and labels', () => {
    expect(formatEndpointPreview(row())).toBe('10.0.0.1')
    const raw = endpointSliceToRawJson(row()) as any
    expect(raw.endpoints[0].hints).toEqual({ for_zones: ['zone-a'], for_nodes: ['node-a'] })
    expect(raw.endpoints[0].targetRef).toEqual({ kind: 'Pod', name: 'web-0', namespace: 'qa' })
    expect(raw.ports[0].appProtocol).toBe('kubernetes.io/h2c')
    expect(raw.metadata.labels.team).toBe('a')
    expect(raw.metadata.annotations.note).toBe('kept')
  })

  it('a raw object is read into the row, its hints as names', () => {
    const got = normalizeWatchEndpointSliceObject({
      metadata: { name: 'web-abc', namespace: 'qa', labels: { 'kubernetes.io/service-name': 'web' }, creationTimestamp: '2026-11-01T00:00:00Z' },
      addressType: 'IPv4',
      endpoints: [{ addresses: ['10.0.0.1'], conditions: { ready: true }, hints: { forZones: [{ name: 'zone-a' }], forNodes: [{ name: 'node-a' }] } }],
      ports: [{ name: 'http', port: 8080, protocol: 'TCP', appProtocol: 'http' }],
    })
    expect(got.endpoints?.[0].hints).toEqual({ for_zones: ['zone-a'], for_nodes: ['node-a'] })
    expect(got.service_name).toBe('web')
    expect(got.ports[0].app_protocol).toBe('http')
  })

  it('a live update replaces the row: endpoints and labels that went away go from the screen', () => {
    const emptied = row({ endpoints_total: 0, endpoints_ready: 0, endpoints: [], labels: { 'kubernetes.io/service-name': 'web' } })
    const [got] = applyEndpointSliceWatchEvent([row()], { type: 'MODIFIED', object: emptied })
    expect(got.endpoints).toEqual([])
    expect(got.labels).toEqual({ 'kubernetes.io/service-name': 'web' })
    expect(formatEndpointPreview(got)).toBe('-')
  })
})
