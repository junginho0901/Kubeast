/* eslint-disable react-hooks/rules-of-hooks -- the hook runs as a plain function here: react's state, refs and effects are stood in below */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OptimizationRow } from '@/services/api/types'
import { optimizationRowKey } from '../utils'
import { useOptimizationStream } from './useOptimizationStream'

// The Optimization window's answer is about one namespace: another namespace picked in the window, while the answer is
// still coming or after it came, leaves none of it on screen or for the floating chat (OptimizationModal sends
// `answerContent` as ai_suggestion).

// The hook's state kept between calls, as React keeps it between renders.
const slots: unknown[] = []
let cursor = 0
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (init: unknown) => {
    const at = cursor++
    if (!(at in slots)) slots[at] = typeof init === 'function' ? (init as () => unknown)() : init
    return [slots[at], (next: unknown) => {
      slots[at] = typeof next === 'function' ? (next as (prev: unknown) => unknown)(slots[at]) : next
    }]
  },
  useRef: (init: unknown) => {
    const at = cursor++
    if (!(at in slots)) slots[at] = { current: init }
    return slots[at]
  },
  useEffect: () => {},
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, o?: { defaultValue?: string }) => o?.defaultValue ?? key }) }))
vi.mock('@/hooks/usePrometheusQuery', () => ({ useClusterFeatures: () => ({ data: { ai: { enabled: true } } }) }))

type Handlers = {
  signal: AbortSignal
  onObserved: (c: string) => void
  onContent: (c: string) => void
  onUsage: (u: object) => void
  onMeta: (m: object) => void
  onError: (m: string) => void
  onDone: () => void
}
const streams = vi.hoisted(() => [] as { namespace: string; handlers: Handlers }[])
vi.mock('@/services/api', () => ({
  api: {
    suggestOptimizationStream: (namespace: string, handlers: Handlers) => {
      streams.push({ namespace, handlers })
      return new Promise(() => {})
    },
  },
}))

const render = () => {
  cursor = 0
  return useOptimizationStream()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { setInterval: (fn: () => void, ms: number) => setInterval(fn, ms), cancelAnimationFrame: () => {} })
  slots.length = 0
  streams.length = 0
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// The window opened on `shop`, its answer partly written: the observed table, letters typed, usage and meta.
function answering() {
  render().openOptimizationModal('shop')
  render().handleRunOptimizationSuggestions()
  const { handlers } = streams[streams.length - 1]
  handlers.onObserved('| shop | 3 pods |\n')
  handlers.onContent('Lower the requests of shop/web.')
  vi.advanceTimersByTime(30 * 40)
  handlers.onUsage({ total_tokens: 120 })
  handlers.onMeta({ finish_reason: 'stop', max_tokens: 2048 })
  handlers.onContent(' More to come.')
  const shown = render()
  expect(shown.optimizationNamespace).toBe('shop')
  expect(shown.optimizationAnswerContent).toContain('Lower the requests of shop/web.')
  expect(shown.optimizationObservedContent).toContain('shop')
  expect(shown.optimizationUsage).toEqual({ total_tokens: 120 })
  expect(shown.isOptimizationStreaming).toBe(true)
  return handlers
}

const nothingOf = (shown: ReturnType<typeof render>) => ({
  answer: shown.optimizationAnswerContent,
  observed: shown.optimizationObservedContent,
  error: shown.optimizationStreamError,
  usage: shown.optimizationUsage,
  meta: shown.optimizationMeta,
  streaming: shown.isOptimizationStreaming,
})
const NOTHING = { answer: '', observed: '', error: '', usage: null, meta: null, streaming: false }

describe('another namespace picked in the Optimization window', () => {
  it('leaves nothing of the answer about the namespace before, the stream that was still writing too', () => {
    const handlers = answering()
    render().setOptimizationNamespace('payments')
    const shown = render()
    expect(shown.optimizationNamespace).toBe('payments')
    expect(nothingOf(shown)).toEqual(NOTHING)
    expect(handlers.signal.aborted).toBe(true)

    // what that stream and its typewriter still had: nothing of it reaches the window
    handlers.onContent(' Late words about shop.')
    handlers.onObserved('| shop | late |\n')
    handlers.onUsage({ total_tokens: 999 })
    handlers.onMeta({ finish_reason: 'length' })
    handlers.onError('late failure')
    handlers.onDone()
    vi.advanceTimersByTime(30 * 100)
    expect(nothingOf(render())).toEqual(NOTHING)
  })

  it('then answers about that namespace alone', () => {
    answering()
    render().setOptimizationNamespace('payments')
    render().handleRunOptimizationSuggestions()
    expect(streams.map((s) => s.namespace)).toEqual(['shop', 'payments'])
    streams[1].handlers.onContent('Payments is fine.')
    streams[0].handlers.onContent(' Late words about shop.')
    vi.advanceTimersByTime(30 * 100)
    expect(render().optimizationAnswerContent).toBe('Payments is fine.')
  })

  it('keeps the answer when the namespace it is about is picked again', () => {
    answering()
    render().setOptimizationNamespace('shop')
    vi.advanceTimersByTime(30 * 100)
    expect(render().optimizationAnswerContent).toBe('Lower the requests of shop/web. More to come.')
  })

  it('as opening and closing the window, which also leave no usage or meta of the answer before', () => {
    answering()
    render().handleCloseOptimizationModal()
    expect(nothingOf(render())).toEqual(NOTHING)
    answering()
    render().openOptimizationModal('shop')
    vi.advanceTimersByTime(30 * 100)
    expect(nothingOf(render())).toEqual(NOTHING)
  })
})

describe('an Apply result in the Optimization window', () => {
  const row = (namespace: string): OptimizationRow => ({
    kind: 'Deployment', namespace, name: 'web', container: 'app', pods: 2, cpu_request_m: 50, cpu_limit_m: 0,
    mem_request_bytes: 200 << 20, mem_limit_bytes: 0, flags: [],
  })

  it('is shown on its own namespace\'s row, not on a workload of the same name in the namespace picked next', () => {
    expect(optimizationRowKey(row('shop'))).not.toBe(optimizationRowKey(row('payments')))
    expect(optimizationRowKey(row('shop'))).toBe(optimizationRowKey(row('shop')))
  })
})
