import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatAddresses, formatBackends, formatHosts, formatRules, ingressToRawJson } from '@/pages/network/ingresses/ingressHelpers'
import { applyIngressWatchEvent, normalizeWatchIngressObject } from '@/pages/network/ingresses/ingressWatchNormalize'
import { errorText, statusLabel, volumeAttachmentToRawJson } from '@/pages/storage/volumeattachments/volumeAttachmentHelpers'
import { applyVolumeAttachmentWatchEvent, normalizeWatchVolumeAttachmentObject } from '@/pages/storage/volumeattachments/volumeAttachmentWatchNormalize'
import { cronJobToWorkloadRawJson, nextRunOf } from '@/pages/workloads/cronjobs/cronJobHelpers'
import { applyCronJobWatchEvent, normalizeWatchCronJobObject } from '@/pages/workloads/cronjobs/cronJobWatchNormalize'
import { peerOf, peerText, portOf, portsText, type Tr } from '@/components/resource-detail/netpolText'
import { endpointToRawJson, formatAddresses as formatEndpointAddresses, formatPorts as formatEndpointPorts } from '@/pages/network/endpoints/endpointHelpers'
import { applyEndpointWatchEvent, normalizeWatchEndpointObject } from '@/pages/network/endpoints/endpointWatchNormalize'
import { formatParameters, ingressClassToRawJson } from '@/pages/network/ingressclasses/ingressClassHelpers'
import { applyIngressClassWatchEvent, normalizeWatchIngressClassObject } from '@/pages/network/ingressclasses/ingressClassWatchNormalize'
import { formatDefaultDeny, formatPolicyTypes, formatSelector as formatPodSelector, networkPolicyToRawJson } from '@/pages/network/networkpolicies/networkPolicyHelpers'
import { applyNetworkPolicyWatchEvent, normalizeWatchNetworkPolicyObject } from '@/pages/network/networkpolicies/networkPolicyWatchNormalize'
import { formatPorts as formatServicePorts, formatSelector, serviceToRawJson } from '@/pages/network/services/serviceHelpers'
import { applyServiceWatchEvent, normalizeWatchServiceObject } from '@/pages/network/services/serviceWatchNormalize'
import { claimToText, pvToRawJson } from '@/pages/storage/pvs/pvHelpers'
import { applyPvWatchEvent, normalizeWatchPvObject } from '@/pages/storage/pvs/pvWatchNormalize'
import cases from './watchRows.cases.json'

// the English fallback with its values, as the screen writes it with no catalog in the way
const tr: Tr = (_key, fallback, options) => fallback.replace(/{{(\w+)}}/g, (_all, name) => String(options?.[name] ?? ''))

type Page = {
  apply: (prev: any[], event: { type?: string; object?: any }) => any[]
  normalize: (obj: any) => any
  // what the list page reads off a row, in the terms the server's case writes by hand
  shows: (row: any) => Record<string, unknown>
  // what else the page derives from the row: the drawer's object and, for a CronJob, the next run
  derives: (row: any) => unknown
}

const pages: Record<string, Page> = {
  ingresses: {
    apply: applyIngressWatchEvent,
    normalize: normalizeWatchIngressObject,
    shows: (row) => ({
      class: row.class || '-',
      hosts: formatHosts(row),
      backends: formatBackends(row),
      addresses: formatAddresses(row),
      rules: formatRules(row),
      tls: (row.tls || []).length,
    }),
    derives: ingressToRawJson,
  },
  volumeattachments: {
    apply: applyVolumeAttachmentWatchEvent,
    normalize: normalizeWatchVolumeAttachmentObject,
    shows: (row) => ({ attached: row.attached, status: statusLabel(row), error: errorText(row) }),
    derives: volumeAttachmentToRawJson,
  },
  cronjobs: {
    apply: applyCronJobWatchEvent,
    normalize: normalizeWatchCronJobObject,
    shows: (row) => ({
      schedule: row.schedule,
      suspend: row.suspend,
      active: row.active,
      concurrency_policy: row.concurrency_policy ?? null,
      last_schedule_time: row.last_schedule_time ?? null,
      last_successful_time: row.last_successful_time ?? null,
      time_zone: row.time_zone ?? null,
      containers: (row.containers || []).join(', ') || '-',
      images: (row.images || []).join(', ') || '-',
    }),
    derives: (row) => ({ next_run: nextRunOf(row)?.toISOString() ?? null, raw: cronJobToWorkloadRawJson(row) }),
  },
  services: {
    apply: applyServiceWatchEvent,
    normalize: normalizeWatchServiceObject,
    shows: (row) => ({
      type: row.type || '-',
      cluster_ip: row.cluster_ip || '-',
      external_ip: row.external_ip || '-',
      ports: formatServicePorts(row.ports),
      selector: formatSelector(row.selector),
    }),
    derives: serviceToRawJson,
  },
  endpoints: {
    apply: applyEndpointWatchEvent,
    normalize: normalizeWatchEndpointObject,
    shows: (row) => ({
      ready: row.ready_count || 0,
      not_ready: row.not_ready_count || 0,
      addresses: formatEndpointAddresses(row),
      ports: formatEndpointPorts(row.ports),
    }),
    derives: endpointToRawJson,
  },
  ingressclasses: {
    apply: applyIngressClassWatchEvent,
    normalize: normalizeWatchIngressClassObject,
    shows: (row) => ({
      controller: row.controller || '-',
      default: Boolean(row.is_default),
      parameters: formatParameters(row),
      labels: row.labels || {},
    }),
    derives: ingressClassToRawJson,
  },
  networkpolicies: {
    apply: applyNetworkPolicyWatchEvent,
    normalize: normalizeWatchNetworkPolicyObject,
    shows: (row) => {
      // what the drawer opened from this row words, peers and ports of each rule, labels and annotations
      const object = networkPolicyToRawJson(row) as any
      const line = (peers: any[], ports: any[]) => `${peers.map((p) => peerText(peerOf(p), tr)).join(' ; ')} | ${portsText(ports.map(portOf), tr)}`
      return {
        pod_selector: formatPodSelector(row),
        types: formatPolicyTypes(row),
        ingress_rules: row.ingress_rules || 0,
        egress_rules: row.egress_rules || 0,
        default_deny: formatDefaultDeny(row),
        ingress: object.spec.ingress.map((r: any) => line(r.from, r.ports)),
        egress: object.spec.egress.map((r: any) => line(r.to, r.ports)),
        labels: object.metadata.labels,
        annotations: object.metadata.annotations,
      }
    },
    derives: networkPolicyToRawJson,
  },
  persistentvolumes: {
    apply: applyPvWatchEvent,
    normalize: normalizeWatchPvObject,
    shows: (row) => ({
      status: row.status || '-',
      storage_class: row.storage_class || '-',
      capacity: row.capacity || '-',
      access_modes: (row.access_modes || []).join(', ') || '-',
      reclaim_policy: row.reclaim_policy || '-',
      claim: claimToText(row.claim_ref),
      volume_mode: row.volume_mode || '-',
      source: row.source || row.driver || '-',
      reason: row.reason || '-',
      message: row.message || '-',
    }),
    derives: pvToRawJson,
  },
}

// k8s-service's TestWatchRowCasesFixture writes these: one object through the real list code and the real live update
// code, and what the page should show.
describe('a live update leaves a row as the list API gives it', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-06T12:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('the server wrote cases for every list these tests name', () => {
    expect(new Set(cases.map((c) => c.resource))).toEqual(new Set(Object.keys(pages)))
    expect(cases.length).toBeGreaterThanOrEqual(26)
  })

  for (const c of cases) {
    it(c.name, () => {
      const page = pages[c.resource]
      const [row] = page.apply([c.before], { type: 'MODIFIED', object: c.event })
      expect(page.shows(row)).toEqual(c.shows)
      expect(page.shows(c.after)).toEqual(c.shows)
      expect(page.derives(row)).toEqual(page.derives(c.after))
      expect(row).toEqual(page.normalize(c.after))
    })
  }
})

describe('a live update of a row', () => {
  for (const c of cases) {
    it(`goes when the object is deleted: ${c.name}`, () => {
      expect(pages[c.resource].apply([c.before], { type: 'DELETED', object: c.event })).toEqual([])
    })

    it(`stays in its place and leaves the other rows as they were: ${c.name}`, () => {
      const namespace = (c.before as { namespace?: string }).namespace
      const first = { name: 'first', namespace }
      const last = { name: 'last', namespace }
      const rows = pages[c.resource].apply([first, c.before, last], { type: 'MODIFIED', object: c.event })
      expect(rows.map((r) => r.name)).toEqual(['first', (c.before as { name: string }).name, 'last'])
      expect(rows[0]).toBe(first)
      expect(rows[2]).toBe(last)
    })
  }
})

describe('a row the server could not convert comes with its object nested', () => {
  it('a VolumeAttachment reads its state from status, not from the top of the row', () => {
    const nested = {
      name: 'disk-a',
      kind: 'VolumeAttachment',
      created_at: '2026-11-01T00:00:00Z',
      spec: { attacher: 'csi.example.test', nodeName: 'node-a', source: { persistentVolumeName: 'pv-a' } },
      status: { attached: true },
    }
    const prior = { name: 'disk-a', attached: false, attach_error: { message: 'attach failed' } }
    const [row] = applyVolumeAttachmentWatchEvent([prior], { type: 'MODIFIED', object: nested })
    expect(row).toEqual({
      name: 'disk-a',
      attacher: 'csi.example.test',
      node_name: 'node-a',
      persistent_volume_name: 'pv-a',
      attached: true,
      attach_error: null,
      detach_error: null,
      created_at: '2026-11-01T00:00:00Z',
    })
    expect(statusLabel(row)).toBe('Attached')
  })

  it('an Ingress keeps its name and namespace, so the row updates and a deleted one goes', () => {
    const nested = {
      name: 'web',
      namespace: 'demo',
      kind: 'Ingress',
      labels: { team: 'a' },
      created_at: '2026-11-01T00:00:00Z',
      spec: { rules: [{ host: 'example.test' }] },
      status: {},
    }
    const prior = { name: 'web', namespace: 'demo', hosts: ['old.example.test'], backends: [] }
    const [row] = applyIngressWatchEvent([prior], { type: 'MODIFIED', object: nested })
    expect(formatHosts(row)).toBe('example.test')
    expect(row.labels).toEqual({ team: 'a' })
    expect(row.created_at).toBe('2026-11-01T00:00:00Z')
    expect(applyIngressWatchEvent([prior], { type: 'DELETED', object: nested })).toEqual([])
  })

  it('a Service reads its object, so a port or selector that went away goes', () => {
    const nested = {
      name: 'web',
      namespace: 'demo',
      kind: 'Service',
      created_at: '2026-11-01T00:00:00Z',
      spec: { type: 'ClusterIP', clusterIP: '10.0.0.9' },
      status: {},
    }
    const prior = { name: 'web', namespace: 'demo', type: 'LoadBalancer', cluster_ip: '10.0.0.1', external_ip: '192.0.2.1', ports: [{ port: 80 }], selector: { app: 'web' } }
    const [row] = applyServiceWatchEvent([prior] as any, { type: 'MODIFIED', object: nested })
    expect(pages.services.shows(row)).toEqual({ type: 'ClusterIP', cluster_ip: '10.0.0.9', external_ip: '-', ports: '-', selector: '-' })
    expect(row.created_at).toBe('2026-11-01T00:00:00Z')
  })

  it('Endpoints read the subsets beside the metadata', () => {
    const nested = { name: 'web', namespace: 'demo', kind: 'Endpoints', created_at: '2026-11-01T00:00:00Z', subsets: [{ addresses: [{ ip: '10.0.0.3' }] }] }
    const prior = { name: 'web', namespace: 'demo', ready_count: 1, not_ready_count: 1, ready_addresses: ['10.0.0.1'], not_ready_addresses: ['10.0.0.2'], ports: [{ port: 80 }] }
    const [row] = applyEndpointWatchEvent([prior] as any, { type: 'MODIFIED', object: nested })
    expect(pages.endpoints.shows(row)).toEqual({ ready: 1, not_ready: 0, addresses: '10.0.0.3', ports: '-' })
    expect(applyEndpointWatchEvent([prior] as any, { type: 'DELETED', object: nested })).toEqual([])
  })

  it('an IngressClass keeps its name, so the row updates and a deleted one goes', () => {
    const nested = { name: 'nginx', kind: 'IngressClass', labels: { team: 'a' }, created_at: '2026-11-01T00:00:00Z', spec: { controller: 'example.test/new' } }
    const prior = { name: 'nginx', controller: 'example.test/old', is_default: false, parameters: { kind: 'Params' } }
    const [row] = applyIngressClassWatchEvent([prior] as any, { type: 'MODIFIED', object: nested })
    expect(pages.ingressclasses.shows(row)).toEqual({ controller: 'example.test/new', default: false, parameters: '-', labels: { team: 'a' } })
    expect(row.created_at).toBe('2026-11-01T00:00:00Z')
    expect(applyIngressClassWatchEvent([prior] as any, { type: 'DELETED', object: nested })).toEqual([])
  })

  it('a NetworkPolicy keeps the labels at the top of the row', () => {
    const nested = {
      name: 'web',
      namespace: 'demo',
      kind: 'NetworkPolicy',
      labels: { team: 'a' },
      created_at: '2026-11-01T00:00:00Z',
      spec: { podSelector: { matchLabels: { app: 'web' } }, policyTypes: ['Ingress'] },
    }
    const prior = { name: 'web', namespace: 'demo', pod_selector: {}, policy_types: [], ingress_rules: 1, ingress: [{ from: [], ports: [] }], labels: {} }
    const [row] = applyNetworkPolicyWatchEvent([prior] as any, { type: 'MODIFIED', object: nested })
    expect(row.labels).toEqual({ team: 'a' })
    expect(row.ingress_rules).toBe(0)
    expect(formatPodSelector(row)).toBe('app=web')
  })

  it('a PersistentVolume with no phase reads Unknown, not the status object', () => {
    const nested = { name: 'disk-a', kind: 'PersistentVolume', created_at: '2026-11-01T00:00:00Z', spec: { capacity: { storage: '1Gi' } }, status: { reason: 'Broken' } }
    const prior = { name: 'disk-a', status: 'Bound', capacity: '2Gi', access_modes: ['ReadWriteOnce'], claim_ref: { namespace: 'demo', name: 'claim-a' } }
    const [row] = applyPvWatchEvent([prior] as any, { type: 'MODIFIED', object: nested })
    expect(row.status).toBe('Unknown')
    expect(row.capacity).toBe('1Gi')
    expect(claimToText(row.claim_ref)).toBe('-')
  })
})
