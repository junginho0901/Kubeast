import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryObserver } from '@tanstack/react-query'

import { followList } from '@/services/useKubeWatchList'
import { watchMultiplexer } from '@/services/watchMultiplexer'
import { refreshList } from './useRefresh'

// A list page's Refresh read the list past the server's cache, took the list out of the cache and wrote the answer
// back: a new query, which the page's own useQuery, drawn again after the Refresh, read again at once — two reads for
// one press. refreshList reads it once, as the list's own read.

const listKey = ['configuration', 'configmaps', 'demo']
const path = '/api/v1/namespaces/demo/configmaps'
const row = (name: string) => ({ name, namespace: 'demo' })
const names = (rows: unknown) => (rows as { name: string }[]).map((r) => r.name)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// The page's list query as useQuery keeps it: staleTime 0, as the list pages leave it, and its options given again
// on every drawing.
function screen(client: QueryClient, reads: () => Promise<unknown[]>) {
  const options = { queryKey: listKey, queryFn: reads }
  const observer = new QueryObserver(client, options)
  const stop = observer.subscribe(() => {})
  return { draw: () => observer.setOptions(options), stop }
}

describe("a list's Refresh", () => {
  let listener: ((message: unknown) => void) | undefined
  beforeEach(() => {
    listener = undefined
    vi.spyOn(watchMultiplexer, 'subscribe').mockImplementation(async (_msg, l) => {
      listener = l as (message: unknown) => void
      return () => {}
    })
    vi.spyOn(watchMultiplexer, 'unsubscribe').mockImplementation(() => {})
    vi.spyOn(watchMultiplexer, 'onSocketClosed').mockImplementation(() => () => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads the list once, and the page draws its answer without reading it again', async () => {
    // main.tsx's defaults
    const client = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } })
    const reads = vi.fn(async () => [row('web')])
    const page = screen(client, reads)
    await sleep(5)
    expect(reads).toHaveBeenCalledTimes(1)

    const forced = vi.fn(async () => [row('new'), row('web')])
    await refreshList(client, listKey, forced)
    // the drawings after it: the rows it brought, the spinner stopping
    page.draw()
    await sleep(5)
    page.draw()
    await sleep(5)

    expect(forced).toHaveBeenCalledTimes(1)
    expect(reads, 'the page read nothing after the Refresh').toHaveBeenCalledTimes(1)
    expect(names(client.getQueryData(listKey))).toEqual(['new', 'web'])
    page.stop()
  })

  it('keeps a change that came while its read was on its way, as any read of a live list does', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const page = screen(client, async () => [row('web')])
    const stopList = followList(client, { clusterId: 'self', paths: [path], query: 'watch=1', queryKey: listKey })
    await sleep(5)

    let answer: (rows: unknown[]) => void = () => {}
    const done = refreshList(client, listKey, () => new Promise<unknown[]>((resolve) => { answer = resolve }))
    await sleep(5)
    listener!({ type: 'DATA', clusterId: 'self', path, query: 'watch=1', data: { type: 'ADDED', object: row('cache') } })
    await sleep(5)
    // the answer was made before the ConfigMap was
    answer([row('web')])
    await done

    expect(names(client.getQueryData(listKey))).toEqual(['cache', 'web'])
    stopList()
    page.stop()
  })

  it("is the list's answer even when another read of it was on its way", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const answers: Array<(rows: unknown[]) => void> = []
    const reads = vi.fn(() => new Promise<unknown[]>((resolve) => answers.push(resolve)))
    const page = screen(client, reads)
    await sleep(5)
    answers.shift()!([row('web')])
    await sleep(5)
    // a RESYNC's read, still on its way when Refresh is pressed
    void client.invalidateQueries({ queryKey: listKey })
    await sleep(5)
    expect(reads).toHaveBeenCalledTimes(2)

    const forced = vi.fn(async () => [row('new'), row('web')])
    await refreshList(client, listKey, forced)
    expect(forced, 'the Refresh read past the cache, not the read on its way').toHaveBeenCalledTimes(1)
    // the read that gave way answers late, with what the server's cache held before
    answers.shift()!([row('web')])
    await sleep(5)

    expect(names(client.getQueryData(listKey))).toEqual(['new', 'web'])
    page.stop()
  })

  it('that fails is not tried again and keeps the rows', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } })
    const page = screen(client, async () => [row('web')])
    await sleep(5)

    const forced = vi.fn(() => Promise.reject(new Error('k8s-service unreachable')))
    await expect(refreshList(client, listKey, forced)).rejects.toThrow('k8s-service unreachable')
    await sleep(5)

    expect(forced).toHaveBeenCalledTimes(1)
    expect(names(client.getQueryData(listKey))).toEqual(['web'])
    page.stop()
  })
})

// Every page and page hook with a Refresh, by file.
const pageSources = import.meta.glob(['../pages/**/*.tsx', '../pages/**/*.ts', '!../pages/**/*.test.*'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>

// What each useRefresh( call of a source is given: up to the parenthesis that closes it.
function refreshReads(src: string): string[] {
  return src.split('useRefresh(').slice(1).map((rest) => {
    let depth = 1
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '(') depth++
      else if (rest[i] === ')' && --depth === 0) return rest.slice(0, i)
    }
    return rest
  })
}

describe('the list pages', () => {
  it('have Refreshes, and none takes its list out of the cache (the page would read it again)', () => {
    const withRefresh = Object.entries(pageSources).filter(([, src]) => src.includes('useRefresh('))
    expect(withRefresh.length).toBeGreaterThan(40)
    const removing = withRefresh.filter(([, src]) => refreshReads(src).some((read) => read.includes('removeQueries('))).map(([file]) => file)
    expect(removing).toEqual([])
  })
})
