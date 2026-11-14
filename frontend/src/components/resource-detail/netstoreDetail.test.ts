import { describe, expect, it } from 'vitest'
import type { EndpointInfo } from '@/services/api'
import { endpointToRawJson } from '@/pages/network/endpoints/endpointHelpers'
import { allowedTopologyLines, endpointsView, ingressClassRows, replicaSetOwnerRow, volumeAttachmentState } from './netstoreDetail'
import ingressDetailSrc from './network-info/IngressDetail.tsx?raw'

// k8s-service DescribeEndpoints: the list's row, the object's metadata, every subset and the events
const describeAnswer = {
  name: 'hand', namespace: 'ns', ready_count: 2, not_ready_count: 2,
  ready_addresses: ['10.0.0.1', '10.0.1.1'], not_ready_addresses: ['10.0.0.2', '10.0.0.3'],
  ready_targets: [{ ip: '10.0.0.1', node_name: 'n1', target_ref: { kind: 'Pod', name: 'p' } }, { ip: '10.0.1.1' }],
  not_ready_targets: [{ ip: '10.0.0.2' }, { ip: '10.0.0.3' }],
  ports: [{ name: '', port: 7070, protocol: 'TCP' }, { name: 'dns', port: 53, protocol: 'UDP' }],
  subsets: [
    { addresses: [{ ip: '10.0.0.1' }], not_ready_addresses: [{ ip: '10.0.0.2' }, { ip: '10.0.0.3' }], ports: [{ name: '', port: 7070, protocol: 'TCP' }] },
    { addresses: [{ ip: '10.0.1.1' }], not_ready_addresses: [], ports: [{ name: 'dns', port: 53, protocol: 'UDP' }] },
  ],
  uid: 'u-1', resource_version: '42', generation: 0, labels: { team: 'numbers' }, annotations: {},
  created_at: '2026-11-04T00:00:00Z', events: [{ reason: 'Seen' }],
}

describe('Endpoints drawer', () => {
  it('reads the describe answer: every subset with its not-ready addresses, the events, no generation', () => {
    const v = endpointsView(describeAnswer, undefined)!
    expect([v.ready_count, v.not_ready_count]).toEqual([2, 2])
    expect(v.subsets).toEqual([
      { addresses: ['10.0.0.1'], not_ready_addresses: ['10.0.0.2', '10.0.0.3'], ports: [{ name: '', port: 7070, protocol: 'TCP' }] },
      { addresses: ['10.0.1.1'], not_ready_addresses: [], ports: [{ name: 'dns', port: 53, protocol: 'UDP' }] },
    ])
    expect([v.uid, v.resource_version, v.generation, v.labels, v.events.length]).toEqual(['u-1', '42', undefined, { team: 'numbers' }, 1])
  })

  it('opened from the list, the row until describe answers — its one subset keeps the not-ready addresses', () => {
    const row = { ...describeAnswer, subsets: undefined } as unknown as EndpointInfo
    const v = endpointsView(undefined, endpointToRawJson(row))!
    expect([v.ready_count, v.not_ready_count]).toEqual([2, 2])
    expect(v.subsets.map((s) => s.not_ready_addresses)).toEqual([['10.0.0.2', '10.0.0.3']])
  })

  it('opened by link, nothing from the object (it has no counts) until describe answers', () => {
    const object = { apiVersion: 'v1', kind: 'Endpoints', metadata: { name: 'hand' }, subsets: [{ addresses: [{ ip: '10.0.0.1' }] }] }
    expect(endpointsView(undefined, object)).toBeNull()
    expect(endpointsView(describeAnswer, object)!.ready_count).toBe(2)
  })
})

describe('ReplicaSet drawer Owner', () => {
  it('is the controller reference as the list shows it: a Deployment by name, another kind as kind/name', () => {
    expect(replicaSetOwnerRow({ owner_references: [{ kind: 'Deployment', name: 'web', controller: true }] })).toBe('web')
    expect(replicaSetOwnerRow({ owner_deployment: '', owner_references: [{ kind: 'Rollout', name: 'web', controller: true }] })).toBe('Rollout/web')
    expect(replicaSetOwnerRow({ owner_references: [{ kind: 'ConfigMap', name: 'keep', controller: false }, { kind: 'Rollout', name: 'web', controller: true }] })).toBe('Rollout/web')
    expect(replicaSetOwnerRow({ owner_references: [] })).toBeNull()
    expect(replicaSetOwnerRow(undefined)).toBeNull()
  })
})

describe('StorageClass drawer Allowed Topologies', () => {
  it('is a line per term, kubectl describe\'s "key in [values]"', () => {
    expect(allowedTopologyLines([
      { match_label_expressions: [{ key: 'topology.kubernetes.io/zone', values: ['zone-a', 'zone-b'] }, { key: 'kubernetes.io/hostname', values: ['node-1'] }] },
      { match_label_expressions: [{ key: 'topology.kubernetes.io/region', values: ['r1'] }] },
    ])).toEqual([
      'Term 0: topology.kubernetes.io/zone in [zone-a, zone-b], kubernetes.io/hostname in [node-1]',
      'Term 1: topology.kubernetes.io/region in [r1]',
    ])
    expect(allowedTopologyLines(undefined)).toEqual([])
  })
})

describe('VolumeAttachment drawer Status', () => {
  it('is the list\'s (an error first), with kubectl\'s ATTACHED beside it', () => {
    const err = { message: 'attach timed out', time: '2026-11-04T00:00:00Z' }
    expect(volumeAttachmentState({ attached: true, attach_error: err })).toEqual({ status: 'Error', attached: 'Yes' })
    expect(volumeAttachmentState({ attached: false, detach_error: err })).toEqual({ status: 'Error', attached: 'No' })
    expect(volumeAttachmentState({ attached: true })).toEqual({ status: 'Attached', attached: 'Yes' })
    expect(volumeAttachmentState({ attached: false })).toEqual({ status: 'Detached', attached: 'No' })
    expect(volumeAttachmentState({ attached: null })).toEqual({ status: 'Unknown', attached: '-' })
  })
})

describe('Ingress drawer class rows', () => {
  // the list's row (ingressrow.Info) and what DescribeIngress adds from the IngressClass the Ingress names
  const row = { name: 'web', namespace: 'shop', class: 'nginx', class_source: 'spec' }
  const answer = { ...row, class_controller: 'k8s.io/ingress-nginx', class_is_default: true }

  it('say the class\'s controller and default from the answer, which the list\'s row does not have', () => {
    expect(ingressClassRows(answer, row)).toEqual({ source: 'spec', controller: 'k8s.io/ingress-nginx', isDefault: 'Yes' })
    expect(ingressClassRows({ ...answer, class_is_default: false }, row).isDefault).toBe('No')
  })

  // The drawer reads its answer again when the Ingress changes: a class set by annotation since it opened is the answer's.
  it('follow the answer, not the row the drawer opened with', () => {
    const moved = { ...row, class: 'traefik', class_source: 'annotation' }
    expect(ingressClassRows(moved, row)).toEqual({ source: 'annotation', controller: '-', isDefault: '-' })
  })

  it('are the row\'s while no answer has come, and "-" for what neither says', () => {
    expect(ingressClassRows(undefined, row)).toEqual({ source: 'spec', controller: '-', isDefault: '-' })
    expect(ingressClassRows({ ...row, class: '', class_source: '' }, row).source).toBe('-')
  })

  it('are what the drawer draws', () => {
    expect(ingressDetailSrc).toContain('ingressClassRows(describe, rawJson)')
    expect(ingressDetailSrc).not.toContain('rawJson?.class_controller')
  })
})
