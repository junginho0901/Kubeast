import { QueryClient, QueryObserver, type QueryKey } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { keepSameRead } from './keepSameRead'

// One useQuery whose key changes, as a screen's renders give it: one observer, each key's options in turn, each
// answer held until the test gives it.

const rowsKey = (q: string, page: number) => ['rows', 'c1', { q, offset: (page - 1) * 50, limit: 50 }]
const ROWS_PAGE = ['offset', 'limit']

function screen(page: ReadonlyArray<number | string>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const held = new Map<string, (rows: string[]) => void>()
  const optionsOf = (key: QueryKey) => ({
    queryKey: key,
    queryFn: () => new Promise<string[]>((resolve) => held.set(JSON.stringify(key), resolve)),
    placeholderData: keepSameRead(key, page),
  })
  let observer: QueryObserver<string[]> | null = null
  let stop = () => {}
  return {
    show(key: QueryKey) {
      if (!observer) {
        observer = new QueryObserver<string[]>(client, optionsOf(key))
        stop = observer.subscribe(() => {})
      } else observer.setOptions(optionsOf(key))
      return observer.getCurrentResult()
    },
    async answer(key: QueryKey, rows: string[]) {
      await vi.waitFor(() => expect(held.has(JSON.stringify(key)), `asked ${JSON.stringify(key)}`).toBe(true))
      held.get(JSON.stringify(key))!(rows)
      held.delete(JSON.stringify(key))
      await vi.waitFor(() => expect(observer!.getCurrentResult().data).toEqual(rows))
    },
    now: () => observer!.getCurrentResult(),
    refetch: () => void observer!.refetch(),
    stop: () => stop(),
  }
}

const shown = (r: { data?: string[]; isLoading: boolean; isPlaceholderData: boolean }) => ({ rows: r.data, loading: r.isLoading, placeholder: r.isPlaceholderData })

describe('keepSameRead', () => {
  it('lets another search wait for its own answer, with no row of the search before, as on first open', async () => {
    const s = screen(ROWS_PAGE)
    s.show(rowsKey('a', 1))
    await s.answer(rowsKey('a', 1), ['a-1'])

    const waiting = s.show(rowsKey('b', 1))
    expect(shown(waiting), 'while the answer is held').toEqual({ rows: undefined, loading: true, placeholder: false })

    await s.answer(rowsKey('b', 1), ['b-1'])
    expect(shown(s.now()), 'after the answer').toEqual({ rows: ['b-1'], loading: false, placeholder: false })
    s.stop()
  })

  it('keeps the rows on screen while another page of the same search loads', async () => {
    const s = screen(ROWS_PAGE)
    s.show(rowsKey('a', 1))
    await s.answer(rowsKey('a', 1), ['a-1'])

    expect(shown(s.show(rowsKey('a', 2))), 'while page 2 is held').toEqual({ rows: ['a-1'], loading: false, placeholder: true })

    await s.answer(rowsKey('a', 2), ['a-2'])
    expect(shown(s.now())).toEqual({ rows: ['a-2'], loading: false, placeholder: false })
    s.stop()
  })

  it('keeps the rows of the same read while it is read again', async () => {
    const s = screen(ROWS_PAGE)
    s.show(rowsKey('a', 1))
    await s.answer(rowsKey('a', 1), ['a-1'])

    s.refetch()
    await vi.waitFor(() => expect(s.now().isFetching).toBe(true))
    expect(shown(s.now()), 'while the refresh is held').toEqual({ rows: ['a-1'], loading: false, placeholder: false })

    await s.answer(rowsKey('a', 1), ['a-1 again'])
    s.stop()
  })

  it('does not carry the rows of a page still loading over to another search', async () => {
    const s = screen(ROWS_PAGE)
    s.show(rowsKey('a', 1))
    await s.answer(rowsKey('a', 1), ['a-1'])
    expect(shown(s.show(rowsKey('a', 2)))).toEqual({ rows: ['a-1'], loading: false, placeholder: true })

    expect(shown(s.show(rowsKey('b', 1))), 'another search while page 2 was held').toEqual({ rows: undefined, loading: true, placeholder: false })
    s.stop()
  })

  it('takes a place in the key as the page too, and the rest of the key as the read', async () => {
    const key = (cluster: string, page: number) => ['rows', cluster, 'Failed', page]
    const s = screen([3])
    s.show(key('c1', 1))
    await s.answer(key('c1', 1), ['c1-1'])
    expect(shown(s.show(key('c1', 2))), 'another page').toEqual({ rows: ['c1-1'], loading: false, placeholder: true })
    expect(shown(s.show(key('c2', 1))), 'another cluster').toEqual({ rows: undefined, loading: true, placeholder: false })
    s.stop()
  })

  it('names nothing to keep without a query before', () => {
    expect(keepSameRead(rowsKey('a', 1), ROWS_PAGE)(['a-1'], undefined)).toBeUndefined()
  })
})
