import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { applyWatchMessage } from '@/services/useKubeWatchList'
import workloadDataSrc from './workload-info/useWorkloadData.ts?raw'
import hpaInfoSrc from './HPAInfo.tsx?raw'
import clusterRoleInfoSrc from './ClusterRoleInfo.tsx?raw'
import clusterRoleBindingInfoSrc from './ClusterRoleBindingInfo.tsx?raw'
import roleBindingInfoSrc from './RoleBindingInfo.tsx?raw'
import priorityClassInfoSrc from './PriorityClassInfo.tsx?raw'
import runtimeClassInfoSrc from './RuntimeClassInfo.tsx?raw'
import webhookConfigInfoSrc from './WebhookConfigInfo.tsx?raw'
import limitRangeInfoSrc from './LimitRangeInfo.tsx?raw'
import resourceQuotaInfoSrc from './ResourceQuotaInfo.tsx?raw'
import pdbInfoSrc from './PDBInfo.tsx?raw'
import crdInfoSrc from './CRDInfo.tsx?raw'
import leaseInfoSrc from './LeaseInfo.tsx?raw'
import { objectFollower } from './useDrawerFollowsObject'

const describeKey = ['workload-describe', 'Deployment', 'demo', 'web']

// What the drawer does: an observer on its describe answer, a watch whose frames go through the real message handling.
function openDrawer(answer: () => Record<string, unknown>) {
  const client = new QueryClient()
  let reads = 0
  const observer = new QueryObserver(client, {
    queryKey: describeKey,
    retry: false,
    queryFn: async () => {
      reads += 1
      return answer()
    },
  })
  const unsubscribe = observer.subscribe(() => {})
  const follower = objectFollower(client, describeKey, 1000)
  const frame = (type: string, object: unknown) =>
    applyWatchMessage(client, describeKey, { type: 'DATA', data: { type, object } }, (prev) => prev as any[], follower.onEvent)
  return {
    client,
    frame,
    follower,
    reads: () => reads,
    shown: () => observer.getCurrentResult().data,
    close: () => {
      follower.stop()
      unsubscribe()
    },
  }
}

describe('an open drawer follows its object', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows what the object says now once it changes, with what only the answer holds', async () => {
    let replicas = 2
    const drawer = openDrawer(() => ({ name: 'web', replicas, events: [{ reason: 'Scaled' }] }))
    await vi.advanceTimersByTimeAsync(0)
    expect(drawer.shown()).toEqual({ name: 'web', replicas: 2, events: [{ reason: 'Scaled' }] })

    replicas = 3
    drawer.frame('ADDED', { name: 'web', replicas: 2 })
    drawer.frame('MODIFIED', { name: 'web', replicas: 3 })
    // the last answer stays on screen until the new one comes
    expect(drawer.shown()).toEqual({ name: 'web', replicas: 2, events: [{ reason: 'Scaled' }] })
    await vi.advanceTimersByTimeAsync(1000)
    expect(drawer.shown()).toEqual({ name: 'web', replicas: 3, events: [{ reason: 'Scaled' }] })
    drawer.close()
  })

  it('does not read again for the object the watch opens with', async () => {
    const drawer = openDrawer(() => ({ name: 'web', replicas: 2, events: [] }))
    await vi.advanceTimersByTimeAsync(0)
    drawer.frame('ADDED', { name: 'web', replicas: 2 })
    await vi.advanceTimersByTimeAsync(5000)
    expect(drawer.reads()).toBe(1)
    drawer.close()
  })

  it('reads again when the object the watch opens with is already not what the answer says', async () => {
    const drawer = openDrawer(() => ({ name: 'web', replicas: 2 }))
    await vi.advanceTimersByTimeAsync(0)
    drawer.frame('ADDED', { name: 'web', replicas: 3 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(drawer.reads()).toBe(2)
    drawer.close()
  })

  it('does not read again when the watch opens before the answer has come', async () => {
    let answered = false
    const client = new QueryClient()
    let reads = 0
    const observer = new QueryObserver(client, {
      queryKey: describeKey,
      queryFn: () =>
        new Promise((resolve) => {
          reads += 1
          setTimeout(() => {
            answered = true
            resolve({ name: 'web', replicas: 2 })
          }, 500)
        }),
    })
    const unsubscribe = observer.subscribe(() => {})
    const follower = objectFollower(client, describeKey, 1000)
    follower.onEvent({ type: 'ADDED', object: { name: 'web', replicas: 2 } })
    await vi.advanceTimersByTimeAsync(5000)
    expect(answered).toBe(true)
    expect(reads).toBe(1)
    follower.stop()
    unsubscribe()
  })

  it('reads once for many changes close together, and last after the last of them', async () => {
    let replicas = 0
    const drawer = openDrawer(() => ({ name: 'web', replicas }))
    await vi.advanceTimersByTimeAsync(0)
    drawer.frame('ADDED', { name: 'web', replicas: 0 })
    for (let i = 1; i <= 20; i += 1) {
      replicas = i
      drawer.frame('MODIFIED', { name: 'web', replicas: i })
      await vi.advanceTimersByTimeAsync(40)
    }
    // 800 ms of changes: none read yet at most one a second
    expect(drawer.reads()).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(drawer.reads()).toBe(2)
    expect(drawer.shown()).toEqual({ name: 'web', replicas: 20 })
    drawer.close()
  })

  it('reads again after a read under way, which may have missed the change, and never restarts it', async () => {
    let replicas = 1
    const client = new QueryClient()
    const started: number[] = []
    const finished: number[] = []
    const observer = new QueryObserver(client, {
      queryKey: describeKey,
      queryFn: () =>
        new Promise((resolve) => {
          const at = replicas
          started.push(at)
          // slower than the follower's second
          setTimeout(() => {
            finished.push(at)
            resolve({ name: 'web', replicas: at })
          }, 2500)
        }),
    })
    const unsubscribe = observer.subscribe(() => {})
    const follower = objectFollower(client, describeKey, 1000)
    await vi.advanceTimersByTimeAsync(100)
    // the first read holds replicas 1; this change comes while it is under way
    replicas = 2
    follower.onEvent({ type: 'MODIFIED', object: { name: 'web', replicas: 2 } })
    await vi.advanceTimersByTimeAsync(10000)
    expect(started).toEqual([1, 2])
    expect(finished).toEqual([1, 2])
    expect(observer.getCurrentResult().data).toEqual({ name: 'web', replicas: 2 })
    follower.stop()
    unsubscribe()
  })

  it('keeps the last answer when the object is deleted, and reads again when one of its name comes back', async () => {
    let replicas = 2
    const drawer = openDrawer(() => ({ name: 'web', replicas }))
    await vi.advanceTimersByTimeAsync(0)
    drawer.frame('ADDED', { name: 'web', replicas: 2 })
    // the change just before the delete must not be read after it
    drawer.frame('MODIFIED', { name: 'web', replicas: 2, status: 'Going' })
    drawer.frame('DELETED', { name: 'web', replicas: 2 })
    await vi.advanceTimersByTimeAsync(5000)
    expect(drawer.reads()).toBe(1)
    expect(drawer.shown()).toEqual({ name: 'web', replicas: 2 })

    replicas = 1
    drawer.frame('ADDED', { name: 'web', replicas: 1 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(drawer.reads()).toBe(2)
    expect(drawer.shown()).toEqual({ name: 'web', replicas: 1 })
    drawer.close()
  })

  it('reads nothing once the drawer is closed', async () => {
    const drawer = openDrawer(() => ({ name: 'web', replicas: 1 }))
    await vi.advanceTimersByTimeAsync(0)
    drawer.frame('MODIFIED', { name: 'web', replicas: 2 })
    drawer.close()
    await vi.advanceTimersByTimeAsync(5000)
    expect(drawer.reads()).toBe(1)
  })

  it('a watch that lost its place asks for the answer again', async () => {
    let replicas = 2
    const drawer = openDrawer(() => ({ name: 'web', replicas }))
    await vi.advanceTimersByTimeAsync(0)
    replicas = 3
    applyWatchMessage(drawer.client, describeKey, { type: 'RESYNC' })
    await vi.advanceTimersByTimeAsync(0)
    expect(drawer.shown()).toEqual({ name: 'web', replicas: 3 })
    drawer.close()
  })
})

describe('the drawers that read a describe answer follow their object', () => {
  it('every workload kind has its list to watch, by its API group, narrowed to the one object', () => {
    for (const line of [
      "Deployment: ['apps/v1', 'deployments']",
      "StatefulSet: ['apps/v1', 'statefulsets']",
      "DaemonSet: ['apps/v1', 'daemonsets']",
      "ReplicaSet: ['apps/v1', 'replicasets']",
      "Job: ['batch/v1', 'jobs']",
      "CronJob: ['batch/v1', 'cronjobs']",
    ]) {
      expect(workloadDataSrc).toContain(line)
    }
    expect(workloadDataSrc).toContain('useDrawerFollowsObject({')
    expect(hpaInfoSrc).toContain('useDrawerFollowsObject({')
    expect(hpaInfoSrc).toContain('/apis/autoscaling/v2/namespaces/${namespace}/horizontalpodautoscalers')
  })

  it('every drawer of a binding, a class, a quota and a definition follows the answer it reads, by its own list', () => {
    const keyOf = (src: string, label: string) => src.match(new RegExp(`${label}: (\\[[^\\]]*-describe[^\\]]*\\])`))?.[1]
    for (const [src, path] of [
      [clusterRoleInfoSrc, "'/apis/rbac.authorization.k8s.io/v1/clusterroles'"],
      [clusterRoleBindingInfoSrc, "'/apis/rbac.authorization.k8s.io/v1/clusterrolebindings'"],
      [roleBindingInfoSrc, '`/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace}/rolebindings`'],
      [priorityClassInfoSrc, "'/apis/scheduling.k8s.io/v1/priorityclasses'"],
      [runtimeClassInfoSrc, "'/apis/node.k8s.io/v1/runtimeclasses'"],
      [webhookConfigInfoSrc, "`/apis/admissionregistration.k8s.io/v1/${isMutating ? 'mutatingwebhookconfigurations' : 'validatingwebhookconfigurations'}`"],
      [limitRangeInfoSrc, '`/api/v1/namespaces/${namespace}/limitranges`'],
      [resourceQuotaInfoSrc, '`/api/v1/namespaces/${namespace}/resourcequotas`'],
      [pdbInfoSrc, '`/apis/policy/v1/namespaces/${namespace}/poddisruptionbudgets`'],
      [crdInfoSrc, "'/apis/apiextensions.k8s.io/v1/customresourcedefinitions'"],
    ]) {
      expect(src).toContain('useDrawerFollowsObject({')
      expect(src).toContain(`path: ${path},`)
      expect(keyOf(src, 'describeKey'), path).toBeTruthy()
      expect(keyOf(src, 'describeKey'), path).toBe(keyOf(src, 'queryKey'))
    }
  })

  // A Lease's holder renews it every few seconds, faster than a read of its events is worth: the drawer reads on the clock.
  it('a Lease drawer reads its answer on the clock', () => {
    expect(leaseInfoSrc).toContain('refetchInterval: 5_000')
  })
})
