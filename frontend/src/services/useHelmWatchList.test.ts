import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryObserver, notifyManager } from '@tanstack/react-query'
import { applyHelmWatchEvent, followHelmReleases, helmStreamFrame } from './useHelmWatchList'
import type { HelmReleaseSummary } from './api'
import { clearWatchProblem, getWatchProblem, recordWatchFrame } from './watchProblemStore'
import { refreshList } from '@/hooks/useRefresh'

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

  // The browser does not open again a stream whose answer was not one, and EventSource does not say the status: one GET
  // of the stream says it. 200 opens it again with resync=1, after a wait that grows and starts over once it follows.
  const STREAM = '/api/v1/helm/releases/stream?cluster=c&resync=1'
  const closedForGood = () => {
    latest().readyState = FakeEventSource.CLOSED
    latest().send('error', undefined)
  }
  function answering(stream: () => number, me = 200) {
    const asked: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      asked.push(String(url))
      if (url === '/api/v1/auth/me') return new Response('{}', { status: me })
      if (url.startsWith('/api/v1/auth/logout')) return new Response('{}')
      const status = stream()
      return new Response(status === 403 ? '{"detail":"no resource.helm.read on cluster c"}' : null, { status })
    }))
    return asked
  }

  it('a stream the browser closed for good is opened again after a wait that grows, and not after the page has gone', async () => {
    const asked = answering(() => 200)
    const client = new QueryClient()
    const queryFn = vi.fn(async () => [rel('web', 3)])
    const stop = page(client, queryFn)
    await vi.advanceTimersByTimeAsync(0)

    closedForGood()
    await vi.advanceTimersByTimeAsync(700)
    expect(FakeEventSource.made).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(100) // 750 ms: half of 1 s and half of the other half
    expect(asked).toEqual([STREAM])
    expect(FakeEventSource.made).toHaveLength(2)
    expect(latest().url).toBe(STREAM)

    closedForGood()
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeEventSource.made).toHaveLength(2) // the second wait is longer: 1.5 s
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeEventSource.made).toHaveLength(3)

    latest().send('following', {})
    closedForGood()
    await vi.advanceTimersByTimeAsync(750)
    expect(FakeEventSource.made).toHaveLength(4) // followed again: the wait starts over

    closedForGood()
    stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeEventSource.made).toHaveLength(4)
  })

  it('a stream answered 503 (the session cannot be checked) waits again, longer, and opens once it is answered', async () => {
    const answers = [503, 503, 200]
    const asked = answering(() => answers.shift() ?? 200)
    const stop = page(new QueryClient(), vi.fn(async () => [rel('web', 3)]))
    await vi.advanceTimersByTimeAsync(0)
    closedForGood()
    await vi.advanceTimersByTimeAsync(750)
    expect(FakeEventSource.made).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1500)
    expect(FakeEventSource.made).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(asked).toEqual([STREAM, STREAM, STREAM])
    expect(FakeEventSource.made).toHaveLength(2)
    stop()
  })

  it('a stream refused (403) stops and says so as a watch refused, asked no more', async () => {
    const asked = answering(() => 403)
    const stop = page(new QueryClient(), vi.fn(async () => [rel('web', 3)]))
    await vi.advanceTimersByTimeAsync(0)
    closedForGood()
    await vi.advanceTimersByTimeAsync(750)
    expect(getWatchProblem()).toBe('forbidden')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(asked).toEqual([STREAM])
    expect(FakeEventSource.made).toHaveLength(1)
    stop()
    expect(getWatchProblem()).toBeUndefined()
  })

  it('a stream answered 401 asks whether the session is over, as a live connection ended by its session does', async () => {
    const assign = vi.fn()
    vi.stubGlobal('window', {
      location: { pathname: '/helm/releases', search: '', assign },
      localStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() },
      sessionStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() },
    })
    const asked = answering(() => 401, 401)
    const stop = page(new QueryClient(), vi.fn(async () => [rel('web', 3)]))
    await vi.advanceTimersByTimeAsync(0)
    closedForGood()
    await vi.advanceTimersByTimeAsync(750)
    expect(asked.slice(0, 2)).toEqual([STREAM, '/api/v1/auth/me'])
    expect(assign).toHaveBeenCalledWith('/login')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(asked.filter((u) => u === STREAM)).toHaveLength(1)
    expect(FakeEventSource.made).toHaveLength(1)
    stop()
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

// A read's answer replaces the rows, and it may have been made before a frame that came while the read was on its way:
// the Releases page reads on resync and on Refresh past the server's cache, and reads its own way when opened again on a
// list marked stale.
describe('frames that come while the releases are read', () => {
  const listKey = ['helm-releases', 'c', '']
  const latest = () => FakeEventSource.made[FakeEventSource.made.length - 1]
  const shownAs = (rows: HelmReleaseSummary[] | undefined) => rows?.map((row) => `${row.name}@${row.revision} ${row.status}`)

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

  // The page's query and its first answer, then the stream, which the page opens once the list has answered. Each read
  // waits for the answer the test gives it, so a frame can come while it is on its way.
  async function open(first: HelmReleaseSummary[]) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const answers: Array<{ resolve: (rows: HelmReleaseSummary[]) => void; reject: (err: Error) => void }> = []
    const read = vi.fn(() => new Promise<HelmReleaseSummary[]>((resolve, reject) => answers.push({ resolve, reject })))
    // what React draws: the query as it is once the notifications of a change are out
    const observer = new QueryObserver(client, { queryKey: listKey, queryFn: read, staleTime: Infinity })
    const drawn: (string[] | undefined)[] = []
    const stopObserver = observer.subscribe(notifyManager.batchCalls(() => drawn.push(shownAs(observer.getCurrentResult().data))))
    await vi.advanceTimersByTimeAsync(0)
    answers.shift()!.resolve(first)
    await vi.advanceTimersByTimeAsync(0)
    // the Releases page's read on resync, as its readAgain makes it
    const readPastCache = () => void client.fetchQuery({ queryKey: listKey, queryFn: read, staleTime: 0 }).catch(() => {})
    const stopStream = followHelmReleases(client, { cluster: 'c', queryKey: listKey, onResync: () => readPastCache })
    return {
      client,
      read,
      drawn,
      rows: () => shownAs(client.getQueryData(listKey)),
      send: async (type: string, object: HelmReleaseSummary) => {
        latest().send('message', { type, object })
        await vi.advanceTimersByTimeAsync(0)
      },
      answer: async (rows: HelmReleaseSummary[]) => {
        answers.shift()!.resolve(rows)
        await vi.advanceTimersByTimeAsync(0)
      },
      // the page's own read, as when it opens again on a list marked stale
      readAgain: async () => {
        void client.invalidateQueries({ queryKey: listKey })
        await vi.advanceTimersByTimeAsync(0)
      },
      leave: () => stopStream(),
      stop: () => {
        stopStream()
        stopObserver()
      },
    }
  }

  it('a release uninstalled while the list is read again on resync is gone once the answer made before it comes, and never drawn again', async () => {
    const list = await open([rel('db', 1), rel('web', 3)])
    latest().send('resync', {})
    await vi.advanceTimersByTimeAsync(5000)
    expect(list.read).toHaveBeenCalledTimes(2)
    await list.send('DELETED', rel('db', 1))
    expect(list.rows()).toEqual(['web@3 deployed'])
    list.drawn.length = 0
    await list.answer([rel('db', 1), rel('web', 3)])
    expect(list.rows()).toEqual(['web@3 deployed'])
    expect(list.drawn.length).toBeGreaterThan(0)
    expect(list.drawn.every((rows) => !rows?.some((row) => row.startsWith('db@')))).toBe(true)
    list.stop()
  })

  it('a release installed while a Refresh reads is there once the answer comes, as its last frame left it', async () => {
    const list = await open([rel('web', 3)])
    const refreshed = refreshList(list.client, listKey, list.read)
    await vi.advanceTimersByTimeAsync(0)
    expect(list.read).toHaveBeenCalledTimes(2)
    await list.send('ADDED', rel('db', 1, 'pending-install'))
    await list.send('MODIFIED', rel('db', 1))
    await list.answer([rel('web', 3)])
    await expect(refreshed).resolves.toEqual([rel('web', 3)])
    expect(list.rows()).toEqual(['web@3 deployed', 'db@1 deployed'])
    list.stop()
  })

  it('an upgrade while the page reads its list keeps its new revision once the answer made before it comes', async () => {
    const list = await open([rel('web', 3)])
    await list.readAgain()
    expect(list.read).toHaveBeenCalledTimes(2)
    await list.send('ADDED', rel('web', 4, 'pending-upgrade'))
    await list.send('MODIFIED', rel('web', 3, 'superseded'))
    await list.send('MODIFIED', rel('web', 4))
    await list.answer([rel('web', 3)])
    expect(list.rows()).toEqual(['web@4 deployed'])
    list.stop()
  })

  // A release's revision says which of the answer and a frame is newer: an older frame does not take the answer back.
  it('a frame of an older revision that came while the list was read leaves the answer\'s newer revision', async () => {
    const list = await open([rel('web', 3)])
    await list.readAgain()
    await list.send('MODIFIED', rel('web', 3, 'superseded'))
    await list.answer([rel('web', 4)])
    expect(list.rows()).toEqual(['web@4 deployed'])
    list.stop()
  })

  // A release the answer no longer has carries no revision to compare: a frame from before its uninstall brings it back
  // until its DELETED, which comes next on the same stream.
  it('a frame older than the answer brings an uninstalled release back only until its DELETED', async () => {
    const list = await open([rel('db', 1), rel('web', 3)])
    await list.readAgain()
    await list.send('MODIFIED', rel('db', 1, 'uninstalling'))
    await list.answer([rel('web', 3)])
    expect(list.rows()).toEqual(['web@3 deployed', 'db@1 uninstalling'])
    await list.send('DELETED', rel('db', 1, 'uninstalling'))
    expect(list.rows()).toEqual(['web@3 deployed'])
    list.stop()
  })

  it('applies nothing once the stream is gone', async () => {
    const list = await open([rel('db', 1), rel('web', 3)])
    await list.readAgain()
    await list.send('DELETED', rel('db', 1))
    // the page's query stays, so the read goes on without the stream
    list.leave()
    await list.answer([rel('db', 1), rel('web', 3)])
    expect(list.rows()).toEqual(['db@1 deployed', 'web@3 deployed'])
    list.stop()
  })
})
