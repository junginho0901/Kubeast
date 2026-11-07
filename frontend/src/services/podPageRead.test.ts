import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import type { PodPage } from './api'
import { podPagePollEvery, podRowChanged, readPodPageSince } from './podPageRead'
import dashboardQueriesSrc from '@/pages/dashboard/hooks/useDashboardQueries.ts?raw'
import podGroupListSrc from '@/pages/resource-graph/PodGroupList.tsx?raw'
import useServerPodsSrc from '@/components/resource-detail/useServerPods.tsx?raw'
import podsPageSrc from '@/pages/workloads/Pods.tsx?raw'

const answered = vi.hoisted(() => ({ next: undefined as unknown, asked: [] as Record<string, unknown>[] }))
vi.mock('./api', () => ({
  api: {
    getPodPage: async (params: Record<string, unknown>) => {
      answered.asked.push(params)
      return answered.next
    },
  },
}))

const page = (revision: string, names: string[]): PodPage => ({
  items: names.map((name) => ({ name, namespace: 'demo' })),
  total: names.length,
  stats: { total: names.length, health: { ok: names.length, warn: 0, error: 0 } },
  revision,
} as unknown as PodPage)
const unchanged = (revision: string): PodPage => ({ items: [], total: 0, stats: {}, revision, unchanged: true } as unknown as PodPage)

describe('a read of a page of pods that may not have changed', () => {
  const key = ['dashboard-problem-pods', 'self']
  const params = { sort: 'health', offset: 0, limit: 10 }

  beforeEach(() => {
    answered.asked = []
  })

  it('sends the revision it holds, and sorts nothing on the server until a row changed', async () => {
    const client = new QueryClient()
    answered.next = page('r1', ['a'])
    const first = await readPodPageSince(client, key, params)
    expect(answered.asked[0]).toEqual(params)
    client.setQueryData(key, first)

    answered.next = unchanged('r1')
    const second = await readPodPageSince(client, key, params)
    expect(answered.asked[1]).toEqual({ ...params, revision: 'r1' })
    // the rows on hand stay, the very same object, so nothing is drawn again
    expect(second).toBe(first)
  })

  it('takes the new rows when the revision moved', async () => {
    const client = new QueryClient()
    client.setQueryData(key, page('r1', ['a']))
    const moved = page('r2', ['a', 'b'])
    answered.next = moved
    expect(await readPodPageSince(client, key, params)).toBe(moved)
  })

  it('sends no revision when the server listed the rows and gave none', async () => {
    const client = new QueryClient()
    client.setQueryData(key, page('', ['a']))
    answered.next = page('', ['a'])
    await readPodPageSince(client, key, params)
    expect(answered.asked[0]).toEqual(params)
  })

  it('takes the rows of an answer that says unchanged with no rows on hand', async () => {
    const client = new QueryClient()
    const empty = unchanged('r1')
    answered.next = empty
    expect(await readPodPageSince(client, key, params)).toBe(empty)
  })

  it('the Dashboard\'s problem pods and a group window read this way', () => {
    expect(dashboardQueriesSrc).toContain("readPodPageSince(queryClient, ['dashboard-problem-pods', ck], { sort: 'health', offset: 0, limit: 10 })")
    expect(podGroupListSrc).toContain('readPodPageSince(queryClient, podGroupKey, {')
  })

  it('the Dashboard\'s Pods window, its namespaces\' counts and a drawer\'s pods read this way, each by its own key', () => {
    expect(dashboardQueriesSrc).toContain('readPodPageSince(queryClient, podPageKey, {')
    expect(dashboardQueriesSrc).toContain('queryKey: podPageKey,')
    expect(dashboardQueriesSrc).toContain("readPodPageSince(queryClient, ['dashboard-namespace-pods', ck], { offset: 0, limit: 1, groups: 1, group_top: NAMESPACE_POD_GROUPS })")
    expect(useServerPodsSrc).toContain('readPodPageSince(client, queryKey, { ...filter!, offset: (page - 1) * pageSize, limit: pageSize })')
    expect(useServerPodsSrc).toContain('queryKey,')
  })

  it('leaves no read of a page of pods that polls without its revision', () => {
    expect(dashboardQueriesSrc).not.toMatch(/api\.getPodPage\(/)
    expect(useServerPodsSrc).not.toMatch(/api\.getPodPage\(/)
  })
})

describe('whether the row of an open Pod drawer changed', () => {
  const pod = { namespace: 'demo', name: 'web-1' }
  const row = (name: string, status = 'Running', restart_count = 0, namespace = 'demo') => ({ name, namespace, status, restart_count }) as never

  it('says no when only another pod\'s row changed', () => {
    expect(podRowChanged([row('web-1'), row('web-2')], [row('web-1'), row('web-2', 'Pending')], pod)).toBe(false)
  })

  it('says yes when its own row changed', () => {
    expect(podRowChanged([row('web-1')], [row('web-1', 'Pending')], pod)).toBe(true)
    expect(podRowChanged([row('web-1')], [row('web-1', 'Running', 1)], pod)).toBe(true)
  })

  it('says yes when its row came or went', () => {
    expect(podRowChanged([row('web-1')], [row('web-2')], pod)).toBe(true)
    expect(podRowChanged([row('web-2')], [row('web-1')], pod)).toBe(true)
  })

  it('does not take a pod of its name in another namespace for it', () => {
    expect(podRowChanged([row('web-1', 'Running', 0, 'other'), row('web-1')], [row('web-1', 'Pending', 0, 'other'), row('web-1')], pod)).toBe(false)
  })

  // The block on screen does not hold it, so the rows cannot say; a read of the drawer is what it always was.
  it('says yes when neither page holds its row', () => {
    expect(podRowChanged([row('web-2')], [row('web-3')], pod)).toBe(true)
  })

  it('the Pods page reads only the open Pod drawer\'s answer, only when that says so', () => {
    expect(podsPageSrc).toContain('podRowChanged(before?.items, page.items, detail)')
    expect(podsPageSrc).toContain("queryKey: ['pod-describe', detail.namespace, detail.name]")
    expect(podsPageSrc).not.toContain("queryKey: ['pod-describe'] }")
  })
})

describe('how often a followed page of pods is read again', () => {
  it('every 3 s, every 10 s past ten thousand pods, every 30 s for listed rows, and not before an answer', () => {
    const withPods = (total: number, revision = 'r1') => ({ ...page(revision, ['a']), stats: { total } }) as unknown as PodPage
    expect(podPagePollEvery(withPods(10_000))).toBe(3_000)
    expect(podPagePollEvery(withPods(10_001))).toBe(10_000)
    expect(podPagePollEvery(withPods(50_000, ''))).toBe(30_000)
    expect(podPagePollEvery(undefined)).toBe(false)
  })

  it('is the Pods page\'s, which a drawer\'s table of many pods follows too', () => {
    expect(podsPageSrc).toContain('refetchInterval: (query) => podPagePollEvery(query.state.data),')
  })
})
