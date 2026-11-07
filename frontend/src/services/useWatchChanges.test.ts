import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { changeReader } from './useWatchChanges'

const key = ['pod-rbac', 'shop', 'web-0']

function followed(readMs = 10) {
  const client = new QueryClient()
  const queryFn = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, readMs))
    return { reads: queryFn.mock.calls.length }
  })
  const stop = new QueryObserver(client, { queryKey: key, queryFn }).subscribe(() => {})
  return { client, queryFn, stop }
}

describe('changeReader', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reads again when something changed, keeping the answer on screen until the new one comes', async () => {
    const { client, queryFn, stop } = followed(100)
    await vi.advanceTimersByTimeAsync(150)
    expect(queryFn).toHaveBeenCalledTimes(1)
    const reader = changeReader(client, [key])
    reader.changed()
    await vi.advanceTimersByTimeAsync(50)
    expect(queryFn).toHaveBeenCalledTimes(2)
    expect(client.getQueryData(key)).toEqual({ reads: 1 })
    await vi.advanceTimersByTimeAsync(100)
    expect(client.getQueryData(key)).toEqual({ reads: 2 })
    reader.stop()
    stop()
  })

  it('reads nothing while nothing changed', async () => {
    const { client, queryFn, stop } = followed()
    await vi.advanceTimersByTimeAsync(50)
    const reader = changeReader(client, [key])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(queryFn).toHaveBeenCalledTimes(1)
    reader.stop()
    stop()
  })

  it('reads at most once in five seconds however often the watch tells, and reads after the last change', async () => {
    const { client, queryFn, stop } = followed()
    await vi.advanceTimersByTimeAsync(50)
    const reader = changeReader(client, [key])
    for (let second = 0; second < 30; second += 1) {
      reader.changed()
      await vi.advanceTimersByTimeAsync(1000)
    }
    await vi.advanceTimersByTimeAsync(10_000)
    const reads = queryFn.mock.calls.length - 1
    expect(reads).toBeGreaterThanOrEqual(6)
    expect(reads).toBeLessThanOrEqual(8)
    reader.stop()
    stop()
  })

  // A list that takes the server two seconds to read: ten people on it would otherwise keep it reading all the time.
  it('leaves ten times a read\'s own time between reads of a big list', async () => {
    const { client, queryFn, stop } = followed(2000)
    await vi.advanceTimersByTimeAsync(2100)
    const reader = changeReader(client, [key])
    for (let second = 0; second < 66; second += 1) {
      reader.changed()
      await vi.advanceTimersByTimeAsync(1000)
    }
    const reads = queryFn.mock.calls.length - 1
    expect(reads).toBeGreaterThanOrEqual(2)
    expect(reads).toBeLessThanOrEqual(4)
    reader.stop()
    stop()
  })

  it('does not restart a read under way, and reads again after it', async () => {
    const { client, queryFn, stop } = followed(3000)
    const reader = changeReader(client, [key])
    reader.changed()
    await vi.advanceTimersByTimeAsync(1000)
    expect(queryFn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(queryFn).toHaveBeenCalledTimes(2)
    reader.stop()
    stop()
  })

  it('spreads the reads of tabs a returning socket tells together', async () => {
    const random = vi.spyOn(Math, 'random')
    const when = async (value: number) => {
      random.mockReturnValue(value)
      const { client, queryFn, stop } = followed()
      await vi.advanceTimersByTimeAsync(50)
      const reader = changeReader(client, [key])
      reader.missed()
      let waited = 0
      while (queryFn.mock.calls.length === 1 && waited < 10_000) {
        await vi.advanceTimersByTimeAsync(100)
        waited += 100
      }
      reader.stop()
      stop()
      return waited
    }
    expect(await when(0)).toBeLessThanOrEqual(100)
    expect(await when(0.9)).toBeGreaterThanOrEqual(4000)
    random.mockRestore()
  })

  it('stops with the component', async () => {
    const { client, queryFn, stop } = followed()
    await vi.advanceTimersByTimeAsync(50)
    const reader = changeReader(client, [key])
    reader.changed()
    reader.stop()
    reader.changed()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(queryFn).toHaveBeenCalledTimes(1)
    stop()
  })
})
