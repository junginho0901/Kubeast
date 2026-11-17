import { QueryClient, QueryObserver, type QueryFunction } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { everyUntilRefused, queryDefaults } from './queryDefaults'

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

describe('everyUntilRefused', () => {
  it('stops the timer once the read was refused, and keeps it for another failure', () => {
    const every = everyUntilRefused(60_000)
    expect([every({ state: { error: null } }), every({ state: { error: httpError(403) } }), every({ state: { error: httpError(503) } })])
      .toEqual([60_000, false, 60_000])
  })
})
