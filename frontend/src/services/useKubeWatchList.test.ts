import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { notifyManager, QueryClient, QueryObserver } from '@tanstack/react-query'
import { applyWatchMessage, frameHolder } from './useKubeWatchList'
import { applyLeaseWatchEvent } from '@/pages/cluster/leases/leaseWatchNormalize'
import leasesPageSrc from '@/pages/cluster/Leases.tsx?raw'

const key = ['workloads', 'pods', 'demo']
const frame = (type: string, extra: object = {}) => ({ type, clusterId: 'self', path: '/api/v1/pods', query: 'watch=1', ...extra })

describe('applyWatchMessage', () => {
  // A watch that starts over sends the objects there are, not those deleted while it was gone: only the list can tell.
  it('a RESYNC frame reads the list again and keeps its rows on screen until the answer comes', async () => {
    const client = new QueryClient()
    const queryFn = vi.fn(async () => (queryFn.mock.calls.length === 1 ? [{ name: 'deleted-meanwhile' }, { name: 'web' }] : [{ name: 'web' }]))
    const stop = new QueryObserver(client, { queryKey: key, queryFn }).subscribe(() => {})
    await vi.waitFor(() => expect(client.getQueryData(key)).toEqual([{ name: 'deleted-meanwhile' }, { name: 'web' }]))

    applyWatchMessage(client, key, frame('RESYNC'))
    expect(client.getQueryData(key)).toEqual([{ name: 'deleted-meanwhile' }, { name: 'web' }])

    await vi.waitFor(() => expect(client.getQueryData(key)).toEqual([{ name: 'web' }]))
    expect(queryFn).toHaveBeenCalledTimes(2)
    stop()
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
    const holder = frameHolder((message) => applyWatchMessage(client, leases, message, applyLeaseWatchEvent), 10)
    holder.push(frame('RESYNC'))
    expect(queryFn).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2))
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
