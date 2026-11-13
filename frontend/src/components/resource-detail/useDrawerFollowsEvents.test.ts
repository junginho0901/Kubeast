import { describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { applyWatchMessage } from '@/services/useKubeWatchList'
import { applyEventFrame, drawerEventSelector, nodeEventNamesNode } from './useDrawerFollowsEvents'
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
