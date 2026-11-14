import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// TanStack Query keeps no clock on a server, which is what it takes this environment for.
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window ??= {}
})

import { focusManager, QueryClient, QueryObserver, type QueryKey } from '@tanstack/react-query'
import { applyWatchMessage } from '@/services/useKubeWatchList'
import { objectReadInterval } from './drawerObjectLayer'
import answerCases from './drawerAnswer.cases.json'
import drawerSrc from '../ResourceDetailDrawer.tsx?raw'
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
import followHookSrc from './useDrawerFollowsObject.ts?raw'
import { frameOfObject, objectFollower, openListOf } from './useDrawerFollowsObject'
import { applyPriorityClassWatchEvent } from '@/pages/cluster/priorityclasses/priorityClassWatchNormalize'

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

  it('shows what an update says at once, and what only the answer holds when it is read', async () => {
    let replicas = 2
    let events = [{ reason: 'Scaled' }]
    const drawer = openDrawer(() => ({ name: 'web', replicas, events }))
    await vi.advanceTimersByTimeAsync(0)
    expect(drawer.shown()).toEqual({ name: 'web', replicas: 2, events: [{ reason: 'Scaled' }] })

    replicas = 3
    events = [{ reason: 'Scaled' }, { reason: 'ScaledAgain' }]
    drawer.frame('ADDED', { name: 'web', replicas: 2 })
    drawer.frame('MODIFIED', { name: 'web', replicas: 3 })
    // the rest of the last answer stays on screen until the new one comes
    expect(drawer.shown()).toEqual({ name: 'web', replicas: 3, events: [{ reason: 'Scaled' }] })
    await vi.advanceTimersByTimeAsync(1000)
    expect(drawer.shown()).toEqual({ name: 'web', replicas: 3, events: [{ reason: 'Scaled' }, { reason: 'ScaledAgain' }] })
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

  // The first read went out before the object changed and answers after the watch opened with the change.
  const slowFirstAnswer = (server: { replicas: number }) => {
    const client = new QueryClient()
    let reads = 0
    const observer = new QueryObserver(client, {
      queryKey: describeKey,
      retry: false,
      queryFn: () => {
        reads += 1
        const read = { name: 'web', replicas: server.replicas, events: [{ reason: `read ${reads}` }] }
        return new Promise((resolve) => setTimeout(() => resolve(read), 500))
      },
    })
    const unsubscribe = observer.subscribe(() => {})
    const follower = objectFollower(client, describeKey, 1000)
    return {
      follower,
      reads: () => reads,
      shown: () => observer.getCurrentResult().data as { replicas: number; events: Array<{ reason: string }> } | undefined,
      close: () => {
        follower.stop()
        unsubscribe()
      },
    }
  }

  it('keeps what the watch opened with over a first answer read before it, and reads that answer again once', async () => {
    const server = { replicas: 1 }
    const drawer = slowFirstAnswer(server)
    server.replicas = 2
    drawer.follower.onEvent({ type: 'ADDED', object: { name: 'web', replicas: 2 } })
    await vi.advanceTimersByTimeAsync(500)
    expect(drawer.shown()?.replicas).toBe(2)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(drawer.reads()).toBe(2)
    expect(drawer.shown()).toEqual({ name: 'web', replicas: 2, events: [{ reason: 'read 2' }] })
    drawer.close()
  })

  it('reads nothing more when the first answer, come after the watch opened, says what the watch said', async () => {
    const server = { replicas: 2 }
    const drawer = slowFirstAnswer(server)
    drawer.follower.onEvent({ type: 'ADDED', object: { name: 'web', replicas: 2 } })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(drawer.reads()).toBe(1)
    expect(drawer.shown()?.replicas).toBe(2)
    drawer.close()
  })

  it('keeps a change the watch brought before the first answer over that answer, with one read more', async () => {
    const server = { replicas: 1 }
    const drawer = slowFirstAnswer(server)
    drawer.follower.onEvent({ type: 'ADDED', object: { name: 'web', replicas: 1 } })
    server.replicas = 3
    drawer.follower.onEvent({ type: 'MODIFIED', object: { name: 'web', replicas: 3 } })
    await vi.advanceTimersByTimeAsync(500)
    expect(drawer.shown()?.replicas).toBe(3)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(drawer.reads()).toBe(2)
    expect(drawer.shown()?.replicas).toBe(3)
    drawer.close()
  })

  it('reads once for many changes close together, and last after the last of them', async () => {
    let replicas = 0
    const drawer = openDrawer(() => ({ name: 'web', replicas }))
    await vi.advanceTimersByTimeAsync(0)
    drawer.frame('ADDED', { name: 'web', replicas: 0 })
    for (let i = 1; i <= 10; i += 1) {
      replicas = i
      drawer.frame('MODIFIED', { name: 'web', replicas: i })
      await vi.advanceTimersByTimeAsync(20)
    }
    // 200 ms of changes: the read waits for those close together
    expect(drawer.reads()).toBe(1)
    await vi.advanceTimersByTimeAsync(800)
    expect(drawer.reads()).toBe(2)
    expect(drawer.shown()).toEqual({ name: 'web', replicas: 10 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(drawer.reads()).toBe(2)
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
    await vi.advanceTimersByTimeAsync(5000)
    expect(drawer.shown()).toEqual({ name: 'web', replicas: 3 })
    drawer.close()
  })
})

// A Node drawer follows the node list, whose rows carry each condition's type, status and reason; the describe answer
// says each with its message and times, which "Since Ready Changed" and the Conditions section show.
describe('a Node drawer and the node list row it follows', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const condition = (type: string, status: string, reason: string, since: string, beat: string) => ({
    row: { type, status, reason },
    answer: { type, status, reason, message: `${type} is ${status}`, last_heartbeat_time: beat, last_transition_time: since },
  })
  const node = (labels: Record<string, string>, conditions: Array<ReturnType<typeof condition>>) => ({
    row: { name: 'node-a', status: 'Ready', roles: ['control-plane'], labels, conditions: conditions.map((c) => c.row) },
    answer: { name: 'node-a', status: 'Ready', roles: ['control-plane'], labels, conditions: conditions.map((c) => c.answer), pod_cidr: '10.244.0.0/24' },
  })
  const ready = condition('Ready', 'True', 'KubeletReady', '2026-11-01T00:01:00Z', '2026-11-08T11:59:00Z')
  const memory = condition('MemoryPressure', 'False', 'KubeletHasSufficientMemory', '2026-11-01T00:00:00Z', '2026-11-08T11:59:00Z')

  it('keeps the conditions\' times and reads nothing more when the watch opens with the node as it is', async () => {
    const opened = node({}, [memory, ready])
    const drawer = openDrawer(() => opened.answer)
    await vi.advanceTimersByTimeAsync(0)
    drawer.frame('ADDED', opened.row)
    await vi.advanceTimersByTimeAsync(5000)
    expect((drawer.shown() as typeof opened.answer).conditions).toEqual(opened.answer.conditions)
    expect(drawer.reads()).toBe(1)
    drawer.close()
  })

  it('shows a new label at once and keeps the conditions\' times until the answer is read again', async () => {
    let now = node({}, [memory, ready])
    const drawer = openDrawer(() => now.answer)
    await vi.advanceTimersByTimeAsync(0)
    drawer.frame('ADDED', now.row)
    now = node({ team: 'a' }, [memory, condition('Ready', 'True', 'KubeletReady', '2026-11-01T00:01:00Z', '2026-11-08T12:04:00Z')])
    drawer.frame('MODIFIED', now.row)
    const shown = drawer.shown() as typeof now.answer
    expect(shown.labels).toEqual({ team: 'a' })
    expect(shown.conditions.map((c) => c.last_transition_time)).toEqual(['2026-11-01T00:00:00Z', '2026-11-01T00:01:00Z'])
    await vi.advanceTimersByTimeAsync(1000)
    expect(drawer.shown()).toEqual(now.answer)
    drawer.close()
  })

  it('reads again when the node the watch opens with no longer has the conditions the answer says', async () => {
    let now = node({}, [memory, ready])
    const drawer = openDrawer(() => now.answer)
    await vi.advanceTimersByTimeAsync(0)
    now = node({}, [memory, condition('Ready', 'Unknown', 'NodeStatusUnknown', '2026-11-08T12:00:40Z', '2026-11-08T11:59:00Z')])
    drawer.frame('ADDED', now.row)
    await vi.advanceTimersByTimeAsync(1000)
    expect(drawer.reads()).toBe(2)
    expect((drawer.shown() as typeof now.answer).conditions).toEqual(now.answer.conditions)
    drawer.close()
  })
})

// The drawer's two reads as the page makes them: its answer, and the object for the floating chat on the clock only
// while the watch of the object does not answer. Reads are counted, not intervals.
function openReads(answer: () => Record<string, unknown>, object: () => Record<string, unknown> = () => ({ metadata: { name: 'web' } })) {
  const client = new QueryClient()
  // as the provider does, so a tab that shows again reads what is stale
  client.mount()
  const chatKey: QueryKey = ['resource-json', 'Deployment', 'demo', 'web']
  let reads = 0
  let chatReads = 0
  let answering = true
  const describeObserver = new QueryObserver(client, {
    queryKey: describeKey,
    retry: false,
    queryFn: async () => {
      reads += 1
      return answer()
    },
  })
  const chatObserver = new QueryObserver(client, {
    queryKey: chatKey,
    retry: false,
    staleTime: 30_000,
    refetchInterval: (query) => objectReadInterval(true, query.state.error, answering),
    queryFn: async () => {
      chatReads += 1
      return object()
    },
  })
  const stops = [describeObserver.subscribe(() => {}), chatObserver.subscribe(() => {})]
  const follower = (objectFollower as (...args: unknown[]) => ReturnType<typeof objectFollower>)(client, describeKey, undefined, [], chatKey)
  return {
    client,
    follower,
    frame: (type: string, object: unknown) =>
      applyWatchMessage(client, describeKey, { type: 'DATA', data: { type, object } }, (prev) => prev as any[], follower.onEvent),
    reads: () => reads,
    chatReads: () => chatReads,
    shown: () => describeObserver.getCurrentResult().data,
    objectShown: () => chatObserver.getCurrentResult().data,
    setAnswering: (value: boolean) => {
      answering = value
      chatObserver.setOptions({ ...chatObserver.options })
    },
    close: () => {
      follower.stop()
      stops.forEach((stop) => stop())
      client.unmount()
    },
  }
}

describe('how often an open drawer reads', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    focusManager.setFocused(undefined)
  })

  it('reads nothing past the first read of each while its object stays as it is', async () => {
    const drawer = openReads(() => ({ name: 'web', replicas: 2 }))
    await vi.advanceTimersByTimeAsync(0)
    drawer.frame('ADDED', { name: 'web', replicas: 2 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(drawer.reads()).toBe(1)
    expect(drawer.chatReads()).toBe(1)
    drawer.close()
  })

  it('reads the answer and the object within a second of one change', async () => {
    let replicas = 2
    const drawer = openReads(() => ({ name: 'web', replicas }), () => ({ metadata: { name: 'web' }, spec: { replicas } }))
    await vi.advanceTimersByTimeAsync(0)
    drawer.frame('ADDED', { name: 'web', replicas: 2 })
    replicas = 3
    drawer.frame('MODIFIED', { name: 'web', replicas: 3 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(drawer.reads()).toBe(2)
    expect(drawer.chatReads()).toBe(2)
    expect(drawer.objectShown()).toEqual({ metadata: { name: 'web' }, spec: { replicas: 3 } })
    drawer.close()
  })

  it('reads again as soon as it may for a change after a quiet time, not five seconds after the last read', async () => {
    let replicas = 2
    const drawer = openReads(() => ({ name: 'web', replicas }))
    await vi.advanceTimersByTimeAsync(0)
    drawer.frame('ADDED', { name: 'web', replicas: 2 })
    replicas = 3
    drawer.frame('MODIFIED', { name: 'web', replicas: 3 })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(drawer.reads()).toBe(2)
    replicas = 4
    drawer.frame('MODIFIED', { name: 'web', replicas: 4 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(drawer.reads()).toBe(3)
    drawer.close()
  })

  it('reads the answer once in five seconds at most and the object once in ten under a stream of changes, and both after the last', async () => {
    let replicas = 2
    const drawer = openReads(() => ({ name: 'web', replicas }), () => ({ metadata: { name: 'web' }, spec: { replicas } }))
    await vi.advanceTimersByTimeAsync(0)
    drawer.frame('ADDED', { name: 'web', replicas: 2 })
    for (let i = 0; i < 300; i += 1) {
      replicas = 3 + i
      drawer.frame('MODIFIED', { name: 'web', replicas })
      await vi.advanceTimersByTimeAsync(200)
    }
    if (process.env.WATCH_BENCH) console.info(`bench a minute of 5 changes a second: answer ${drawer.reads()} reads, object ${drawer.chatReads()} reads`)
    expect(drawer.reads()).toBeLessThanOrEqual(1 + 13)
    expect(drawer.chatReads()).toBeLessThanOrEqual(1 + 7)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(drawer.shown()).toEqual({ name: 'web', replicas })
    expect(drawer.objectShown()).toEqual({ metadata: { name: 'web' }, spec: { replicas } })
    drawer.close()
  })

  it('goes back to reading the object on the clock while the watch does not answer, and stops when it answers again', async () => {
    const drawer = openReads(() => ({ name: 'web', replicas: 2 }))
    await vi.advanceTimersByTimeAsync(0)
    drawer.setAnswering(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(drawer.chatReads()).toBeGreaterThanOrEqual(1 + 5)
    const before = drawer.chatReads()
    drawer.setAnswering(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(drawer.chatReads()).toBe(before)
    drawer.close()
  })

  it('reads the object once when it is deleted, which tells the chat it is gone, and not the answer', async () => {
    let gone = false
    const drawer = openReads(() => ({ name: 'web', replicas: 2 }), () => {
      if (gone) throw Object.assign(new Error('gone'), { response: { status: 404 } })
      return { metadata: { name: 'web' } }
    })
    await vi.advanceTimersByTimeAsync(0)
    drawer.frame('ADDED', { name: 'web', replicas: 2 })
    gone = true
    drawer.frame('DELETED', { name: 'web', replicas: 2 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(drawer.reads()).toBe(1)
    expect(drawer.chatReads()).toBe(2)
    drawer.close()
  })

  it('reads the object again when the watch lost its place', async () => {
    let replicas = 2
    const drawer = openReads(() => ({ name: 'web', replicas }), () => ({ metadata: { name: 'web' }, spec: { replicas } }))
    await vi.advanceTimersByTimeAsync(0)
    drawer.frame('ADDED', { name: 'web', replicas: 2 })
    replicas = 3
    applyWatchMessage(drawer.client, describeKey, { type: 'RESYNC' }, undefined, undefined, drawer.follower.onResync)
    await vi.advanceTimersByTimeAsync(7000)
    expect(drawer.objectShown()).toEqual({ metadata: { name: 'web' }, spec: { replicas: 3 } })
    expect(drawer.chatReads()).toBe(2)
    drawer.close()
  })

  it('reads the object again when what it holds was read before this watch opened', async () => {
    const client = new QueryClient()
    const chatKey: QueryKey = ['resource-json', 'Deployment', 'demo', 'web']
    let reads = 0
    client.setQueryData(chatKey, { metadata: { name: 'web' }, spec: { replicas: 1 } })
    await vi.advanceTimersByTimeAsync(1)
    const stop = new QueryObserver(client, {
      queryKey: chatKey,
      staleTime: 30_000,
      queryFn: async () => {
        reads += 1
        return { metadata: { name: 'web' }, spec: { replicas: 2 } }
      },
    }).subscribe(() => {})
    const follower = (objectFollower as (...args: unknown[]) => ReturnType<typeof objectFollower>)(client, describeKey, undefined, [], chatKey)
    follower.onEvent({ type: 'ADDED', object: { name: 'web', replicas: 2 } })
    await vi.advanceTimersByTimeAsync(1000)
    expect(reads).toBe(1)
    expect(client.getQueryData(chatKey)).toEqual({ metadata: { name: 'web' }, spec: { replicas: 2 } })
    follower.stop()
    stop()
  })

  // A list already open has said what it opens with: no frame comes to tell the drawer anything.
  describe('joining a list already open', () => {
    function joinAfter(age: number) {
      const client = new QueryClient()
      const chatKey: QueryKey = ['resource-json', 'Deployment', 'demo', 'web']
      let reads = 0
      let chatReads = 0
      client.setQueryData(describeKey, { name: 'web', replicas: 1 })
      client.setQueryData(chatKey, { metadata: { name: 'web' } })
      return vi.advanceTimersByTimeAsync(age).then(() => {
        const stops = [
          new QueryObserver(client, { queryKey: describeKey, staleTime: 60_000, queryFn: async () => { reads += 1; return { name: 'web', replicas: 2 } } }).subscribe(() => {}),
          new QueryObserver(client, { queryKey: chatKey, staleTime: 60_000, queryFn: async () => { chatReads += 1; return { metadata: { name: 'web' } } } }).subscribe(() => {}),
        ]
        const follower = (objectFollower as (...args: unknown[]) => ReturnType<typeof objectFollower>)(client, describeKey, undefined, [], chatKey)
        return { client, follower, reads: () => reads, chatReads: () => chatReads, close: () => { follower.stop(); stops.forEach((stop) => stop()) } }
      })
    }

    it('reads once what it holds from before it joined, as a frame opening a watch of its own would have it do', async () => {
      const drawer = await joinAfter(1)
      drawer.follower.onJoinedList()
      await vi.advanceTimersByTimeAsync(5000)
      expect(drawer.reads()).toBe(1)
      expect(drawer.chatReads()).toBe(1)
      expect(drawer.client.getQueryData(describeKey)).toEqual({ name: 'web', replicas: 2 })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(drawer.reads()).toBe(1)
      drawer.close()
    })

    it('reads nothing the drawer is reading already, or anything once it is closed', async () => {
      const reading = await joinAfter(1)
      reading.follower.onJoinedList()
      void reading.client.fetchQuery({ queryKey: describeKey, queryFn: () => new Promise((resolve) => setTimeout(() => resolve({ name: 'web', replicas: 3 }), 2000)) })
      await vi.advanceTimersByTimeAsync(5000)
      expect(reading.reads()).toBe(0)
      reading.close()

      const closed = await joinAfter(1)
      closed.follower.onJoinedList()
      closed.close()
      await vi.advanceTimersByTimeAsync(5000)
      expect(closed.reads()).toBe(0)
      expect(closed.chatReads()).toBe(0)
    })

    it('the hook joins only a list it shares, and hands the first read to the follower', () => {
      expect(followHookSrc).toContain('if (openList) current.onJoinedList()')
    })
  })

  it('a hidden tab reads nothing for its changes and reads once when it shows again', async () => {
    let replicas = 2
    const drawer = openReads(() => ({ name: 'web', replicas }), () => ({ metadata: { name: 'web' }, spec: { replicas } }))
    await vi.advanceTimersByTimeAsync(0)
    drawer.frame('ADDED', { name: 'web', replicas: 2 })
    focusManager.setFocused(false)
    for (let i = 0; i < 100; i += 1) {
      replicas = 3 + i
      drawer.frame('MODIFIED', { name: 'web', replicas })
      await vi.advanceTimersByTimeAsync(600)
    }
    expect(drawer.reads()).toBe(1)
    expect(drawer.chatReads()).toBe(1)
    // what a frame says still reaches the answer, so the tab shows it the moment it comes back
    expect(drawer.shown()).toEqual({ name: 'web', replicas })

    focusManager.setFocused(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(drawer.reads()).toBe(2)
    expect(drawer.chatReads()).toBe(2)
    expect(drawer.objectShown()).toEqual({ metadata: { name: 'web' }, spec: { replicas } })
    drawer.close()
  })

  it('a read that started before an update does not bring the older value back', async () => {
    let replicas = 1
    let events = ['first']
    const client = new QueryClient()
    const observer = new QueryObserver(client, {
      queryKey: describeKey,
      retry: false,
      queryFn: () =>
        new Promise((resolve) => {
          const at = { name: 'web', replicas, events }
          setTimeout(() => resolve(at), 400)
        }),
    })
    const unsubscribe = observer.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(400)
    const follower = objectFollower(client, describeKey)
    follower.onEvent({ type: 'ADDED', object: { name: 'web', replicas: 1 } })

    events = ['second']
    void client.invalidateQueries({ queryKey: describeKey })
    await vi.advanceTimersByTimeAsync(100)
    replicas = 2
    follower.onEvent({ type: 'MODIFIED', object: { name: 'web', replicas: 2 } })
    expect((observer.getCurrentResult().data as { replicas: number }).replicas).toBe(2)
    // the read under way answers replicas 1, with its newer events
    await vi.advanceTimersByTimeAsync(300)
    expect(observer.getCurrentResult().data).toEqual({ name: 'web', replicas: 2, events: ['second'] })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(observer.getCurrentResult().data).toEqual({ name: 'web', replicas: 2, events: ['second'] })
    follower.stop()
    unsubscribe()
  })

  it('the drawer reads its object on the clock only while the watch of that object does not answer', () => {
    expect(drawerSrc).toContain('refetchInterval: (query) => objectReadInterval(followsForChat, query.state.error, objectWatchAnswers),')
    expect(drawerSrc).toContain('<DrawerObjectReadContext.Provider value={objectRead}>')
    expect(followHookSrc).toContain('useContext(DrawerObjectReadContext)')
    expect(followHookSrc).toContain('onAnswering: (answers) => objectRead?.setWatchAnswers(answers),')
  })
})

// What only the answer holds waits for its read: within a second of a change, within five while changes keep coming.
// Written by kind, so a new field that waits is seen here.
const READ_BRINGS: Record<string, string[]> = {
  // the row's current_replicas moves replicas_status.current with the frame
  deployments: ['conditions', 'pod_template'],
  statefulsets: ['pod_template'],
  daemonsets: ['pod_template'],
  replicasets: [],
  jobs: ['conditions', 'start_time', 'suspend'],
  cronjobs: ['active_jobs', 'time_zone'],
  horizontalpodautoscalers: ['conditions', 'last_scale_time', 'metrics_status'],
  clusterroles: ['rules'],
  clusterrolebindings: [],
  rolebindings: [],
  priorityclasses: [],
  runtimeclasses: ['overhead', 'scheduling'],
  validatingwebhookconfigurations: ['webhooks'],
  mutatingwebhookconfigurations: ['webhooks'],
  limitranges: [],
  resourcequotas: ['spec_hard'],
  poddisruptionbudgets: ['match_expressions', 'max_unavailable', 'min_available', 'unhealthy_pod_eviction_policy'],
  customresourcedefinitions: ['versions'],
  // the row's conditions have no message or times
  nodes: ['conditions'],
}

type AnswerCase = { name: string; resource: string; before: Record<string, unknown>; frame: Record<string, unknown>; after: Record<string, unknown> }

describe('what a live update changes in an open drawer before its answer is read', () => {
  const show = (c: AnswerCase) => {
    const client = new QueryClient()
    client.setQueryData(describeKey, c.before)
    const follower = objectFollower(client, describeKey)
    follower.onEvent({ type: 'MODIFIED', object: c.frame })
    follower.stop()
    return client.getQueryData(describeKey) as Record<string, unknown>
  }
  const flat = (value: Record<string, unknown>) => {
    const cells: Record<string, string> = {}
    for (const [key, cell] of Object.entries(value)) {
      if (key === 'replicas_status' || key === 'daemonset_status') {
        for (const [part, number] of Object.entries(cell as Record<string, unknown>)) cells[`${key}.${part}`] = JSON.stringify(number)
      } else {
        cells[key] = JSON.stringify(cell)
      }
    }
    return cells
  }

  for (const c of answerCases as unknown as AnswerCase[]) {
    it(`${c.resource}: ${c.name}`, () => {
      const shown = flat(show(c))
      const after = flat(c.after)
      // a field of the row that no answer has draws nothing
      const onlyTheRow = (key: string) => key in c.frame && !(key in c.before) && !(key in c.after)
      const lagging = Object.keys({ ...shown, ...after }).filter((key) => shown[key] !== after[key] && !onlyTheRow(key)).sort()
      expect(lagging.filter((key) => !READ_BRINGS[c.resource].includes(key))).toEqual([])
    })
  }

  it('keeps every field of the answer an update does not name', () => {
    const client = new QueryClient()
    const answer = { name: 'web', replicas: 2, events: [{ reason: 'Scaled' }], conditions: [{ type: 'Available' }], pod_template: { containers: [] } }
    client.setQueryData(describeKey, answer)
    const follower = objectFollower(client, describeKey)
    follower.onEvent({ type: 'MODIFIED', object: { name: 'web', replicas: 3 } })
    follower.stop()
    expect(client.getQueryData(describeKey)).toEqual({ ...answer, replicas: 3 })
  })

  it('does not write a default of the row over an answer that says there is none', () => {
    const client = new QueryClient()
    const answer = { name: 'job', completions: null, status: 'Running' }
    client.setQueryData(describeKey, answer)
    const follower = objectFollower(client, describeKey)
    follower.onEvent({ type: 'ADDED', object: { name: 'job', completions: 1, status: 'Running' } })
    expect(client.getQueryData(describeKey)).toEqual(answer)
    follower.stop()
  })

  it('takes nothing of another shape from a row the server could not convert', () => {
    const client = new QueryClient()
    const answer = { name: 'web', status: 'Running', replicas: 2, conditions: [{ type: 'Available' }] }
    client.setQueryData(describeKey, answer)
    const follower = objectFollower(client, describeKey)
    follower.onEvent({ type: 'MODIFIED', object: { name: 'web', status: { replicas: 3 }, spec: { replicas: 3 } } })
    follower.stop()
    const shown = client.getQueryData(describeKey) as Record<string, unknown>
    expect(shown.status).toBe('Running')
    expect(shown.conditions).toEqual([{ type: 'Available' }])
  })

  it('moves the Replicas section with the counts it mirrors', () => {
    const client = new QueryClient()
    client.setQueryData(describeKey, {
      name: 'web', replicas: 2, ready_replicas: 2, updated_replicas: 2, available_replicas: 2,
      replicas_status: { desired: 2, current: 2, ready: 2, updated: 2, available: 2 },
    })
    const follower = objectFollower(client, describeKey)
    follower.onEvent({ type: 'MODIFIED', object: { name: 'web', replicas: 3, ready_replicas: 2, updated_replicas: 1, available_replicas: 2 } })
    follower.stop()
    expect((client.getQueryData(describeKey) as { replicas_status: unknown }).replicas_status).toEqual({ desired: 3, current: 2, ready: 2, updated: 1, available: 2 })
  })

  // A rollout holds the old ReplicaSet's pods beside the new one's: kubectl describe's "total", the Deployment row's
  // current_replicas, moves with the frame.
  it('moves a Deployment\'s Current with the frame, as its row says the pods it holds', () => {
    const client = new QueryClient()
    client.setQueryData(describeKey, {
      name: 'web', replicas: 3, current_replicas: 3, ready_replicas: 3, updated_replicas: 3, available_replicas: 3,
      replicas_status: { desired: 3, current: 3, ready: 3, updated: 3, available: 3 },
    })
    const follower = objectFollower(client, describeKey)
    follower.onEvent({ type: 'MODIFIED', object: { name: 'web', replicas: 3, current_replicas: 4, ready_replicas: 3, updated_replicas: 1, available_replicas: 3 } })
    follower.stop()
    expect((client.getQueryData(describeKey) as { replicas_status: unknown }).replicas_status).toEqual({ desired: 3, current: 4, ready: 3, updated: 1, available: 3 })
  })
})

describe('a table in a drawer that reads what its object decides', () => {
  const tableKey = ['limitrange-violations', 'demo', 'web']

  // The drawer's two reads, a watch of its object and the follower that reads both again. A slow table takes `tableMs`.
  function openDrawerWithTable(rows: () => string[], tableMs = 0) {
    const client = new QueryClient()
    let reads = 0
    let tableReads = 0
    const answer = new QueryObserver(client, {
      queryKey: describeKey,
      retry: false,
      queryFn: async () => {
        reads += 1
        return { name: 'web', max: rows().length }
      },
    })
    const table = new QueryObserver(client, {
      queryKey: tableKey,
      retry: false,
      queryFn: () =>
        new Promise<string[]>((resolve) => {
          tableReads += 1
          const now = rows()
          setTimeout(() => resolve(now), tableMs)
        }),
    })
    const stops = [answer.subscribe(() => {}), table.subscribe(() => {})]
    const follower = objectFollower(client, describeKey, 1000, [tableKey])
    return {
      client,
      follower,
      frame: (type: string, object: unknown) =>
        applyWatchMessage(client, describeKey, { type: 'DATA', data: { type, object } }, (prev) => prev as any[], follower.onEvent),
      reads: () => reads,
      tableReads: () => tableReads,
      rowsShown: () => table.getCurrentResult().data,
      close: () => {
        follower.stop()
        stops.forEach((stop) => stop())
      },
    }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    // the last moment a read may start, so what is on screen just then can be said
    vi.spyOn(Math, 'random').mockReturnValue(0.9999)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('reads it again when the object changes, keeping the last rows on screen until the new ones come', async () => {
    let rows = ['pod-a']
    const drawer = openDrawerWithTable(() => rows, 300)
    await vi.advanceTimersByTimeAsync(300)
    expect(drawer.rowsShown()).toEqual(['pod-a'])

    rows = ['pod-a', 'pod-b']
    drawer.frame('MODIFIED', { name: 'web', max: 2 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(drawer.tableReads()).toBe(2)
    expect(drawer.rowsShown()).toEqual(['pod-a'])
    await vi.advanceTimersByTimeAsync(300)
    expect(drawer.rowsShown()).toEqual(['pod-a', 'pod-b'])
    drawer.close()
  })

  it('reads it once a second at most, however many changes come', async () => {
    let rows = ['pod-a']
    const drawer = openDrawerWithTable(() => rows)
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 1; i <= 50; i += 1) {
      rows = Array.from({ length: i }, (_, n) => `pod-${n}`)
      drawer.frame('MODIFIED', { name: 'web', max: i })
      await vi.advanceTimersByTimeAsync(100)
    }
    // 5 s of changes
    expect(drawer.tableReads()).toBeLessThanOrEqual(6)
    await vi.advanceTimersByTimeAsync(1000)
    expect(drawer.rowsShown()).toHaveLength(50)
    drawer.close()
  })

  it('does not read it for the object the watch opens with', async () => {
    const drawer = openDrawerWithTable(() => ['pod-a'])
    await vi.advanceTimersByTimeAsync(0)
    drawer.frame('ADDED', { name: 'web', max: 1 })
    await vi.advanceTimersByTimeAsync(5000)
    expect(drawer.tableReads()).toBe(1)
    drawer.close()
  })

  it('a table slower than a second holds back neither the answer nor its own next read', async () => {
    let rows = ['pod-a']
    const drawer = openDrawerWithTable(() => rows, 2500)
    await vi.advanceTimersByTimeAsync(100)
    rows = ['pod-a', 'pod-b']
    // the table's first read is under way and read the old rows
    drawer.frame('MODIFIED', { name: 'web', max: 2 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(drawer.reads()).toBe(2)
    expect(drawer.tableReads()).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(drawer.tableReads()).toBe(2)
    expect(drawer.rowsShown()).toEqual(['pod-a', 'pod-b'])
    drawer.close()
  })

  it('reads it for a change while it waits on an earlier read, once', async () => {
    let rows = ['pod-a']
    const drawer = openDrawerWithTable(() => rows, 2500)
    await vi.advanceTimersByTimeAsync(100)
    drawer.frame('MODIFIED', { name: 'web', max: 1 })
    await vi.advanceTimersByTimeAsync(1000)
    rows = ['pod-a', 'pod-b']
    drawer.frame('MODIFIED', { name: 'web', max: 2 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(drawer.tableReads()).toBe(2)
    expect(drawer.reads()).toBe(3)
    expect(drawer.rowsShown()).toEqual(['pod-a', 'pod-b'])
    drawer.close()
  })

  it('reads nothing once the drawer is closed', async () => {
    const drawer = openDrawerWithTable(() => ['pod-a'])
    await vi.advanceTimersByTimeAsync(0)
    drawer.frame('MODIFIED', { name: 'web', max: 2 })
    drawer.close()
    await vi.advanceTimersByTimeAsync(5000)
    expect(drawer.tableReads()).toBe(1)
  })

  it('a watch that lost its place reads the table again as well', async () => {
    let rows = ['pod-a']
    const drawer = openDrawerWithTable(() => rows)
    await vi.advanceTimersByTimeAsync(0)
    rows = ['pod-b']
    applyWatchMessage(drawer.client, describeKey, { type: 'RESYNC' }, undefined, undefined, drawer.follower.onResync)
    await vi.advanceTimersByTimeAsync(6001)
    expect(drawer.tableReads()).toBe(2)
    expect(drawer.rowsShown()).toEqual(['pod-b'])
    drawer.close()
  })

  it('the drawers hand the tables they read to their follower', () => {
    expect(limitRangeInfoSrc).toContain("alsoRead: [['limitrange-violations', namespace, name]],")
    expect(limitRangeInfoSrc).toContain("queryKey: ['limitrange-violations', namespace, name],")
    expect(crdInfoSrc).toContain("alsoRead: [['crd-instances', group, storageVersion, plural]],")
    expect(crdInfoSrc).toContain("queryKey: ['crd-instances', group, storageVersion, plural],")
    expect(followHookSrc).toContain('onResync: () => follower.current?.onResync(),')
  })
})

// A globalDefault conflict is about the other classes, which a watch of the drawer's own object never sees.
describe('the PriorityClass drawer\'s list of classes', () => {
  const key = ['all-priorityclasses']
  const row = (name: string, global_default: boolean) => ({ name, value: 1, global_default, preemption_policy: 'PreemptLowerPriority', description: '', labels: {}, created_at: '' })

  it('follows every class by its own watch, row for row, with nothing read again', () => {
    expect(priorityClassInfoSrc).toContain("queryKey: ['all-priorityclasses'],\n    path: '/apis/scheduling.k8s.io/v1/priorityclasses',")
    expect(priorityClassInfoSrc).toContain('applyEvent: (prev, event) => applyPriorityClassWatchEvent(prev as PriorityClassRow[] | undefined, event),')

    const client = new QueryClient()
    client.setQueryData(key, [row('this', true), row('other', false)])
    applyWatchMessage(client, key, { type: 'DATA', data: { type: 'MODIFIED', object: row('other', true) } }, (prev, event) => applyPriorityClassWatchEvent(prev as never, event))
    expect(client.getQueryData(key)).toEqual([row('this', true), row('other', true)])
    expect(client.getQueryState(key)?.isInvalidated).toBe(false)
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

  it('shares the list the page behind it already follows, of its namespace or of every namespace', () => {
    const path = '/apis/apps/v1/namespaces/shop/deployments'
    expect(openListOf(path, (p) => p === path)).toBe(path)
    expect(openListOf(path, (p) => p === '/apis/apps/v1/deployments')).toBe('/apis/apps/v1/deployments')
    expect(openListOf('/api/v1/namespaces/shop/limitranges', (p) => p === '/api/v1/limitranges')).toBe('/api/v1/limitranges')
    expect(openListOf('/apis/rbac.authorization.k8s.io/v1/clusterroles', (p) => p === '/apis/rbac.authorization.k8s.io/v1/clusterroles')).toBe('/apis/rbac.authorization.k8s.io/v1/clusterroles')
    expect(openListOf(path, () => false)).toBeNull()
  })

  it('hears only its own object on a shared list', () => {
    expect(frameOfObject({ object: { name: 'web', namespace: 'shop' } }, 'web', 'shop')).toBe(true)
    expect(frameOfObject({ object: { name: 'api', namespace: 'shop' } }, 'web', 'shop')).toBe(false)
    expect(frameOfObject({ object: { name: 'web', namespace: 'other' } }, 'web', 'shop')).toBe(false)
    expect(frameOfObject({ object: { metadata: { name: 'web', namespace: 'shop' } } }, 'web', 'shop')).toBe(true)
    expect(frameOfObject({ object: { name: 'admin' } }, 'admin', undefined)).toBe(true)
  })

  // A Lease's holder renews it every few seconds, faster than a read of its events is worth: the drawer reads on the clock.
  it('a Lease drawer reads its answer on the clock', () => {
    expect(leaseInfoSrc).toContain('refetchInterval: 5_000')
  })
})
