import { describe, it, expect, vi } from 'vitest'
import { QueryClient, QueryObserver, type QueryKey } from '@tanstack/react-query'
import { dropClusterQueries, isClusterScopedQueryKey } from './clusterQueryScope'

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

    await dropClusterQueries(client)

    await vi.waitFor(() => expect(screen.data()).toBe('answer 2'))
    expect(fetch).toHaveBeenCalledTimes(2)
    screen.stop()
  })

  it('takes the old cluster\'s data off a screen until the new cluster answers', async () => {
    const client = new QueryClient()
    let answer: (value: string) => void = () => {}
    const fetch = vi.fn(() => new Promise<string>((resolve) => { answer = resolve }))
    const screen = onScreen(client, ['workloads', 'pods'], fetch)
    answer('old cluster')
    await vi.waitFor(() => expect(screen.data()).toBe('old cluster'))

    const dropped = dropClusterQueries(client)
    expect(screen.data()).toBeUndefined()
    answer('new cluster')
    await dropped

    await vi.waitFor(() => expect(screen.data()).toBe('new cluster'))
    screen.stop()
  })

  it('leaves a cluster-independent query alone', async () => {
    const client = new QueryClient()
    const fetch = counted()
    const screen = onScreen(client, ['clusters'], fetch)
    await vi.waitFor(() => expect(screen.data()).toBe('answer 1'))

    await dropClusterQueries(client)

    expect(screen.data()).toBe('answer 1')
    expect(fetch).toHaveBeenCalledTimes(1)
    screen.stop()
  })

  it('empties a query not on screen without asking for it', async () => {
    const client = new QueryClient()
    const fetch = counted()
    await client.fetchQuery({ queryKey: ['network', 'services'], queryFn: fetch })

    await dropClusterQueries(client)

    expect(client.getQueryData(['network', 'services'])).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
