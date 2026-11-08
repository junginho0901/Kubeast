import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { focusManager, notifyManager, QueryClient, QueryObserver } from '@tanstack/react-query'
import { applyWatchFrames, applyWatchMessage, followList, frameHolder } from './useKubeWatchList'
import { watchMultiplexer } from './watchMultiplexer'
import { applyLeaseWatchEvent } from '@/pages/cluster/leases/leaseWatchNormalize'
import { applyReplicaSetWatchEvent } from '@/pages/workloads/replicasets/replicaSetWatchNormalize'
import { applyJobWatchEvent } from '@/pages/workloads/jobs/jobWatchNormalize'
import { applySecretWatchEvent } from '@/pages/configuration/secrets/secretWatchNormalize'
import { applyConfigMapWatchEvent } from '@/pages/configuration/configmaps/configMapWatchNormalize'
import leasesPageSrc from '@/pages/cluster/Leases.tsx?raw'
import replicaSetsPageSrc from '@/pages/workloads/ReplicaSets.tsx?raw'
import jobsPageSrc from '@/pages/workloads/Jobs.tsx?raw'
import secretsPageSrc from '@/pages/configuration/Secrets.tsx?raw'
import configMapsPageSrc from '@/pages/configuration/ConfigMaps.tsx?raw'

const key = ['workloads', 'pods', 'demo']
const frame = (type: string, extra: object = {}) => ({ type, clusterId: 'self', path: '/api/v1/pods', query: 'watch=1', ...extra })

describe('applyWatchMessage', () => {
  // A watch that starts over sends the objects there are, not those deleted while it was gone: only the list can tell.
  it('a RESYNC frame reads the list again and keeps its rows on screen until the answer comes', async () => {
    vi.useFakeTimers()
    try {
      const client = new QueryClient()
      const queryFn = vi.fn(async () => (queryFn.mock.calls.length === 1 ? [{ name: 'deleted-meanwhile' }, { name: 'web' }] : [{ name: 'web' }]))
      const stop = new QueryObserver(client, { queryKey: key, queryFn }).subscribe(() => {})
      await vi.advanceTimersByTimeAsync(0)
      expect(client.getQueryData(key)).toEqual([{ name: 'deleted-meanwhile' }, { name: 'web' }])

      applyWatchMessage(client, key, frame('RESYNC'))
      expect(client.getQueryData(key)).toEqual([{ name: 'deleted-meanwhile' }, { name: 'web' }])

      await vi.advanceTimersByTimeAsync(5000)
      expect(client.getQueryData(key)).toEqual([{ name: 'web' }])
      expect(queryFn).toHaveBeenCalledTimes(2)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  // Every watch of a server that came back starts over at one moment: each browser's read of its lists waits its own time.
  it('a RESYNC frame spreads its read over some seconds, the rows staying as they were meanwhile', async () => {
    vi.useFakeTimers()
    try {
      const reads: number[] = []
      const random = vi.spyOn(Math, 'random')
      for (const r of [0, 0.25, 0.5, 0.75, 0.9999]) {
        random.mockReturnValue(r)
        const client = new QueryClient()
        const started = Date.now()
        let answered = 0
        const stop = new QueryObserver(client, {
          queryKey: key,
          queryFn: async () => {
            answered += 1
            if (answered === 2) reads.push(Date.now() - started)
            return [{ name: 'web' }]
          },
        }).subscribe(() => {})
        await vi.advanceTimersByTimeAsync(0)
        applyWatchMessage(client, key, frame('RESYNC'))
        await vi.advanceTimersByTimeAsync(5001)
        stop()
      }
      expect(reads).toHaveLength(5)
      expect(Math.max(...reads) - Math.min(...reads)).toBeGreaterThanOrEqual(3000)
    } finally {
      vi.useRealTimers()
      vi.restoreAllMocks()
    }
  })

  it('a read asked for by hand does not wait for a RESYNC beside it', async () => {
    vi.useFakeTimers()
    try {
      vi.spyOn(Math, 'random').mockReturnValue(0.9999)
      const client = new QueryClient()
      const queryFn = vi.fn(async () => [{ name: 'web' }])
      const stop = new QueryObserver(client, { queryKey: key, queryFn }).subscribe(() => {})
      await vi.advanceTimersByTimeAsync(0)
      applyWatchMessage(client, key, frame('RESYNC'))
      void client.invalidateQueries({ queryKey: key })
      await vi.advanceTimersByTimeAsync(0)
      expect(queryFn).toHaveBeenCalledTimes(2)
      stop()
    } finally {
      vi.useRealTimers()
      vi.restoreAllMocks()
    }
  })

  it('a DATA frame changes the row it names and reads nothing again', () => {
    const client = new QueryClient()
    client.setQueryData(key, [{ name: 'web', status: 'Pending' }])
    const onEvent = vi.fn()
    const data = { type: 'MODIFIED', object: { name: 'web', status: 'Running' } }
    applyWatchMessage(client, key, frame('DATA', { data }), undefined, onEvent)
    expect(client.getQueryData(key)).toEqual([{ name: 'web', status: 'Running' }])
    expect(client.getQueryState(key)?.isInvalidated).toBe(false)
    expect(onEvent).toHaveBeenCalledWith(data)
  })

  it('a DATA frame before the list has come is left for the list to answer', () => {
    const client = new QueryClient()
    applyWatchMessage(client, key, frame('DATA', { data: { type: 'ADDED', object: { name: 'web' } } }))
    expect(client.getQueryData(key)).toBeUndefined()
  })

  it('an ERROR frame leaves the list as it is', () => {
    const client = new QueryClient()
    client.setQueryData(key, [{ name: 'web' }])
    applyWatchMessage(client, key, frame('ERROR', { error: { message: 'forbidden' } }))
    expect(client.getQueryData(key)).toEqual([{ name: 'web' }])
    expect(client.getQueryState(key)?.isInvalidated).toBe(false)
  })
})

describe('a row a live update adds', () => {
  const list = ['workloads', 'deployments', 'all']
  const namesOf = (client: QueryClient) => (client.getQueryData(list) as Array<{ namespace?: string; name: string }>).map((r) => `${r.namespace ?? ''}/${r.name}`)
  const added = (object: object) => frame('DATA', { data: { type: 'ADDED', object } })

  it('goes where the list\'s next read puts it, by namespace and name as the API server lists them', () => {
    const client = new QueryClient()
    client.setQueryData(list, [{ namespace: 'a', name: 'web' }, { namespace: 'c', name: 'api' }, { namespace: 'c', name: 'web' }])
    applyWatchMessage(client, list, added({ namespace: 'c', name: 'db' }))
    expect(namesOf(client)).toEqual(['a/web', 'c/api', 'c/db', 'c/web'])
    applyWatchMessage(client, list, added({ namespace: 'b', name: 'zeta' }))
    expect(namesOf(client)).toEqual(['a/web', 'b/zeta', 'c/api', 'c/db', 'c/web'])
    applyWatchMessage(client, list, added({ namespace: 'd', name: 'last' }))
    expect(namesOf(client)).toEqual(['a/web', 'b/zeta', 'c/api', 'c/db', 'c/web', 'd/last'])
  })

  it('reads the name and namespace of a row in the object\'s own shape too', () => {
    const client = new QueryClient()
    client.setQueryData(list, [{ metadata: { name: 'a' } }, { metadata: { name: 'c' } }])
    applyWatchMessage(client, list, added({ metadata: { name: 'b' } }))
    expect((client.getQueryData(list) as Array<{ metadata: { name: string } }>).map((r) => r.metadata.name)).toEqual(['a', 'b', 'c'])
  })

  it('a row a list has already stays in its place, and so does the one it replaces', () => {
    const client = new QueryClient()
    client.setQueryData(list, [{ name: 'a', v: 1 }, { name: 'b', v: 1 }])
    applyWatchMessage(client, list, frame('DATA', { data: { type: 'MODIFIED', object: { name: 'b', v: 2 } } }))
    expect(client.getQueryData(list)).toEqual([{ name: 'a', v: 1 }, { name: 'b', v: 2 }])
    applyWatchMessage(client, list, frame('DATA', { data: { type: 'DELETED', object: { name: 'a' } } }))
    expect(client.getQueryData(list)).toEqual([{ name: 'b', v: 2 }])
  })

  // The frames a watch opens with name what the list holds: they must not move a row or cost a search for a place.
  it('leaves the same array when a frame says what the list already says', () => {
    const client = new QueryClient()
    const rows = [{ name: 'a' }, { name: 'b' }]
    client.setQueryData(list, rows)
    const before = client.getQueryData(list)
    applyWatchMessage(client, list, frame('DATA', { data: { type: 'ADDED', object: { name: 'b' } } }))
    expect(client.getQueryData(list)).toBe(before)
  })

  it('stays last in a list a custom apply keeps in another order, when it does not add at the end', () => {
    const client = new QueryClient()
    client.setQueryData(list, [{ name: 'b' }, { name: 'c' }])
    applyWatchMessage(client, list, added({ name: 'a' }), (prev, event) => [event.object, ...(prev ?? [])])
    expect((client.getQueryData(list) as Array<{ name: string }>).map((r) => r.name)).toEqual(['a', 'b', 'c'])
  })
})

describe('a list whose objects write themselves all the time', () => {
  const leases = ['cluster', 'leases', 'all']
  const lease = (name: string, renewed: string) => ({ name, namespace: 'kube-node-lease', created_at: '2026-11-01T00:00:00Z', holder_identity: name, renew_time: renewed })
  const renewals = (count: number, renewed: string) =>
    Array.from({ length: count }, (_, i) => frame('DATA', { data: { type: 'MODIFIED', object: lease(`node-${i}`, renewed) } }))

  let drawings = 0
  beforeEach(() => {
    drawings = 0
    // what the screen does on a change: React draws once for what comes in one batch of notifications
    notifyManager.setBatchNotifyFunction((callback) => {
      drawings += 1
      callback()
    })
  })
  afterEach(() => {
    notifyManager.setBatchNotifyFunction((callback) => callback())
  })

  const openList = () => {
    const client = new QueryClient()
    client.setQueryData(leases, Array.from({ length: 100 }, (_, i) => lease(`node-${i}`, '2026-11-06T11:59:50Z')))
    const observer = new QueryObserver(client, { queryKey: leases, enabled: false })
    const stop = observer.subscribe(notifyManager.batchCalls(() => {}))
    const deliver = (message: unknown) => applyWatchMessage(client, leases, message, applyLeaseWatchEvent)
    return { client, deliver, stop }
  }
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  // past the holder's time, then past what its delivery scheduled, whichever order a late timer ran them in
  const settled = async () => {
    await sleep(30)
    await sleep(5)
  }

  // A watch opens with every object as ADDED, which the list has just said: the rows keep their identity, and a table that
  // reads them has nothing to draw again. It takes a frame that is the list's row, which is why the rows are held to it.
  it('the frames a watch opens with leave the rows as they were', async () => {
    const { client, deliver, stop } = openList()
    const before = client.getQueryData(leases)
    for (let i = 0; i < 100; i++) {
      deliver(frame('DATA', { data: { type: 'ADDED', object: lease(`node-${i}`, '2026-11-06T11:59:50Z') } }))
    }
    expect(client.getQueryData(leases)).toBe(before)
    // what these frames scheduled is done before the next test counts its drawings
    await settled()
    stop()
  })

  it('frames that come within the time are drawn once, each row at its last', async () => {
    const { client, deliver, stop } = openList()
    const holder = frameHolder(deliver, 10)
    for (const f of renewals(100, '2026-11-06T12:00:00Z')) holder.push(f)
    holder.push(frame('DATA', { data: { type: 'MODIFIED', object: lease('node-7', '2026-11-06T12:00:01Z') } }))
    expect((client.getQueryData(leases) as { renew_time: string }[])[7].renew_time).toBe('2026-11-06T11:59:50Z')
    await settled()
    const rows = client.getQueryData(leases) as { name: string; renew_time: string }[]
    expect(rows).toHaveLength(100)
    expect(rows[7].renew_time).toBe('2026-11-06T12:00:01Z')
    expect(rows[8].renew_time).toBe('2026-11-06T12:00:00Z')
    expect(drawings).toBe(1)
    holder.stop()
    stop()
  })

  // Why they are gathered: frames of a socket come one by one, and each makes a drawing of the whole table.
  it('frames delivered one by one are drawn one by one', async () => {
    const { deliver, stop } = openList()
    for (const f of renewals(100, '2026-11-06T12:00:00Z')) deliver(f)
    await settled()
    expect(drawings).toBe(100)
    stop()
  })

  it('an object deleted and one made among them go and come, in order', async () => {
    const { client, deliver, stop } = openList()
    const holder = frameHolder(deliver, 10)
    holder.push(frame('DATA', { data: { type: 'MODIFIED', object: lease('node-1', '2026-11-06T12:00:00Z') } }))
    holder.push(frame('DATA', { data: { type: 'DELETED', object: lease('node-1', '2026-11-06T12:00:00Z') } }))
    holder.push(frame('DATA', { data: { type: 'ADDED', object: lease('node-new', '2026-11-06T12:00:00Z') } }))
    await settled()
    const names = (client.getQueryData(leases) as { name: string }[]).map((r) => r.name)
    expect(names).not.toContain('node-1')
    expect(names[names.length - 1]).toBe('node-new')
    holder.stop()
    stop()
  })

  it('a RESYNC among them reads the list again', async () => {
    const client = new QueryClient()
    const queryFn = vi.fn(async () => [lease('node-0', '2026-11-06T12:00:00Z')])
    const stop = new QueryObserver(client, { queryKey: leases, queryFn }).subscribe(() => {})
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1))
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const holder = frameHolder((message) => applyWatchMessage(client, leases, message, applyLeaseWatchEvent), 10)
    holder.push(frame('RESYNC'))
    expect(queryFn).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2))
    vi.restoreAllMocks()
    holder.stop()
    stop()
  })

  it('what is held when the list goes away is not applied', async () => {
    const { client, deliver, stop } = openList()
    const holder = frameHolder(deliver, 10)
    holder.push(frame('DATA', { data: { type: 'DELETED', object: lease('node-1', '2026-11-06T12:00:00Z') } }))
    holder.stop()
    await settled()
    expect((client.getQueryData(leases) as unknown[])).toHaveLength(100)
    stop()
  })

  it('the Leases list gathers its frames, a second at a time', () => {
    expect(leasesPageSrc).toContain('gatherEveryMs: 1000')
  })
})

describe('a list that opens with thousands of objects', () => {
  const NS = 'demo'
  const rsRow = (i: number, ready = 2) => ({
    name: `rs-${i}`, namespace: NS, replicas: 2, current_replicas: 2, ready_replicas: ready, available_replicas: ready, image: 'example.test/app:1', images: ['example.test/app:1'],
    containers: ['app'], owner_deployment: 'web', owner_references: [{ kind: 'Deployment', name: 'web', uid: 'u', controller: true }], labels: { app: 'web' }, selector: { app: 'web' },
    created_at: '2026-11-01T00:00:00Z', status: 'Ready',
  })
  const added = (object: object) => frame('DATA', { data: { type: 'ADDED', object } })
  const listKey = ['workloads', 'replicasets', NS]

  function openList(rows: object[]) {
    const client = new QueryClient()
    client.setQueryData(listKey, rows)
    let notified = 0
    const stop = new QueryObserver(client, { queryKey: listKey, enabled: false }).subscribe(() => { notified += 1 })
    return { client, stop, notified: () => notified }
  }
  const apply = (prev: any, event: any) => applyReplicaSetWatchEvent(prev, event)
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  it('frames gathered in one delivery change the list once, whichever their number', async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => rsRow(i))
    const { client, stop } = openList(rows)
    const setQueryData = vi.spyOn(client, 'setQueryData')
    applyWatchFrames(client, listKey, rows.map((row) => added({ ...row })), apply)
    expect(setQueryData).toHaveBeenCalledTimes(1)
    await sleep(5)
    stop()
  })

  // Measured when WATCH_BENCH is set; the number is not held here, as a laptop's times move.
  it('the rows of 2000 frames equal to the list stay the same array, so nothing is drawn again', async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => rsRow(i))
    const { client, stop, notified } = openList(rows)
    const before = client.getQueryData(listKey)
    const started = performance.now()
    applyWatchFrames(client, listKey, rows.map((row) => added({ ...row })), apply)
    const merged = performance.now() - started
    expect(client.getQueryData(listKey)).toBe(before)
    await sleep(5)
    expect(notified()).toBeLessThanOrEqual(1)
    stop()

    if (process.env.WATCH_BENCH) {
      for (const size of [500, 2000, 5000, 20000]) {
        const big = Array.from({ length: size }, (_, i) => rsRow(i))
        const one = openList(big)
        const frames = big.map((row) => added({ ...row }))
        const t0 = performance.now()
        for (const f of frames) applyWatchMessage(one.client, listKey, f, apply)
        const t1 = performance.now()
        one.stop()
        const all = openList(big)
        const t2 = performance.now()
        applyWatchFrames(all.client, listKey, frames, apply)
        const t3 = performance.now()
        all.stop()
        // ConfigMaps and Secrets ask for each object's describe again, with a page's worth of other queries in the cache
        const withDescribes = openList(big)
        for (let i = 0; i < 100; i += 1) withDescribes.client.setQueryData(['other', i], i)
        const t4 = performance.now()
        applyWatchFrames(withDescribes.client, listKey, frames, apply, (event) => {
          void withDescribes.client.invalidateQueries({ queryKey: ['configmap-describe', event.object.namespace, event.object.name] })
        })
        const t5 = performance.now()
        withDescribes.stop()
        console.info(`bench rows=${size} one-by-one=${(t1 - t0).toFixed(1)}ms gathered=${(t3 - t2).toFixed(1)}ms gathered-with-describes=${(t5 - t4).toFixed(1)}ms`)
      }
      console.info(`bench first run 2000 gathered=${merged.toFixed(1)}ms`)
    }
  })

  it('applied together they leave what one by one leaves: changed rows, order, deletes and new rows', () => {
    const rows = Array.from({ length: 6 }, (_, i) => rsRow(i))
    const frames = [
      frame('DATA', { data: { type: 'MODIFIED', object: rsRow(1, 0) } }),
      frame('DATA', { data: { type: 'DELETED', object: rsRow(2) } }),
      added(rsRow(9)),
      frame('DATA', { data: { type: 'MODIFIED', object: rsRow(1, 1) } }),
      frame('DATA', { data: { type: 'DELETED', object: rsRow(0) } }),
      added(rsRow(0)),
      frame('DATA', { data: { type: 'DELETED', object: rsRow(9) } }),
      added(rsRow(7)),
      frame('DATA', { data: { type: 'DELETED', object: rsRow(99) } }),
      frame('DATA', { data: { type: 'MODIFIED' } }),
    ]
    const one = openList(rows)
    for (const f of frames) applyWatchMessage(one.client, listKey, f, apply)
    const all = openList(rows)
    applyWatchFrames(all.client, listKey, frames, apply)
    expect(all.client.getQueryData(listKey)).toEqual(one.client.getQueryData(listKey))
    expect((all.client.getQueryData(listKey) as { name: string }[]).map((r) => r.name)).toEqual(['rs-0', 'rs-1', 'rs-3', 'rs-4', 'rs-5', 'rs-7'])
    one.stop()
    all.stop()
  })

  it('new rows go where the next read puts them, however many come together', () => {
    const rows = ['b', 'd', 'f'].map((name) => ({ name, namespace: NS }))
    const frames = ['z', 'a', 'e', 'c', 'g'].map((name) => added({ name, namespace: NS }))
    const one = openList(rows)
    for (const f of frames) applyWatchMessage(one.client, listKey, f)
    const all = openList(rows)
    applyWatchFrames(all.client, listKey, frames)
    expect((all.client.getQueryData(listKey) as { name: string }[]).map((r) => r.name)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'z'])
    expect(all.client.getQueryData(listKey)).toEqual(one.client.getQueryData(listKey))
    one.stop()
    all.stop()
  })

  it('frames a drawer only listens to reach onEvent and write nothing to the query', () => {
    const rows = [rsRow(0)]
    const { client, stop } = openList(rows)
    const onEvent = vi.fn()
    applyWatchFrames(client, listKey, [frame('DATA', { data: { type: 'MODIFIED', object: rsRow(0, 0) } })], apply, onEvent, undefined, true)
    expect(client.getQueryData(listKey)).toEqual(rows)
    expect(onEvent).toHaveBeenCalledTimes(1)
    stop()
  })

  it('each kind that gathers its frames applies them as it does one by one', () => {
    const rows: Record<string, { apply: (prev: any, event: any) => any[]; row: (i: number) => object }> = {
      job: { apply: applyJobWatchEvent, row: (i) => ({ name: `j-${i}`, namespace: NS, status: 'Running', completions: 1, succeeded: 0, failed: 0, active: 1 }) },
      secret: { apply: applySecretWatchEvent, row: (i) => ({ name: `s-${i}`, namespace: NS, type: 'Opaque', data_keys: ['a'] }) },
      configmap: { apply: applyConfigMapWatchEvent, row: (i) => ({ name: `c-${i}`, namespace: NS, data_keys: ['a'], data_count: 1 }) },
    }
    for (const [kind, { apply: applyKind, row }] of Object.entries(rows)) {
      const start = [row(0), row(1), row(2)]
      const frames = [added(row(1)), frame('DATA', { data: { type: 'DELETED', object: row(0) } }), added(row(3))]
      const one = openList(start)
      for (const f of frames) applyWatchMessage(one.client, listKey, f, applyKind)
      const all = openList(start)
      applyWatchFrames(all.client, listKey, frames, applyKind)
      expect(all.client.getQueryData(listKey), kind).toEqual(one.client.getQueryData(listKey))
      one.stop()
      all.stop()
    }
  })

  it('a RESYNC among them comes in its place, and each frame still reaches onEvent', async () => {
    vi.useFakeTimers()
    try {
      const rows = [rsRow(0)]
      const { client, stop } = openList(rows)
      const onEvent = vi.fn()
      const onResync = vi.fn()
      const invalidate = vi.spyOn(client, 'invalidateQueries')
      applyWatchFrames(client, listKey, [added(rsRow(1)), frame('RESYNC'), added(rsRow(2))], apply, onEvent, onResync)
      expect((client.getQueryData(listKey) as unknown[])).toHaveLength(3)
      expect(onEvent).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(5000)
      expect(invalidate).toHaveBeenCalledTimes(1)
      expect(onResync).toHaveBeenCalledTimes(1)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a frame before the list has come is left for the list to answer', () => {
    const client = new QueryClient()
    const onEvent = vi.fn()
    applyWatchFrames(client, listKey, [added(rsRow(1))], apply, onEvent)
    expect(client.getQueryData(listKey)).toBeUndefined()
    expect(onEvent).toHaveBeenCalledTimes(1)
  })

  it('ReplicaSets, Jobs, Secrets and ConfigMaps gather their frames', () => {
    for (const src of [replicaSetsPageSrc, jobsPageSrc, secretsPageSrc, configMapsPageSrc]) expect(src).toContain('gatherEveryMs: LIST_GATHER_MS')
  })
})

describe('a list the server has no room to follow', () => {
  const listKey = ['configuration', 'configmaps', 'demo']
  const refused = (path = '/api/v1/namespaces/demo/configmaps') => frame('ERROR', { path, error: { message: 'max subscriptions reached for the server (2000), cannot create new watch', reason: 'limit' } })
  const frames = new Map<string, (message: unknown) => void>()
  let closed: (() => void) | undefined

  function follow(paths = ['/api/v1/namespaces/demo/configmaps'], onAnswering?: (answers: boolean) => void) {
    const client = new QueryClient()
    const queryFn = vi.fn(async () => [{ name: 'web', namespace: 'demo' }])
    const stopObserver = new QueryObserver(client, { queryKey: listKey, queryFn }).subscribe(() => {})
    const stopList = followList(client, { clusterId: 'self', paths, query: 'watch=1', queryKey: listKey, onAnswering: () => onAnswering })
    return { client, queryFn, stop: () => { stopList(); stopObserver() } }
  }

  beforeEach(() => {
    frames.clear()
    closed = undefined
    vi.useFakeTimers()
    vi.spyOn(watchMultiplexer, 'subscribe').mockImplementation(async (msg, listener) => {
      frames.set(msg.path, listener as (message: unknown) => void)
      return () => {}
    })
    vi.spyOn(watchMultiplexer, 'unsubscribe').mockImplementation(() => {})
    vi.spyOn(watchMultiplexer, 'onSocketClosed').mockImplementation((listener: () => void) => {
      closed = listener
      return () => { closed = undefined }
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    focusManager.setFocused(undefined)
  })

  it('is read about once a minute until the server has room, and not at all while it does', async () => {
    const list = follow()
    await vi.advanceTimersByTimeAsync(0)
    expect(list.queryFn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(list.queryFn).toHaveBeenCalledTimes(1)

    frames.get('/api/v1/namespaces/demo/configmaps')!(refused())
    list.queryFn.mockClear()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(list.queryFn.mock.calls.length).toBeGreaterThanOrEqual(4)
    expect(list.queryFn.mock.calls.length).toBeLessThanOrEqual(7)

    frames.get('/api/v1/namespaces/demo/configmaps')!(frame('DATA', { path: '/api/v1/namespaces/demo/configmaps', data: { type: 'ADDED', object: { name: 'web', namespace: 'demo' } } }))
    list.queryFn.mockClear()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(list.queryFn).toHaveBeenCalledTimes(0)
    list.stop()
  })

  it('goes on being read while one of its namespaces is refused and another answers', async () => {
    const a = '/api/v1/namespaces/a/configmaps'
    const b = '/api/v1/namespaces/b/configmaps'
    const list = follow([a, b])
    await vi.advanceTimersByTimeAsync(0)
    frames.get(b)!(refused(b))
    frames.get(a)!(frame('DATA', { path: a, data: { type: 'ADDED', object: { name: 'web', namespace: 'a' } } }))
    list.queryFn.mockClear()
    await vi.advanceTimersByTimeAsync(100_000)
    expect(list.queryFn.mock.calls.length).toBeGreaterThanOrEqual(1)
    list.stop()
  })

  it('reads nothing in a hidden tab', async () => {
    const list = follow()
    await vi.advanceTimersByTimeAsync(0)
    frames.get('/api/v1/namespaces/demo/configmaps')!(refused())
    focusManager.setFocused(false)
    list.queryFn.mockClear()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(list.queryFn).toHaveBeenCalledTimes(0)
    list.stop()
  })

  it('forgets the refusal when its socket closes, as the next socket is told again', async () => {
    const list = follow()
    await vi.advanceTimersByTimeAsync(0)
    frames.get('/api/v1/namespaces/demo/configmaps')!(refused())
    closed!()
    list.queryFn.mockClear()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(list.queryFn).toHaveBeenCalledTimes(0)
    list.stop()
  })

  it('reads nothing once the list is gone', async () => {
    const list = follow()
    await vi.advanceTimersByTimeAsync(0)
    frames.get('/api/v1/namespaces/demo/configmaps')!(refused())
    list.stop()
    list.queryFn.mockClear()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(list.queryFn).toHaveBeenCalledTimes(0)
  })

  it('a refusal of another kind is not read on the clock', async () => {
    const list = follow()
    await vi.advanceTimersByTimeAsync(0)
    frames.get('/api/v1/namespaces/demo/configmaps')!(frame('ERROR', { path: '/api/v1/namespaces/demo/configmaps', error: { message: 'nope', reason: 'forbidden' } }))
    list.queryFn.mockClear()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(list.queryFn).toHaveBeenCalledTimes(0)
    list.stop()
  })

  it('a refusal of another kind after the limit leaves the clock too: the limit no longer decides', async () => {
    const path = '/api/v1/namespaces/demo/configmaps'
    const list = follow()
    await vi.advanceTimersByTimeAsync(0)
    frames.get(path)!(refused())
    frames.get(path)!(frame('ERROR', { path, error: { message: 'nope', reason: 'forbidden' } }))
    list.queryFn.mockClear()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(list.queryFn).toHaveBeenCalledTimes(0)
    list.stop()
  })

  it('says the watch answers at once when it joins one a frame has answered, as no frame will say so', async () => {
    const answers: boolean[] = []
    const asked = vi.spyOn(watchMultiplexer, 'answers').mockReturnValue(true)
    const list = follow(undefined, (value) => answers.push(value))
    expect(answers).toEqual([true])
    expect(asked).toHaveBeenCalledWith('self', '/api/v1/namespaces/demo/configmaps', 'watch=1')
    list.stop()
  })

  it('does not say so while a namespace of its grant has not answered', async () => {
    const answers: boolean[] = []
    vi.spyOn(watchMultiplexer, 'answers').mockImplementation((_cluster, path) => path === '/api/v1/namespaces/a/configmaps')
    const list = follow(['/api/v1/namespaces/a/configmaps', '/api/v1/namespaces/b/configmaps'], (value) => answers.push(value))
    expect(answers).toEqual([])
    list.stop()
  })

  it('says whether the watch answers: a frame yes, a refusal or a closed socket no', async () => {
    const answers: boolean[] = []
    const list = follow(undefined, (value) => answers.push(value))
    await vi.advanceTimersByTimeAsync(0)
    const deliver = frames.get('/api/v1/namespaces/demo/configmaps')!
    deliver(frame('DATA', { data: { type: 'ADDED', object: { name: 'web', namespace: 'demo' } } }))
    deliver(frame('ERROR', { error: { message: 'x', reason: 'not_served' } }))
    deliver(frame('RESYNC'))
    closed!()
    expect(answers).toEqual([true, false, true, false])
    list.stop()
  })

  it('a RESYNC waiting for its time is forgotten with the list', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9999)
    const list = follow()
    await vi.advanceTimersByTimeAsync(0)
    frames.get('/api/v1/namespaces/demo/configmaps')!(frame('RESYNC'))
    list.stop()
    list.queryFn.mockClear()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(list.queryFn).toHaveBeenCalledTimes(0)
  })
})
