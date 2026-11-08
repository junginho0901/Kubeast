import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// TanStack Query keeps no clock on a server, which is what it takes this environment for.
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window ??= {}
})

import { focusManager, QueryClient, QueryObserver } from '@tanstack/react-query'
import { describeReads } from './pacedReads'

const key = ['service-describe', 'demo', 'web']

function openDrawer() {
  const client = new QueryClient()
  let reads = 0
  let value = 0
  const observer = new QueryObserver(client, {
    queryKey: key,
    retry: false,
    queryFn: async () => {
      reads += 1
      return { value }
    },
  })
  const stop = observer.subscribe(() => {})
  const page = describeReads(client)
  return {
    client,
    page,
    reads: () => reads,
    change: (next: number) => {
      value = next
      page.changed(key)
    },
    shown: () => observer.getCurrentResult().data,
    close: () => {
      page.stop()
      stop()
    },
  }
}

describe('a list page\'s frames and the drawer open on one of its objects', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    focusManager.setFocused(undefined)
  })

  it('reads once in five seconds at most under a stream of frames, and after the last of them', async () => {
    const drawer = openDrawer()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 1; i <= 300; i += 1) {
      drawer.change(i)
      await vi.advanceTimersByTimeAsync(200)
    }
    if (process.env.WATCH_BENCH) console.info(`bench a list page, a minute of 5 frames a second of the object in the drawer: ${drawer.reads()} reads`)
    expect(drawer.reads()).toBeLessThanOrEqual(1 + 13)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(drawer.shown()).toEqual({ value: 300 })
    drawer.close()
  })

  it('reads within a second of one change after a quiet time', async () => {
    const drawer = openDrawer()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(drawer.reads()).toBe(1)
    drawer.change(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(drawer.reads()).toBe(2)
    expect(drawer.shown()).toEqual({ value: 1 })
    drawer.close()
  })

  it('does not end a read under way for the next frame, and reads again after it', async () => {
    const client = new QueryClient()
    const started: number[] = []
    const finished: number[] = []
    let value = 0
    const stop = new QueryObserver(client, {
      queryKey: key,
      retry: false,
      queryFn: () => {
        const at = value
        started.push(at)
        return new Promise((resolve) => {
          setTimeout(() => {
            finished.push(at)
            resolve({ value: at })
          }, 2000)
        })
      },
    }).subscribe(() => {})
    const page = describeReads(client)
    await vi.advanceTimersByTimeAsync(100)
    for (let i = 1; i <= 5; i += 1) {
      value = i
      page.changed(key)
      await vi.advanceTimersByTimeAsync(100)
    }
    await vi.advanceTimersByTimeAsync(20_000)
    expect(started).toEqual([0, 5])
    expect(finished).toEqual([0, 5])
    expect(client.getQueryData(key)).toEqual({ value: 5 })
    page.stop()
    stop()
  })

  it('a hidden tab reads nothing and reads once when it shows again', async () => {
    const drawer = openDrawer()
    await vi.advanceTimersByTimeAsync(0)
    focusManager.setFocused(false)
    for (let i = 1; i <= 100; i += 1) {
      drawer.change(i)
      await vi.advanceTimersByTimeAsync(600)
    }
    expect(drawer.reads()).toBe(1)
    focusManager.setFocused(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(drawer.reads()).toBe(2)
    expect(drawer.shown()).toEqual({ value: 100 })
    drawer.close()
  })

  it('reads nothing once the page is gone', async () => {
    const drawer = openDrawer()
    await vi.advanceTimersByTimeAsync(0)
    drawer.change(1)
    drawer.page.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(drawer.reads()).toBe(1)
    drawer.close()
  })

  it('leaves a drawer that follows the object by itself to its own reads', async () => {
    const drawer = openDrawer()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 1; i <= 50; i += 1) {
      drawer.page.changedFollowed(key)
      await vi.advanceTimersByTimeAsync(200)
    }
    expect(drawer.reads()).toBe(1)
    drawer.close()
  })
})

describe('a frame of an object no drawer is open on', () => {
  it('reads nothing, and the answer a closed drawer left reads when it opens again', async () => {
    const client = new QueryClient()
    let reads = 0
    client.setQueryData(key, { value: 0 })
    const page = describeReads(client)
    page.changed(key)
    expect(reads).toBe(0)
    expect(client.getQueryState(key)?.isInvalidated).toBe(true)

    const stop = new QueryObserver(client, {
      queryKey: key,
      staleTime: 60_000,
      queryFn: async () => {
        reads += 1
        return { value: 1 }
      },
    }).subscribe(() => {})
    await vi.waitFor(() => expect(reads).toBe(1))
    page.stop()
    stop()
  })

  it('leaves the same mark for a drawer that follows itself', () => {
    const client = new QueryClient()
    client.setQueryData(key, { value: 0 })
    const page = describeReads(client)
    page.changedFollowed(key)
    expect(client.getQueryState(key)?.isInvalidated).toBe(true)
    page.stop()
  })

  // A list opens with one frame per object, and the cache holds every window's queries.
  it('looks only at its own query: a list that opens with thousands of frames does not walk the cache for each', () => {
    const client = new QueryClient()
    for (let i = 0; i < 100; i += 1) client.setQueryData(['other', i], i)
    const page = describeReads(client)
    const walks = vi.spyOn(client.getQueryCache(), 'findAll')
    for (let i = 0; i < 5000; i += 1) page.changed(['service-describe', 'demo', `svc-${i}`])
    expect(walks).toHaveBeenCalledTimes(0)
    expect(client.getQueryCache().getAll()).toHaveLength(100)
    page.stop()
    vi.restoreAllMocks()
  })
})

const listPages = import.meta.glob(['../pages/**/*.tsx', '../pages/**/*.ts', '!../pages/**/*.test.*'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>

describe('the list pages', () => {
  it('ask for a drawer\'s answer through these reads, none on its own for each frame', () => {
    const askingOnTheirOwn = Object.entries(listPages)
      .filter(([, src]) => [...src.matchAll(/onEvent: \(event\) => \{[\s\S]*?\n {4}\},/g)].some(([body]) => body.includes('invalidateQueries')))
      .map(([path]) => path)
    expect(askingOnTheirOwn).toEqual([])
  })

  it('are the pages of a kind whose drawer reads an answer', () => {
    const using = Object.entries(listPages).filter(([, src]) => src.includes('useDescribeReads()')).map(([path]) => path.replace('../pages/', ''))
    // Not Ingresses and Endpoints: the keys they asked for (ingress-detail, endpoint-describe) were no drawer's, so those reads went; their drawers follow by their own reads.
    expect(using.sort()).toEqual([
      'ClusterNodes.tsx', 'Namespaces.tsx', 'configuration/ConfigMaps.tsx', 'configuration/Secrets.tsx',
      'gateway/GRPCRoutes.tsx', 'gateway/GatewayClasses.tsx', 'gateway/Gateways.tsx', 'gateway/HTTPRoutes.tsx', 'gateway/ReferenceGrants.tsx', 'gateway/backend-policies/useBackendPoliciesData.ts',
      'gpu/ResourceClaimTemplates.tsx', 'gpu/ResourceClaims.tsx', 'gpu/ResourceSlices.tsx', 'gpu/device-classes/useDeviceClassesData.ts',
      'network/EndpointSlices.tsx', 'network/IngressClasses.tsx', 'network/NetworkPolicies.tsx', 'network/Services.tsx',
      'security/Roles.tsx', 'security/ServiceAccounts.tsx',
      'storage/PersistentVolumes.tsx', 'storage/StorageClasses.tsx', 'storage/VolumeAttachments.tsx',
    ])
  })

  it('leave a Secret\'s and a Node\'s drawer to its own watch', () => {
    expect(listPages['../pages/configuration/Secrets.tsx']).toContain("changedFollowed(['secret-describe', ns, name])")
    expect(listPages['../pages/ClusterNodes.tsx']).toContain("changedFollowed(['cluster', 'nodes', 'describe', name])")
  })
})

describe('what a list page\'s frames cost', () => {
  it('measured when WATCH_BENCH is set', () => {
    if (!process.env.WATCH_BENCH) return
    for (const rows of [5000, 20_000, 50_000]) {
      const client = new QueryClient()
      for (let i = 0; i < 100; i += 1) client.setQueryData(['other', i], i)
      const page = describeReads(client)
      const started = performance.now()
      for (let i = 0; i < rows; i += 1) page.changed(['service-describe', 'demo', `svc-${i}`])
      console.info(`bench a list page opening with ${rows} frames, 100 other queries in the cache: ${(performance.now() - started).toFixed(1)}ms`)
      page.stop()
    }
  })
})
