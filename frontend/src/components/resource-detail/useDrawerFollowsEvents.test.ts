import { describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { applyWatchMessage } from '@/services/useKubeWatchList'
import { applyEventFrame, drawerEventSelector, drawerEventsPath, nodeEventNamesNode } from './useDrawerFollowsEvents'
import useWorkloadDataSrc from './workload-info/useWorkloadData.ts?raw'
import hpaInfoSrc from './HPAInfo.tsx?raw'
import podInfoSrc from './PodInfo.tsx?raw'
import namespaceInfoSrc from './NamespaceInfo.tsx?raw'
import useNodeDataSrc from './node-info/useNodeData.ts?raw'

// an event as the answer lists it, told apart by reason here
const row = (reason: string, count: number, last: string) => ({
  type: 'Warning', reason, message: `quota ${reason}`, count, first_timestamp: '2026-11-07T00:00:00Z', last_timestamp: last, source: 'replicaset-controller',
})
// as the server's eventToInfo writes the same event
const frame = (reason: string, count: number, last: string) => ({
  ...row(reason, count, last), name: `web.${reason}`, namespace: 'shop', source: { component: 'replicaset-controller', host: null }, reporting_component: '', involved_object: { kind: 'Deployment', name: 'web', namespace: 'shop' }, created_at: '2026-11-07T00:00:00Z',
})
const data = (type: string, object: object) => ({ type, object })

describe('applyEventFrame', () => {
  const answer = { name: 'web', replicas: 3, events: [row('B', 1, '2026-11-07T02:00:00Z'), row('A', 4, '2026-11-07T01:00:00Z')] }

  it('counts an event up while its object stays as it is', () => {
    const next = applyEventFrame(answer, data('MODIFIED', frame('A', 5, '2026-11-07T03:00:00Z')))
    expect(next.events.map((e: any) => [e.reason, e.count, e.last_timestamp])).toEqual([
      ['A', 5, '2026-11-07T03:00:00Z'],
      ['B', 1, '2026-11-07T02:00:00Z'],
    ])
    expect(next.replicas).toBe(3)
  })

  it('adds a new event in its place, newest first', () => {
    const next = applyEventFrame(answer, data('ADDED', frame('C', 1, '2026-11-07T01:30:00Z')))
    expect(next.events.map((e: any) => e.reason)).toEqual(['B', 'C', 'A'])
  })

  it('takes an event out when the cluster deletes it, as kubectl describe would no longer list it', () => {
    expect(applyEventFrame(answer, data('DELETED', frame('B', 1, '2026-11-07T02:00:00Z'))).events.map((e: any) => e.reason)).toEqual(['A'])
  })

  it('reads the frame into the row the table draws, no name and the source as the answer writes it', () => {
    const next = applyEventFrame(answer, data('MODIFIED', frame('A', 5, '2026-11-07T03:00:00Z')))
    expect(Object.keys(next.events[0]).sort()).toEqual(Object.keys(answer.events[0]).sort())
    expect(next.events[0].source).toBe('replicaset-controller')
  })

  // The scheduler writes events.k8s.io events with no source: the answer says "", the frame { component: null }.
  it('pairs an event that names no source with the answer\'s row, not as a second one', () => {
    const scheduled = { type: 'Normal', reason: 'Scheduled', message: 'Successfully assigned shop/web-1 to n1', count: 1, first_timestamp: '2026-11-07T00:00:00Z', last_timestamp: '2026-11-07T00:00:00Z', source: '' }
    const withScheduled = { ...answer, events: [...answer.events, scheduled] }
    const opening = { ...scheduled, name: 'web-1.1', namespace: 'shop', source: { component: null, host: null }, reporting_component: 'default-scheduler', involved_object: { kind: 'Pod', name: 'web-1', namespace: 'shop' }, created_at: '2026-11-07T00:00:00Z' }
    expect(applyEventFrame(withScheduled, data('ADDED', opening))).toBe(withScheduled)
    expect(applyEventFrame(withScheduled, data('DELETED', opening)).events.map((e: any) => e.reason)).toEqual(['B', 'A'])
  })

  // What a watch opens with is what the answer holds: no drawing, no read.
  it('leaves the answer itself when a frame says what it says', () => {
    expect(applyEventFrame(answer, data('ADDED', frame('A', 4, '2026-11-07T01:00:00Z')))).toBe(answer)
    expect(applyEventFrame(answer, data('DELETED', frame('ZZ', 1, '2026-11-07T01:00:00Z')))).toBe(answer)
  })

  it('touches nothing of an answer whose events could not be read', () => {
    const refused = { name: 'web', events_error: 'events is forbidden' }
    expect(applyEventFrame(refused, data('ADDED', frame('A', 1, '2026-11-07T01:00:00Z')))).toBe(refused)
  })
})

describe('a frame of an event on the answer in the cache', () => {
  const key = ['workload-describe', 'Deployment', 'shop', 'web']

  it('moves the table and asks the server nothing', () => {
    const client = new QueryClient()
    client.setQueryData(key, { name: 'web', events: [row('A', 4, '2026-11-07T01:00:00Z')] })
    applyWatchMessage(client, key, { type: 'DATA', data: data('MODIFIED', frame('A', 9, '2026-11-07T04:00:00Z')) }, (prev, event) => applyEventFrame(prev, event))
    expect((client.getQueryData(key) as any).events[0].count).toBe(9)
    expect(client.getQueryState(key)?.isInvalidated).toBe(false)
  })

  // A container that keeps crashing counts up BackOff on the event while the Pod's status reads the same.
  it('counts up a pod\'s BackOff on the Pod drawer\'s answer, nothing read again', () => {
    const client = new QueryClient()
    const podKey = ['pod-describe', 'shop', 'web-1']
    const backOff = { type: 'Warning', reason: 'BackOff', message: 'Back-off restarting failed container', count: 4, first_timestamp: '2026-11-07T00:00:00Z', last_timestamp: '2026-11-07T01:00:00Z', source: 'kubelet' }
    client.setQueryData(podKey, { name: 'web-1', status: 'CrashLoopBackOff', events: [backOff] })
    const object = { ...backOff, count: 9, last_timestamp: '2026-11-07T01:30:00Z', source: { component: 'kubelet', host: 'n1' }, involved_object: { kind: 'Pod', name: 'web-1', namespace: 'shop' } }
    applyWatchMessage(client, podKey, { type: 'DATA', data: data('MODIFIED', object) }, (prev, event) => applyEventFrame(prev, event))
    const shown = client.getQueryData(podKey) as any
    expect(shown.events).toEqual([{ ...backOff, count: 9, last_timestamp: '2026-11-07T01:30:00Z' }])
    expect(shown.status).toBe('CrashLoopBackOff')
    expect(client.getQueryState(podKey)?.isInvalidated).toBe(false)
  })
})

// kubectl describe lists an object's events by its name, kind and UID (client-go GetFieldSelector): the watch asks the
// same, so an event of an earlier object of the same name does not join the table.
describe('the events a drawer follows', () => {
  it('names the object\'s UID beside its name and kind', () => {
    expect(drawerEventSelector('Deployment', 'web', 'u-1')).toBe('involvedObject.kind=Deployment,involvedObject.name=web,involvedObject.uid=u-1')
  })

  it('names no UID for an object the answer gives none, as kubectl leaves it out', () => {
    for (const uid of [undefined, '', null, 7]) expect(drawerEventSelector('Deployment', 'web', uid)).toBe('involvedObject.kind=Deployment,involvedObject.name=web')
  })

  it('keeps a node\'s frames to those naming its UID or its name', () => {
    const frame = (uid?: string) => ({ reason: 'NodeReady', involved_object: { kind: 'Node', name: 'n1', namespace: '', uid } })
    expect(nodeEventNamesNode(frame('node-uid'), 'n1', 'node-uid')).toBe(true)
    expect(nodeEventNamesNode(frame('n1'), 'n1', 'node-uid')).toBe(true)
    expect(nodeEventNamesNode(frame('old-node-uid'), 'n1', 'node-uid')).toBe(false)
    expect(nodeEventNamesNode(frame(undefined), 'n1', 'node-uid')).toBe(false)
    expect(nodeEventNamesNode(frame(''), 'n1', undefined)).toBe(false)
  })
})

describe('the drawers whose events follow', () => {
  it('a Pod\'s, as its own object in its own namespace, a mirror pod\'s by its static pod\'s UID', () => {
    const hook = podInfoSrc.match(/useDrawerFollowsEvents\(\{[^}]*\}\)/)?.[0] ?? ''
    expect(hook).toContain("describeKey: ['pod-describe', namespace, name]")
    expect(hook).toContain('answer: podDescribe')
    expect(hook).toContain("kind: 'Pod'")
    expect(hook).toContain("uid: podDescribe?.annotations?.['kubernetes.io/config.mirror']")
  })

  it('a Namespace\'s by its UID once the answer has it, and a Node\'s kept to its UID and name', () => {
    expect(namespaceInfoSrc).toContain("drawerEventSelector('Namespace', name, nsUid)")
    expect(namespaceInfoSrc).toContain('enabled: !!name && !!nsUid')
    expect(useNodeDataSrc).toContain('if (!nodeEventNamesNode(obj, name, nodeUid)) return prev ?? items')
    expect(useNodeDataSrc).toContain('enabled: !!name && !!nodeUid')
  })

  it('a workload\'s and an HPA\'s', () => {
    expect(useWorkloadDataSrc).toContain('useDrawerFollowsEvents({')
    expect(hpaInfoSrc).toContain('useDrawerFollowsEvents({')
    expect(hpaInfoSrc).toContain("kind: 'HorizontalPodAutoscaler'")
  })
})

describe('where a drawer\'s events are watched', () => {
  it('in the object\'s namespace, or every namespace for an object of the cluster, as the answer read them', () => {
    expect(drawerEventsPath('shop')).toBe('/api/v1/namespaces/shop/events')
    expect(drawerEventsPath(undefined)).toBe('/api/v1/events')
  })

  // A StorageClass's events: the answer read them across the cluster, and a frame from any namespace is one of them.
  it('counts up an event of an object of the cluster on its answer, nothing read again', () => {
    const client = new QueryClient()
    const key = ['storageclass-describe', 'fast']
    const failing = { type: 'Warning', reason: 'ProvisioningFailed', message: 'no capacity', count: 2, first_timestamp: '2026-11-07T00:00:00Z', last_timestamp: '2026-11-07T01:00:00Z', source: 'csi-provisioner' }
    client.setQueryData(key, { name: 'fast', events: [failing] })
    const object = { ...failing, count: 3, last_timestamp: '2026-11-07T01:05:00Z', namespace: 'default', source: { component: 'csi-provisioner', host: null }, involved_object: { kind: 'StorageClass', name: 'fast', namespace: '' } }
    applyWatchMessage(client, key, { type: 'DATA', data: data('MODIFIED', object) }, (prev, event) => applyEventFrame(prev, event))
    expect((client.getQueryData(key) as any).events).toEqual([{ ...failing, count: 3, last_timestamp: '2026-11-07T01:05:00Z' }])
    expect(client.getQueryState(key)?.isInvalidated).toBe(false)
  })
})

// Every drawer with an Events table, and the kind and namespace k8s-service's describe reads its events by (objectEvents).
const drawerSources = import.meta.glob(['./*Info.tsx', './**/*Detail.tsx'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>

// A kind the drawer passes as a value: the answer's own (a custom resource) or the drawer's prop, which names the kind.
const OF_THE_DRAWER = 'kind'
const EVENT_KINDS: Record<string, { kind: string; cluster: boolean }> = {
  './AdmissionPolicyInfo.tsx': { kind: OF_THE_DRAWER, cluster: true },
  './BackendTLSPolicyInfo.tsx': { kind: 'BackendTLSPolicy', cluster: false },
  './CRDInfo.tsx': { kind: 'CustomResourceDefinition', cluster: true },
  './ClusterRoleBindingInfo.tsx': { kind: 'ClusterRoleBinding', cluster: true },
  './ClusterRoleInfo.tsx': { kind: 'ClusterRole', cluster: true },
  './ConfigMapInfo.tsx': { kind: 'ConfigMap', cluster: false },
  './CustomResourceInstanceInfo.tsx': { kind: OF_THE_DRAWER, cluster: false },
  './DeviceClassInfo.tsx': { kind: 'DeviceClass', cluster: true },
  './GRPCRouteInfo.tsx': { kind: 'GRPCRoute', cluster: false },
  './GatewayClassInfo.tsx': { kind: 'GatewayClass', cluster: true },
  './GatewayInfo.tsx': { kind: 'Gateway', cluster: false },
  './GenericInfo.tsx': { kind: OF_THE_DRAWER, cluster: false },
  './HPAInfo.tsx': { kind: 'HorizontalPodAutoscaler', cluster: false },
  './HTTPRouteInfo.tsx': { kind: 'HTTPRoute', cluster: false },
  './LimitRangeInfo.tsx': { kind: 'LimitRange', cluster: false },
  './NamespaceInfo.tsx': { kind: 'Namespace', cluster: false },
  './PDBInfo.tsx': { kind: 'PodDisruptionBudget', cluster: false },
  './PodInfo.tsx': { kind: 'Pod', cluster: false },
  './PriorityClassInfo.tsx': { kind: 'PriorityClass', cluster: true },
  './ReferenceGrantInfo.tsx': { kind: 'ReferenceGrant', cluster: false },
  './ResourceClaimInfo.tsx': { kind: 'ResourceClaim', cluster: false },
  './ResourceClaimTemplateInfo.tsx': { kind: 'ResourceClaimTemplate', cluster: false },
  './ResourceQuotaInfo.tsx': { kind: 'ResourceQuota', cluster: false },
  './ResourceSliceInfo.tsx': { kind: 'ResourceSlice', cluster: true },
  './RoleBindingInfo.tsx': { kind: 'RoleBinding', cluster: false },
  './RoleInfo.tsx': { kind: 'Role', cluster: false },
  './RuntimeClassInfo.tsx': { kind: 'RuntimeClass', cluster: true },
  './SecretInfo.tsx': { kind: 'Secret', cluster: false },
  './ServiceAccountInfo.tsx': { kind: 'ServiceAccount', cluster: false },
  './ServiceInfo.tsx': { kind: 'Service', cluster: false },
  './VPAInfo.tsx': { kind: 'VerticalPodAutoscaler', cluster: false },
  './WebhookConfigInfo.tsx': { kind: OF_THE_DRAWER, cluster: true },
  './config-storage-info/PVCDetail.tsx': { kind: 'PersistentVolumeClaim', cluster: false },
  './config-storage-info/PVDetail.tsx': { kind: 'PersistentVolume', cluster: true },
  './config-storage-info/StorageClassDetail.tsx': { kind: 'StorageClass', cluster: true },
  './config-storage-info/VolumeAttachmentDetail.tsx': { kind: 'VolumeAttachment', cluster: true },
  './network-info/EndpointDetail.tsx': { kind: 'Endpoints', cluster: false },
  './network-info/EndpointSliceDetail.tsx': { kind: 'EndpointSlice', cluster: false },
  './network-info/IngressClassDetail.tsx': { kind: 'IngressClass', cluster: true },
  './network-info/IngressDetail.tsx': { kind: 'Ingress', cluster: false },
  './network-info/NetworkPolicyDetail.tsx': { kind: 'NetworkPolicy', cluster: false },
}

// The drawers whose Events follow another way, with why.
const FOLLOW_OTHERWISE: Record<string, string> = {
  './NodeInfo.tsx': 'its events are a list of their own with their own watch (node-info/useNodeData)',
  './LeaseInfo.tsx': 'its answer, events too, is read every five seconds',
  './WorkloadInfo.tsx': 'workload-info/useWorkloadData calls the hook',
}

const hookCall = (src: string) => /useDrawerFollowsEvents\(\{([\s\S]*?)\}\)/.exec(src)?.[1] ?? ''

describe('every drawer with an Events table follows its events', () => {
  const withEvents = Object.entries(drawerSources).filter(([, src]) => src.includes('<EventsSection')).map(([path]) => path)

  it('or names how else they follow', () => {
    const unlisted = withEvents.filter((path) => !(path in EVENT_KINDS) && !(path in FOLLOW_OTHERWISE))
    expect(unlisted).toEqual([])
    const silent = Object.keys(EVENT_KINDS).filter((path) => !hookCall(drawerSources[path] ?? ''))
    expect(silent).toEqual([])
  })

  it('by the kind and in the namespace its answer read them, on the answer it draws', () => {
    const wrong: string[] = []
    for (const [path, { kind, cluster }] of Object.entries(EVENT_KINDS)) {
      const src = drawerSources[path] ?? ''
      const call = hookCall(src)
      // `describeKey: [...]`, or `describeKey` alone for a key the drawer named so
      const keyOption = /describeKey(?::\s*(\[[^\]]*\]|\w+))?/.exec(call)
      const key = keyOption ? (keyOption[1] ?? 'describeKey') : ''
      // the options besides the key, which names the namespace too
      const options = call.replace(keyOption?.[0] ?? '', '')
      const kindText = kind === OF_THE_DRAWER ? /\bkind(,|:\s*\(describe\?\.kind)/.test(options) : options.includes(`kind: '${kind}'`)
      if (!kindText) wrong.push(`${path}: kind`)
      if (/\bnamespace\b/.test(options) === cluster) wrong.push(`${path}: ${cluster ? 'a namespace for an object of the cluster' : 'no namespace'}`)
      if (!key || !src.includes(`queryKey: ${key}`)) wrong.push(`${path}: describeKey ${key}`)
    }
    expect(wrong).toEqual([])
  })

  // The answer reads a Namespace's events in that namespace; the watch it had wrote them under a key nobody read.
  it('a Namespace\'s in the namespace itself, on its answer', () => {
    const src = drawerSources['./NamespaceInfo.tsx'] ?? ''
    expect(hookCall(src)).toContain("describeKey: ['namespace-describe', name]")
    expect(hookCall(src)).toContain('answer: nsDescribe')
    expect(hookCall(src)).toContain('namespace: name')
    expect(src).not.toContain('namespace-events')
  })
})
