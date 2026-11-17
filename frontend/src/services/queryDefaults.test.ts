import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// react-dom with the few DOM parts it touches while nothing it renders is an element (as ClusterProvider.test.ts), and
// a window before TanStack Query loads so it runs refetchInterval
vi.hoisted(() => {
  const document: Record<string, unknown> = { nodeType: 9, addEventListener() {}, removeEventListener() {}, activeElement: null, body: null }
  const window = Object.assign(new EventTarget(), { document, location: { search: '', pathname: '/' }, HTMLIFrameElement: class {} })
  document.defaultView = window
  vi.stubGlobal('window', window)
  vi.stubGlobal('document', document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider, QueryObserver, type QueryFunction } from '@tanstack/react-query'
import type { Member } from '@/services/api'
import { everyUntilRefused, queryDefaults, unlessRefused, useAskRefusedOnAccessChange } from './queryDefaults'

// A read the cluster refused answers the same until the person's access changes. The app's defaults tried every read
// once more a second later, so a refused node list went out twice each time a screen opened it.

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: {} } })

describe('the app\'s query defaults', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const onScreen = (queryFn: QueryFunction<unknown>) => {
    const client = new QueryClient({ defaultOptions: { queries: queryDefaults } })
    return new QueryObserver(client, { queryKey: ['nodes', 'c1'], queryFn }).subscribe(() => {})
  }

  it('do not try a refused read again, and try a read that failed otherwise once more', async () => {
    const refused = vi.fn(async () => { throw httpError(403) })
    const failed = vi.fn(async () => { throw httpError(503) })
    const stops = [onScreen(refused), onScreen(failed)]
    await vi.advanceTimersByTimeAsync(30_000)
    expect({ refused: refused.mock.calls.length, failed: failed.mock.calls.length }).toEqual({ refused: 1, failed: 2 })
    stops.forEach((stop) => stop())
  })
})

describe('a timer that stops at a refusal', () => {
  it('stops once the read was refused, and keeps its pace for another failure or an answer', () => {
    const every = everyUntilRefused(60_000)
    expect([every({ state: { error: null } }), every({ state: { error: httpError(403) } }), every({ state: { error: httpError(503) } })])
      .toEqual([60_000, false, 60_000])
    expect([unlessRefused(null, 5_000), unlessRefused(httpError(403), 5_000), unlessRefused(null, false), unlessRefused(null, undefined)])
      .toEqual([5_000, false, false, false])
  })
})

// The person's access changes (an access request approved, an admin's edit): the next answer of /auth/me differs, and
// each read on screen that was refused asks once more; one that now answers goes back on its timer.
describe('a change of the person\'s access', () => {
  const container = {
    nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: document, addEventListener() {}, removeEventListener() {}, childNodes: [], firstChild: null,
  } as unknown as HTMLElement
  let root: Root | null = null
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(async () => {
    await act(async () => { root?.unmount() })
    root = null
    vi.useRealTimers()
  })

  const member = (namespaces: string[], extra: Partial<Member> = {}): Member => ({
    id: 'u1', name: 'u1', role: { id: 2, name: 'Member', permissions: [] }, created_at: '', updated_at: '',
    cluster_roles: { c1: 'Read' }, cluster_namespaces: { c1: namespaces }, ...extra,
  })
  function Probe({ me }: { me: Member | undefined }) {
    useAskRefusedOnAccessChange(me)
    return null
  }

  async function screen() {
    let allowed = false
    const read = vi.fn(async () => {
      if (!allowed) throw httpError(403)
      return ['node-1']
    })
    const client = new QueryClient({ defaultOptions: { queries: queryDefaults } })
    const stop = new QueryObserver(client, { queryKey: ['nodes', 'c1'], queryFn: read, refetchInterval: everyUntilRefused(60_000) }).subscribe(() => {})
    root = createRoot(container)
    const show = async (me: Member | undefined) => {
      await act(async () => { root!.render(createElement(QueryClientProvider, { client }, createElement(Probe, { me }))) })
      await vi.advanceTimersByTimeAsync(0)
    }
    return { read, stop, show, allow: () => { allowed = true } }
  }

  it('asks a refused read once more, which then goes on its timer', async () => {
    const s = await screen()
    await s.show(member(['web']))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(s.read).toHaveBeenCalledTimes(1)

    s.allow()
    await s.show(member(['web', 'api']))
    expect(s.read).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(61_000)
    expect(s.read).toHaveBeenCalledTimes(3)
    s.stop()
  })

  it('asks nothing on the first answer, nor on one with the same access', async () => {
    const s = await screen()
    await s.show(undefined)
    await s.show(member(['web']))
    await s.show(member(['web'], { last_login_at: '2026-11-17T04:00:00Z' }))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(s.read).toHaveBeenCalledTimes(1)
    s.stop()
  })
})
