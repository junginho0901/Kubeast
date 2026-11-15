import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { applyHelmWatchEvent, followHelmReleases, helmStreamFrame } from './useHelmWatchList'
import type { HelmReleaseSummary } from './api'
import { clearWatchProblem, getWatchProblem, recordWatchFrame } from './watchProblemStore'

describe('what the Helm releases stream tells the watch problem notice', () => {
  const key = 'c\n/api/v1/helm/releases/stream?cluster=c'
  // as k8s-service's helm_watch.go writes it (helmLimitFrame)
  const limit = '{"limit_scope":"server","message":"max subscriptions reached for the server, cannot create new watch","reason":"limit"}'

  it('says the server\'s limit as a socket\'s refusal does, and clears it once the stream follows', () => {
    recordWatchFrame(key, helmStreamFrame('error', limit)!)
    expect(getWatchProblem()).toBe('server_limit')
    recordWatchFrame(key, helmStreamFrame('following', '{}')!)
    expect(getWatchProblem()).toBeUndefined()
  })

  it('leaves a start failure, plain text, to the log', () => {
    expect(helmStreamFrame('error', 'kubeconfig not loaded')).toBeUndefined()
    expect(helmStreamFrame('error', undefined)).toBeUndefined()
    clearWatchProblem(key)
  })
})

const rel = (name: string, revision: number, status = 'deployed'): HelmReleaseSummary => ({
  name, namespace: 'apps', revision, status, chart: 'web', chartVersion: '1.0.0', appVersion: '1.0', updated: '2026-11-02T00:00:00Z',
})

describe('applyHelmWatchEvent — each revision is its own Secret', () => {
  const shown = [rel('web', 12), rel('api', 3)]

  it('keeps a release when an older revision is pruned (--history-max)', () => {
    expect(applyHelmWatchEvent(shown, { type: 'DELETED', object: rel('web', 2, 'superseded') })).toEqual(shown)
  })

  it('removes a release when the revision on screen is deleted (uninstall)', () => {
    expect(applyHelmWatchEvent(shown, { type: 'DELETED', object: rel('web', 12) })).toEqual([rel('api', 3)])
  })

  it('takes a newer revision and leaves an older one', () => {
    expect(applyHelmWatchEvent(shown, { type: 'ADDED', object: rel('web', 13, 'pending-upgrade') })?.[0]).toEqual(rel('web', 13, 'pending-upgrade'))
    expect(applyHelmWatchEvent(shown, { type: 'MODIFIED', object: rel('web', 11, 'superseded') })).toEqual(shown)
  })

  it('adds a release it has not seen', () => {
    expect(applyHelmWatchEvent(shown, { type: 'ADDED', object: rel('db', 1) })).toEqual([...shown, rel('db', 1)])
  })
})

// A namespace just picked has no list yet; the stream for it may send a frame before the list answers.
describe('applyHelmWatchEvent — before the list has answered', () => {
  it('makes no list of the releases its frames name', () => {
    expect(applyHelmWatchEvent(undefined, { type: 'ADDED', object: rel('web', 3) })).toBeUndefined()
    expect(applyHelmWatchEvent(undefined, { type: 'MODIFIED', object: rel('web', 4) })).toBeUndefined()
    expect(applyHelmWatchEvent(undefined, { type: 'DELETED', object: rel('web', 4) })).toBeUndefined()
  })

  it('leaves the page\'s query with nothing, so it shows loading until the list answers', () => {
    const client = new QueryClient()
    const key = ['helm-releases', 'c', 'apps']
    client.setQueryData(key, (prev: HelmReleaseSummary[] | undefined) => applyHelmWatchEvent(prev, { type: 'ADDED', object: rel('web', 3) }))
    expect(client.getQueryData(key)).toBeUndefined()
    client.setQueryData(key, [rel('api', 1)])
    client.setQueryData(key, (prev: HelmReleaseSummary[] | undefined) => applyHelmWatchEvent(prev, { type: 'ADDED', object: rel('web', 3) }))
    expect(client.getQueryData(key)).toEqual([rel('api', 1), rel('web', 3)])
  })
})

// The browser's EventSource, as much of it as the stream uses: the server's events go to the listeners of their name.
class FakeEventSource {
  static CLOSED = 2
  static made: FakeEventSource[] = []
  readyState = 1
  onmessage: ((event: MessageEvent) => void) | null = null
  private listeners = new Map<string, ((event: MessageEvent) => void)[]>()
  constructor(public url: string) {
    FakeEventSource.made.push(this)
  }
  addEventListener(name: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
  }
  close() {
    this.readyState = FakeEventSource.CLOSED
  }
  // what helm_watch.go writes: a release's event as data, a named event with its data
  send(name: string, data: unknown) {
    const event = { data: JSON.stringify(data) } as MessageEvent
    if (name === 'message') this.onmessage?.(event)
    else this.listeners.get(name)?.forEach((listener) => listener(event))
  }
}

// The server keeps no version past its stream: a stream opened again, or opened on a list read before the last stream of
// it stopped, starts from none and sends the releases there are, not those uninstalled meanwhile.
describe('the Helm releases stream', () => {
  const listKey = ['helm-releases', 'c', '']
  const latest = () => FakeEventSource.made[FakeEventSource.made.length - 1]

  beforeEach(() => {
    FakeEventSource.made = []
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.useFakeTimers()
    // the reads a resync asks for at 2.5 s
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function page(client: QueryClient, queryFn: () => Promise<HelmReleaseSummary[]>, shown?: string[][], onResync?: () => void) {
    // the Releases page's query: never stale, the stream keeps it
    const stopObserver = new QueryObserver(client, { queryKey: listKey, queryFn, staleTime: Infinity }).subscribe((result) => {
      shown?.push(result.data?.map((row) => row.name) ?? [])
    })
    const stopStream = followHelmReleases(client, { cluster: 'c', queryKey: listKey, onResync: () => onResync })
    return () => {
      stopStream()
      stopObserver()
    }
  }
  const names = (client: QueryClient) => (client.getQueryData(listKey) as HelmReleaseSummary[]).map((row) => row.name)

  it('a release uninstalled while the stream was away is gone once the server says resync, the rows on screen until the read', async () => {
    const releases = new Map([['web', rel('web', 3)], ['db', rel('db', 1)]])
    const client = new QueryClient()
    const queryFn = vi.fn(async () => [...releases.values()])
    const shown: string[][] = []
    const stop = page(client, queryFn, shown)
    await vi.advanceTimersByTimeAsync(0)
    expect(names(client)).toEqual(['web', 'db'])
    // what is drawn from here on
    shown.length = 0

    // the browser opened the stream again by itself; the new stream sends what there is, and resync once its watch is on
    releases.delete('db')
    latest().send('resync', {})
    latest().send('message', { type: 'ADDED', object: rel('web', 3) })
    expect(names(client)).toEqual(['web', 'db'])
    expect(queryFn).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5000)
    expect(queryFn).toHaveBeenCalledTimes(2)
    expect(names(client)).toEqual(['web'])
    expect(shown.length).toBeGreaterThan(0)
    expect(shown.every((rows) => rows.length > 0)).toBe(true)
    stop()
  })

  it('a page that reads its list its own way reads it so, once, and the list is not invalidated beside it', async () => {
    const client = new QueryClient()
    const queryFn = vi.fn(async () => [rel('web', 3)])
    const readAgain = vi.fn()
    const stop = page(client, queryFn, undefined, readAgain)
    await vi.advanceTimersByTimeAsync(0)
    latest().send('resync', {})
    latest().send('resync', {})
    await vi.advanceTimersByTimeAsync(5000)
    expect(readAgain).toHaveBeenCalledTimes(1)
    expect(queryFn).toHaveBeenCalledTimes(1)
    stop()
  })

  // Leaving the Releases page and coming back shows the cached list, which staleTime Infinity never reads again.
  it('a stream opened on a list read before the last stream of it stopped asks for resync=1, and one on a list read since does not', async () => {
    const client = new QueryClient()
    const queryFn = vi.fn(async () => [rel('web', 3)])
    const away = page(client, queryFn)
    await vi.advanceTimersByTimeAsync(0)
    expect(latest().url).toBe('/api/v1/helm/releases/stream?cluster=c')
    away()
    await vi.advanceTimersByTimeAsync(60_000)

    const back = page(client, queryFn)
    await vi.advanceTimersByTimeAsync(0)
    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(latest().url).toBe('/api/v1/helm/releases/stream?cluster=c&resync=1')
    back()

    await vi.advanceTimersByTimeAsync(1000)
    await client.fetchQuery({ queryKey: listKey, queryFn, staleTime: 0 })
    const again = page(client, queryFn)
    await vi.advanceTimersByTimeAsync(0)
    expect(latest().url).toBe('/api/v1/helm/releases/stream?cluster=c')
    again()
  })

  it('no read is left waiting once the page has gone', async () => {
    const client = new QueryClient()
    const queryFn = vi.fn(async () => [rel('web', 3)])
    const stop = page(client, queryFn)
    await vi.advanceTimersByTimeAsync(0)
    latest().send('resync', {})
    stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(latest().readyState).toBe(FakeEventSource.CLOSED)
  })
})
