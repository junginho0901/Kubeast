import { describe, it, expect, vi } from 'vitest'
import { QueryClient, QueryObserver, type QueryKey } from '@tanstack/react-query'
import { askClusterQueriesOnScreen, dropClusterQueries, isClusterScopedQueryKey } from './clusterQueryScope'

describe('isClusterScopedQueryKey', () => {
  it('treats resource data keys as cluster-scoped (cleared on switch)', () => {
    expect(isClusterScopedQueryKey(['namespaces'])).toBe(true)
    expect(isClusterScopedQueryKey(['cluster', 'nodes'])).toBe(true)
    expect(isClusterScopedQueryKey(['workloads', 'pods', 'default'])).toBe(true)
    expect(isClusterScopedQueryKey(['network', 'services'])).toBe(true)
    expect(isClusterScopedQueryKey(['helm-releases'])).toBe(true)
    expect(isClusterScopedQueryKey(['pod-describe', 'ns', 'name'])).toBe(true)
  })

  it('keeps cluster-independent keys across a switch', () => {
    for (const head of [
      'me',
      'roles',
      'permissions',
      'organizations',
      'admin-users',
      'sessions',
      'session',
      'clusters',
      'cluster-roles',
      'setup',
      'setup-status',
      'deployment-mode',
      'ai-models',
      'audit-logs',
    ]) {
      expect(isClusterScopedQueryKey([head]), head).toBe(false)
    }
  })

  it('ignores non-array, empty, or non-string-head keys', () => {
    expect(isClusterScopedQueryKey('namespaces')).toBe(false)
    expect(isClusterScopedQueryKey([])).toBe(false)
    expect(isClusterScopedQueryKey([123])).toBe(false)
    expect(isClusterScopedQueryKey(undefined)).toBe(false)
    expect(isClusterScopedQueryKey(null)).toBe(false)
  })
})

// The cache is emptied when the cluster changes (dropClusterQueries) and what is on screen once the new cluster is
// drawn asks then (askClusterQueriesOnScreen), as ClusterProvider runs them.
describe('dropClusterQueries', () => {
  // A screen that does not render again when the cluster changes: only the observer's own updates reach it.
  const onScreen = (client: QueryClient, queryKey: QueryKey, queryFn: () => Promise<string>) => {
    const observer = new QueryObserver<string>(client, { queryKey, queryFn })
    const stop = observer.subscribe(() => {})
    return { data: () => observer.getCurrentResult().data, stop }
  }
  const counted = () => {
    let calls = 0
    const fetch = vi.fn(async () => `answer ${++calls}`)
    return fetch
  }

  it('gives a screen its answer when the cluster is chosen while its fetch is on the way', async () => {
    const client = new QueryClient()
    const fetch = counted()
    const screen = onScreen(client, ['access-requests', 'mine'], fetch)
    expect(fetch).toHaveBeenCalledTimes(1)

    dropClusterQueries(client)
    await askClusterQueriesOnScreen(client)

    await vi.waitFor(() => expect(screen.data()).toBe('answer 2'))
    expect(fetch).toHaveBeenCalledTimes(2)
    screen.stop()
  })

  // The screen of the cluster left is still subscribed when the cache is emptied and goes as the new cluster is drawn.
  // Its query asked then went out as the new cluster with that screen's key and parameters, beside the new screen's.
  it('asks nothing for the screen being left, and the new screen\'s query once', async () => {
    const client = new QueryClient()
    const left = counted()
    const leaving = onScreen(client, ['top-resources', 'a'], left)
    await vi.waitFor(() => expect(leaving.data()).toBe('answer 1'))

    dropClusterQueries(client)
    leaving.stop()
    const read = counted()
    const arriving = onScreen(client, ['top-resources', 'b'], read)
    await askClusterQueriesOnScreen(client)

    await vi.waitFor(() => expect(arriving.data()).toBe('answer 1'))
    expect({ left: left.mock.calls.length, read: read.mock.calls.length }).toEqual({ left: 1, read: 1 })
    arriving.stop()
  })

  it('does not ask again for a screen that started again under the new cluster and is asking', async () => {
    const client = new QueryClient()
    const fetch = counted()
    const before = onScreen(client, ['cluster', 'nodes'], fetch)
    await vi.waitFor(() => expect(before.data()).toBe('answer 1'))

    dropClusterQueries(client)
    before.stop()
    const again = onScreen(client, ['cluster', 'nodes'], fetch)
    await askClusterQueriesOnScreen(client)

    await vi.waitFor(() => expect(again.data()).toBe('answer 2'))
    expect(fetch).toHaveBeenCalledTimes(2)
    again.stop()
  })

  it('takes the old cluster\'s data off a screen until the new cluster answers', async () => {
    const client = new QueryClient()
    let answer: (value: string) => void = () => {}
    const fetch = vi.fn(() => new Promise<string>((resolve) => { answer = resolve }))
    const screen = onScreen(client, ['workloads', 'pods'], fetch)
    answer('old cluster')
    await vi.waitFor(() => expect(screen.data()).toBe('old cluster'))

    dropClusterQueries(client)
    expect(screen.data()).toBeUndefined()
    const asked = askClusterQueriesOnScreen(client)
    answer('new cluster')
    await asked

    await vi.waitFor(() => expect(screen.data()).toBe('new cluster'))
    screen.stop()
  })

  it('leaves a cluster-independent query alone', async () => {
    const client = new QueryClient()
    const fetch = counted()
    const screen = onScreen(client, ['clusters'], fetch)
    await vi.waitFor(() => expect(screen.data()).toBe('answer 1'))

    dropClusterQueries(client)
    await askClusterQueriesOnScreen(client)

    expect(screen.data()).toBe('answer 1')
    expect(fetch).toHaveBeenCalledTimes(1)
    screen.stop()
  })

  it('empties a query not on screen without asking for it', async () => {
    const client = new QueryClient()
    const fetch = counted()
    await client.fetchQuery({ queryKey: ['network', 'services'], queryFn: fetch })

    dropClusterQueries(client)
    await askClusterQueriesOnScreen(client)

    expect(client.getQueryData(['network', 'services'])).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
