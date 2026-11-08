import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { answerKeyOf, drawerBody, readFollower } from './useDrawerFollowsRead'

const sources = import.meta.glob(['./*Info.tsx', './**/*Detail.tsx', './*/*.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const allSources = Object.values(sources).join('\n')

describe('what a drawer shows of its object', () => {
  const row = { name: 'web', namespace: 'shop', class_source: 'spec', metadata: { name: 'web', resourceVersion: '1' }, spec: { rules: [{ host: 'old.example.com' }] }, status: { loadBalancer: {} } }
  const live = { metadata: { name: 'web', resourceVersion: '2' }, spec: { rules: [{ host: 'new.example.com' }] }, status: { loadBalancer: { ingress: [{ ip: '10.0.0.1' }] } } }

  it('is the object as the drawer last read it, not the row it opened with', () => {
    const body = drawerBody('Ingress', row, live)
    expect(body?.spec).toEqual(live.spec)
    expect(body?.status).toEqual(live.status)
    expect(body?.metadata).toEqual(live.metadata)
  })

  it('keeps what only the list works out, which no read of the object holds', () => {
    expect(drawerBody('Ingress', row, live)?.class_source).toBe('spec')
  })

  it('does not keep a number of the row beside the object it counted', () => {
    const body = drawerBody(
      'EndpointSlice',
      { name: 'web-abc', endpoints_total: 3, endpoints_ready: 3, labels: { old: 'yes' }, service_name: 'web' },
      { metadata: { name: 'web-abc', labels: { now: 'yes' } }, endpoints: [{ addresses: ['10.0.0.1'] }] },
    )
    expect(body?.endpoints_total).toBeUndefined()
    expect(body?.endpoints_ready).toBeUndefined()
    expect(body?.labels).toBeUndefined()
    expect(body?.name).toBe('web-abc')
    expect(drawerBody('IngressClass', { name: 'nginx', is_default: true }, { metadata: { name: 'nginx' } })?.is_default).toBeUndefined()
  })

  it('is the row until the read answers, and the read when it opened without a row', () => {
    expect(drawerBody('Ingress', row, undefined)).toBe(row)
    expect(drawerBody('Ingress', undefined, live)).toBe(live)
  })

  // The read of a Secret is an audited reveal, for the delete window's labels: its values must not reach the body.
  it('stays the row for what is not read every ten seconds', () => {
    expect(drawerBody('Secret', row, { ...live, data: { token: 'ZmFrZQ==' } })).toBe(row)
    expect(drawerBody('Node', row, live)).toBe(row)
    expect(drawerBody('Namespace', row, live)).toBe(row)
    expect(drawerBody('CustomResourceInstance', row, live)).toBe(row)
  })
})

describe('readFollower', () => {
  const key = ['ingress-describe', 'shop', 'web']
  function setUp() {
    const client = new QueryClient()
    const queryFn = vi.fn(async () => ({ reads: queryFn.mock.calls.length }))
    const stop = new QueryObserver(client, { queryKey: key, queryFn }).subscribe(() => {})
    return { client, queryFn, stop, follower: readFollower(client, key) }
  }
  const at = (resourceVersion: string) => ({ metadata: { resourceVersion } })

  it('reads the answer again when the object changed, once per change', async () => {
    const { client, queryFn, stop, follower } = setUp()
    await vi.waitFor(() => expect(client.getQueryData(key)).toEqual({ reads: 1 }))
    follower.onRead(at('5'))
    follower.onRead(at('6'))
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2))
    follower.onRead(at('6'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(queryFn).toHaveBeenCalledTimes(2)
    stop()
  })

  // The answer was asked for together with the first read.
  it('reads nothing for the first read, nor while the object stays as it is', async () => {
    const { queryFn, stop, follower } = setUp()
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1))
    for (let i = 0; i < 30; i += 1) follower.onRead(at('5'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(queryFn).toHaveBeenCalledTimes(1)
    stop()
  })

  it('keeps the last answer when a read fails or the object is gone', async () => {
    const { client, queryFn, stop, follower } = setUp()
    await vi.waitFor(() => expect(client.getQueryData(key)).toEqual({ reads: 1 }))
    follower.onRead(at('5'))
    follower.onRead(undefined)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(client.getQueryData(key)).toEqual({ reads: 1 })
    stop()
  })
})

describe('answerKeyOf', () => {
  it('names the key the drawer of each kind reads its answer under', () => {
    for (const [kind, namespace] of [
      ['Pod', 'n'], ['Service', 'n'], ['ServiceAccount', 'n'], ['ConfigMap', 'n'], ['Role', 'n'], ['Gateway', 'n'], ['GatewayClass', undefined],
      ['HTTPRoute', 'n'], ['GRPCRoute', 'n'], ['ReferenceGrant', 'n'], ['BackendTLSPolicy', 'n'], ['DeviceClass', undefined], ['ResourceClaim', 'n'],
      ['ResourceClaimTemplate', 'n'], ['ResourceSlice', undefined], ['VerticalPodAutoscaler', 'n'], ['Ingress', 'n'], ['IngressClass', undefined],
      ['Endpoints', 'n'], ['EndpointSlice', 'n'], ['PersistentVolume', undefined], ['PersistentVolumeClaim', 'n'], ['StorageClass', undefined],
      ['VolumeAttachment', undefined], ['ValidatingAdmissionPolicy', undefined], ['MutatingAdmissionPolicy', undefined],
    ] as const) {
      const queryKey = answerKeyOf(kind, namespace, 'x') as string[]
      const first = queryKey[0]
      expect(allSources, `${kind}: ${first}`).toMatch(new RegExp(`queryKey: \\['${first}'`))
    }
  })

  it('leaves the kinds that follow by a watch or read by themselves, so one change is not read twice', () => {
    for (const kind of ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob', 'HorizontalPodAutoscaler', 'ClusterRole', 'ClusterRoleBinding', 'RoleBinding', 'PriorityClass', 'RuntimeClass', 'LimitRange', 'ResourceQuota', 'PodDisruptionBudget', 'CustomResourceDefinition', 'NetworkPolicy', 'Lease', 'ValidatingWebhookConfiguration', 'MutatingWebhookConfiguration', 'Secret', 'Node', 'Namespace']) {
      expect(answerKeyOf(kind, 'n', 'x'), kind).toBeNull()
    }
  })
})
