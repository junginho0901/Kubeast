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
import { classifyDeploymentStatus, deploymentToWorkloadRawJson, getDeploymentStatusColor } from '@/pages/workloads/deployments/deploymentHelpers'
import { applyDeploymentWatchEvent, normalizeWatchDeploymentObject } from '@/pages/workloads/deployments/deploymentWatchNormalize'
import { replicaSetOwner, replicaSetToWorkloadRawJson } from '@/pages/workloads/replicasets/replicaSetHelpers'
import { applyReplicaSetWatchEvent, normalizeWatchReplicaSetObject } from '@/pages/workloads/replicasets/replicaSetWatchNormalize'
import { hasCurrentMetric, hpaToRawJson } from '@/pages/workloads/hpas/hpaHelpers'
import { applyHPAWatchEvent, normalizeWatchHPAObject } from '@/pages/workloads/hpas/hpaWatchNormalize'
import { applyConfigMapWatchEvent, normalizeWatchConfigMapObject } from '@/pages/configuration/configmaps/configMapWatchNormalize'
import { applySecretWatchEvent, normalizeWatchSecretObject } from '@/pages/configuration/secrets/secretWatchNormalize'
import { applyServiceAccountWatchEvent, normalizeWatchServiceAccountObject } from '@/pages/security/serviceaccounts/serviceAccountWatchNormalize'
import { applyRoleWatchEvent, normalizeWatchRoleObject } from '@/pages/security/roles/roleWatchNormalize'
import { workloadStatusTitle } from '@/utils/workloadStatus'
import secretInfoSrc from '@/components/resource-detail/SecretInfo.tsx?raw'
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
        finalizers: object.metadata.finalizers,
      }
    },
    derives: networkPolicyToRawJson,
  },
  deployments: {
    apply: applyDeploymentWatchEvent,
    normalize: normalizeWatchDeploymentObject,
    shows: (row) => ({
      ready: `${row.ready_replicas}/${row.replicas}`,
      updated: row.updated_replicas ?? 0,
      available: row.available_replicas ?? 0,
      status: row.status,
      title: workloadStatusTitle(row.status, row.progressing_reason),
      badge: getDeploymentStatusColor(row.status, row),
      bucket: classifyDeploymentStatus(row.status, row),
      image: row.image || '-',
      labels: row.labels || {},
    }),
    derives: deploymentToWorkloadRawJson,
  },
  replicasets: {
    apply: applyReplicaSetWatchEvent,
    normalize: normalizeWatchReplicaSetObject,
    shows: (row) => ({
      current: row.current_replicas ?? 0,
      desired: row.replicas ?? 0,
      ready: row.ready_replicas ?? 0,
      available: row.available_replicas ?? 0,
      status: row.status,
      containers: (row.containers || []).join(', ') || '-',
      images: (row.images || [row.image]).filter(Boolean).join(', ') || '-',
      selector: Object.entries(row.selector || {}).map(([k, v]) => `${k}=${v}`).join(', ') || '-',
      owner: replicaSetOwner(row),
    }),
    derives: replicaSetToWorkloadRawJson,
  },
  horizontalpodautoscalers: {
    apply: applyHPAWatchEvent,
    normalize: normalizeWatchHPAObject,
    shows: (row) => ({
      reference: row.target_ref || '-',
      min: row.min_replicas ?? '-',
      max: row.max_replicas,
      replicas: `${row.current_replicas ?? 0}/${hasCurrentMetric(row) ? (row.desired_replicas ?? 0) : '-'}`,
      scaling_active: Boolean(row.scaling_active),
      last_scale_time: row.last_scale_time ?? null,
      metrics: (row.metrics || []).map((m: any) => {
        const target = m.target_average_utilization ?? m.target_average_value ?? m.target_value ?? '-'
        const read = m.current?.current_average_utilization ?? m.current?.current_average_value ?? m.current?.current_value ?? '-'
        return `${m.type} ${m.resource_name ?? m.metric_name ?? '-'} ${target} ${read}`
      }),
      labels: row.labels || {},
    }),
    derives: hpaToRawJson,
  },
  configmaps: {
    apply: applyConfigMapWatchEvent,
    normalize: normalizeWatchConfigMapObject,
    shows: (row) => ({
      data_count: row.data_count,
      data_keys: row.data_keys ?? [],
      binary_keys: row.binary_keys ?? [],
      labels: row.labels || {},
    }),
    derives: (row) => row,
  },
  secrets: {
    apply: applySecretWatchEvent,
    normalize: normalizeWatchSecretObject,
    shows: (row) => ({
      type: row.type,
      data_count: row.data_count,
      data_keys: row.data_keys ?? [],
      labels: row.labels || {},
    }),
    derives: (row) => row,
  },
  serviceaccounts: {
    apply: applyServiceAccountWatchEvent,
    normalize: normalizeWatchServiceAccountObject,
    shows: (row) => ({
      secrets: row.secrets,
      secrets_list: row.secrets_list ?? [],
      image_pull_secrets: row.image_pull_secrets ?? [],
      // what the "With Image Pull Secrets" card counts
      with_pull_secrets: (row.image_pull_secrets?.length ?? 0) > 0,
      labels: row.labels || {},
      annotations: row.annotations || {},
    }),
    derives: (row) => row,
  },
  roles: {
    apply: applyRoleWatchEvent,
    normalize: normalizeWatchRoleObject,
    shows: (row) => ({
      rules_count: row.rules_count,
      labels: row.labels || {},
      annotations: row.annotations || {},
    }),
    derives: (row) => row,
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
    expect(cases.length).toBeGreaterThanOrEqual(46)
  })

  // the server's TestALiveOrListRowOfASecretOrConfigMapHoldsNoValue holds the rows; this holds the file the page's tests read
  it('no case holds a value of a Secret or a ConfigMap', () => {
    const text = JSON.stringify(cases)
    for (const value of ['fake-secret-value-for-tests', 'ZmFrZS1zZWNyZXQtdmFsdWUtZm9yLXRlc3Rz', 'fake-config-value-for-tests']) {
      expect(text).not.toContain(value)
    }
    expect(cases.filter((c) => c.resource === 'secrets').length).toBeGreaterThan(0)
  })

  it("a Secret drawer's Used By ServiceAccounts follows the list's rows, which carry the names at their top", () => {
    expect(secretInfoSrc).toContain('applyServiceAccountWatchEvent(prev as ServiceAccountInfo[] | undefined, event)')
    const frame = { name: 'runner', namespace: 'demo', secrets: 0, secrets_list: [], image_pull_secrets: ['registry'], labels: null, annotations: null, created_at: '' }
    expect(applyServiceAccountWatchEvent([], { type: 'ADDED', object: frame })).toEqual([frame])
    expect(applyServiceAccountWatchEvent([frame], { type: 'DELETED', object: frame })).toEqual([])
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

  // the words of internal/deploystatus, so a row does not change its word when one update comes this way
  it('a Deployment reads its status by the rule of the list, past its progress deadline Failed with the reason', () => {
    const condition = (type: string, status: string, reason: string) => ({ type, status, reason })
    const nested = (conditions: unknown[]) => ({
      name: 'web',
      namespace: 'demo',
      kind: 'Deployment',
      labels: { team: 'a' },
      created_at: '2026-11-01T00:00:00Z',
      spec: { replicas: 2, selector: { matchLabels: { app: 'web' } }, template: { spec: { containers: [{ name: 'app', image: 'example.test/app:2' }, { name: 'side', image: 'example.test/side:1' }] } } },
      status: { readyReplicas: 2, availableReplicas: 2, updatedReplicas: 1, unavailableReplicas: 1, conditions },
    })
    const prior = { name: 'web', namespace: 'demo', replicas: 1, status: 'Available', progressing_reason: '', image: 'example.test/app:1', labels: {} }
    for (const [conditions, status, reason] of [
      [[condition('Available', 'True', 'MinimumReplicasAvailable'), condition('Progressing', 'False', 'ProgressDeadlineExceeded')], 'Failed', 'ProgressDeadlineExceeded'],
      [[condition('Progressing', 'False', 'ProgressDeadlineExceeded'), condition('Available', 'True', 'MinimumReplicasAvailable')], 'Failed', 'ProgressDeadlineExceeded'],
      [[condition('Available', 'True', 'MinimumReplicasAvailable'), condition('Progressing', 'True', 'ReplicaSetUpdated')], 'Available', ''],
      [[condition('Available', 'False', 'MinimumReplicasUnavailable'), condition('Progressing', 'True', 'ReplicaSetUpdated')], 'Progressing', ''],
      [[], 'Progressing', ''],
    ] as const) {
      const [row] = applyDeploymentWatchEvent([prior] as any, { type: 'MODIFIED', object: nested([...conditions]) })
      expect(row).toMatchObject({ status, progressing_reason: reason, replicas: 2, image: 'example.test/app:2', images: ['example.test/app:2', 'example.test/side:1'], unavailable_replicas: 1, labels: { team: 'a' } })
    }
    expect(applyDeploymentWatchEvent([prior] as any, { type: 'DELETED', object: nested([]) })).toEqual([])
  })

  it('a ReplicaSet keeps its owner and reads its status by the rule of the list', () => {
    const nested = (status: Record<string, number>, owner = true) => ({
      name: 'web-1',
      namespace: 'demo',
      kind: 'ReplicaSet',
      created_at: '2026-11-01T00:00:00Z',
      ...(owner ? { owner_references: [{ kind: 'Deployment', name: 'web', uid: 'u-1', controller: true }] } : {}),
      spec: { replicas: 2, template: { spec: { containers: [{ name: 'app', image: 'example.test/app:1' }] } } },
      status,
    })
    const prior = { name: 'web-1', namespace: 'demo', replicas: 1, owner_deployment: 'other', owner_references: [{ kind: 'Deployment', name: 'other' }], status: 'Healthy' }
    const apply = (object: unknown) => applyReplicaSetWatchEvent([prior] as any, { type: 'MODIFIED', object })[0]
    expect(apply(nested({ readyReplicas: 2, availableReplicas: 2 }))).toMatchObject({ status: 'Healthy', owner_deployment: 'web' })
    expect(replicaSetOwner(apply(nested({ readyReplicas: 2, availableReplicas: 2 })))).toBe('web')
    // as the list's replicaStatus: ready without available is Unavailable, and available with too few ready Degraded
    expect(apply(nested({ readyReplicas: 1, availableReplicas: 0 })).status).toBe('Unavailable')
    expect(apply(nested({ readyReplicas: 1, availableReplicas: 1 })).status).toBe('Degraded')
    expect(apply({ ...nested({}), spec: { replicas: 0 } }).status).toBe('Idle')
    expect(replicaSetOwner(apply(nested({}, false)))).toBe('-')
  })

  it('an HPA keeps its name, target and labels, with no metric it cannot read', () => {
    const nested = {
      name: 'web',
      namespace: 'demo',
      kind: 'HorizontalPodAutoscaler',
      labels: { team: 'a' },
      created_at: '2026-11-01T00:00:00Z',
      spec: { scaleTargetRef: { kind: 'Deployment', name: 'web' }, minReplicas: 2, maxReplicas: 5 },
      status: { currentReplicas: 3, desiredReplicas: 4, conditions: [{ type: 'ScalingActive', status: 'True' }] },
    }
    const prior = { name: 'web', namespace: 'demo', max_replicas: 9, last_scale_time: '2026-11-05T00:00:00Z', metrics: [{ type: 'Pods' }], labels: {} }
    const [row] = applyHPAWatchEvent([prior] as any, { type: 'MODIFIED', object: nested })
    expect(pages.horizontalpodautoscalers.shows(row)).toEqual({
      reference: 'Deployment/web', min: 2, max: 5, replicas: '3/4', scaling_active: true, last_scale_time: null, metrics: [], labels: { team: 'a' },
    })
    expect(applyHPAWatchEvent([prior] as any, { type: 'DELETED', object: nested })).toEqual([])
  })

  it('a ConfigMap and a Secret keep the name and hold no value, whatever came', () => {
    const generic = { name: 'odd', namespace: 'demo', labels: { team: 'a' }, created_at: '2026-11-01T00:00:00Z' }
    const raw = { metadata: { name: 'odd', namespace: 'demo', annotations: { note: 'fake-secret-value-for-tests' } }, type: 'Opaque', data: { password: 'ZmFrZS1zZWNyZXQtdmFsdWUtZm9yLXRlc3Rz' } }
    const priorCm = { name: 'odd', namespace: 'demo', data_count: 2, data_keys: ['a', 'b'], binary_keys: ['c'], labels: {} }
    const [cm] = applyConfigMapWatchEvent([priorCm] as any, { type: 'MODIFIED', object: generic })
    expect(pages.configmaps.shows(cm)).toEqual({ data_count: 0, data_keys: [], binary_keys: [], labels: { team: 'a' } })
    expect(applyConfigMapWatchEvent([priorCm] as any, { type: 'DELETED', object: generic })).toEqual([])

    const priorSecret = { name: 'odd', namespace: 'demo', type: 'Opaque', data_count: 1, data_keys: ['a'], labels: {} }
    const [secret] = applySecretWatchEvent([priorSecret] as any, { type: 'MODIFIED', object: generic })
    expect(secret).toMatchObject({ name: 'odd', data_count: 0, data_keys: [], labels: { team: 'a' } })
    // the object as Kubernetes writes it: its key names only
    const [fromRaw] = applySecretWatchEvent([priorSecret] as any, { type: 'MODIFIED', object: raw })
    expect(fromRaw).toMatchObject({ type: 'Opaque', data_count: 1, data_keys: ['password'] })
    expect(JSON.stringify(fromRaw)).not.toContain('fake-secret-value-for-tests')
    expect(JSON.stringify(fromRaw)).not.toContain('ZmFrZS1zZWNyZXQtdmFsdWUtZm9yLXRlc3Rz')
  })

  it('a ServiceAccount reads the names beside the metadata, so the card and the Secret drawer read them', () => {
    const nested = { name: 'odd', namespace: 'demo', kind: 'ServiceAccount', created_at: '2026-11-01T00:00:00Z', secrets: [{ name: 't' }], imagePullSecrets: [{ name: 'r' }] }
    const prior = { name: 'odd', namespace: 'demo', secrets: 2, secrets_list: ['a', 'b'], image_pull_secrets: [], labels: { team: 'a' }, annotations: { note: 'kept' } }
    const [row] = applyServiceAccountWatchEvent([prior] as any, { type: 'MODIFIED', object: nested })
    expect(pages.serviceaccounts.shows(row)).toEqual({ secrets: 1, secrets_list: ['t'], image_pull_secrets: ['r'], with_pull_secrets: true, labels: {}, annotations: {} })
    expect(applyServiceAccountWatchEvent([prior] as any, { type: 'DELETED', object: nested })).toEqual([])
  })

  it('a Role counts the rules beside the metadata', () => {
    const nested = { name: 'odd', namespace: 'demo', kind: 'Role', labels: { team: 'a' }, created_at: '2026-11-01T00:00:00Z', rules: [{ verbs: 'not a list' }] }
    const prior = { name: 'odd', namespace: 'demo', rules_count: 5, labels: {}, annotations: { note: 'kept' } }
    const [row] = applyRoleWatchEvent([prior] as any, { type: 'MODIFIED', object: nested })
    expect(pages.roles.shows(row)).toEqual({ rules_count: 1, labels: { team: 'a' }, annotations: {} })
    expect(applyRoleWatchEvent([prior] as any, { type: 'DELETED', object: nested })).toEqual([])
  })
})
