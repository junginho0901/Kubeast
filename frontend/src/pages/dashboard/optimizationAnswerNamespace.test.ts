import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The Optimization window kept the AI answer asked for one namespace under the table of the namespace picked after
// it, and kept streaming it there; an Apply result of a workload showed on the row of the same name in another
// namespace, and stayed when the window was opened again. Another namespace now drops the answer and stops its
// stream, and the results start empty with another namespace or another opening.

// The hooks below are run as React runs them across renders: each state and ref in call order, kept between renders.
const rt = vi.hoisted(() => ({ states: [] as unknown[], refs: [] as { current: unknown }[], s: 0, r: 0 }))
vi.mock('react', () => ({
  useState: (init: unknown) => {
    const at = rt.s++
    if (!(at in rt.states)) rt.states[at] = typeof init === 'function' ? (init as () => unknown)() : init
    return [rt.states[at], (next: unknown) => { rt.states[at] = typeof next === 'function' ? (next as (v: unknown) => unknown)(rt.states[at]) : next }]
  },
  useRef: (init: unknown) => {
    const at = rt.r++
    rt.refs[at] ??= { current: init }
    return rt.refs[at]
  },
  useEffect: () => {},
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, o?: { defaultValue?: string }) => o?.defaultValue ?? key }) }))
vi.mock('@/hooks/usePrometheusQuery', () => ({ useClusterFeatures: () => ({ data: { ai: { enabled: true } } }) }))

interface Handlers { signal: AbortSignal; onObserved: (s: string) => void; onContent: (s: string) => void; onMeta: (m: object) => void; onDone: () => void }
const streams = vi.hoisted(() => [] as { namespace: string; handlers: Handlers }[])
vi.mock('@/services/api', () => ({
  api: {
    suggestOptimizationStream: (namespace: string, handlers: Handlers) => {
      streams.push({ namespace, handlers })
      return new Promise<void>(() => {})
    },
  },
}))

import { useOptimizationStream } from './hooks/useOptimizationStream'
import { useResizeResults } from './modals/useResizeResults'

function hook<T>(run: () => T) {
  rt.states.length = 0
  rt.refs.length = 0
  return () => {
    rt.s = 0
    rt.r = 0
    return run()
  }
}

beforeEach(() => {
  streams.length = 0
  vi.useFakeTimers()
  vi.stubGlobal('window', { setInterval, clearInterval, cancelAnimationFrame: () => {} })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the Optimization answer', () => {
  // the window open on shop, its answer asked and partly come
  function answered() {
    const render = hook(useOptimizationStream)
    render().openOptimizationModal('shop')
    render().handleRunOptimizationSuggestions()
    expect(streams.map((s) => s.namespace)).toEqual(['shop'])
    streams[0].handlers.onObserved('| shop table |')
    streams[0].handlers.onContent('Lower web')
    vi.advanceTimersByTime(1_000)
    const now = render()
    expect([now.optimizationObservedContent, now.optimizationAnswerContent, now.isOptimizationStreaming]).toEqual(['| shop table |', 'Lower web', true])
    return render
  }

  it('is not drawn under another namespace, and its stream stops', () => {
    const render = answered()
    streams[0].handlers.onContent(' replicas')
    render().chooseOptimizationNamespace('billing')
    vi.advanceTimersByTime(1_000)
    const now = render()
    expect(now.optimizationNamespace).toBe('billing')
    expect([now.optimizationObservedContent, now.optimizationAnswerContent, now.isOptimizationStreaming, now.optimizationStreamError]).toEqual(['', '', false, ''])
    expect(streams[0].handlers.signal.aborted, 'the shop stream').toBe(true)
  })

  it('stays when the namespace on screen is chosen again', () => {
    const render = answered()
    render().chooseOptimizationNamespace('shop')
    const now = render()
    expect([now.optimizationObservedContent, now.optimizationAnswerContent, now.isOptimizationStreaming]).toEqual(['| shop table |', 'Lower web', true])
    expect(streams[0].handlers.signal.aborted).toBe(false)
  })

  it('leaves no queued letters to arrive after the window closed', () => {
    const render = answered()
    streams[0].handlers.onContent(' and api')
    render().handleCloseOptimizationModal()
    vi.advanceTimersByTime(1_000)
    expect(render().optimizationAnswerContent).toBe('')
  })
})

describe('the Apply results', () => {
  it('start empty with another namespace and with the window opened again', () => {
    let props = { open: true, namespace: 'shop' }
    const render = hook(() => useResizeResults<string>(props.open, props.namespace))
    render()[1]((m) => ({ ...m, 'shop/Deployment/apps/v1/web/app': '2/2 resized' }))
    expect(render()[0]).toEqual({ 'shop/Deployment/apps/v1/web/app': '2/2 resized' })

    props = { open: true, namespace: 'billing' }
    expect(render()[0], 'another namespace').toEqual({})
    expect(render()[0]).toEqual({})

    render()[1]((m) => ({ ...m, 'billing/Deployment/apps/v1/web/app': '1/1 resized' }))
    props = { open: false, namespace: 'billing' }
    render()
    props = { open: true, namespace: 'billing' }
    expect(render()[0], 'opened again').toEqual({})
  })

  it('stay while the window stays on its namespace', () => {
    const props = { open: true, namespace: 'shop' }
    const render = hook(() => useResizeResults<string>(props.open, props.namespace))
    render()[1]((m) => ({ ...m, a: 'done' }))
    render()
    expect(render()[0]).toEqual({ a: 'done' })
  })
})
