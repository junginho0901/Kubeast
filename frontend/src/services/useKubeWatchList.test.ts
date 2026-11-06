import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { applyWatchMessage } from './useKubeWatchList'

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
