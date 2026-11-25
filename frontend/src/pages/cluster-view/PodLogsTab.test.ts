import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { elementsOf, fakeRender, fakeUnmount, textsOf } from '@/testing/fakeHooks'

// The Cluster View Logs tab follows a container's output (k8s-service PodLogsSSE). A stream refused at the account's cap
// (multicluster.maxFollowedLogsPerAccount) carries only the event `stream-limit`: the tab closes it, so the browser does
// not ask again, and says why under what it shows, never "No logs" or a stream error. A dropped connection is the
// browser's to open again and stops nothing.

vi.mock('react', async (importOriginal) => ({ ...(await importOriginal<typeof import('react')>()), ...(await import('@/testing/fakeHooks')).fakeHooks }))
vi.mock('@/hooks/useLogFilesAvailable', () => ({ useLogFilesAvailable: () => false }))
vi.mock('@/hooks/useLogSearchAvailable', () => ({ useLogSearchAvailable: () => false }))
vi.mock('@/hooks/useDismiss', () => ({ useDismiss: () => {} }))

import { SESSION_ENDED_EVENT } from '@/services/auth'
import { liveSessionEndText } from '@/utils/liveSessionEnd'
import { STREAM_LIMIT_EVENT, followLimitText } from '@/utils/serverShutdown'
import { PodLogsTab } from './PodLogsTab'

// The tab's EventSource; the test plays what the browser does with the server's answer.
class FakeEventSource {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2
  static opened: FakeEventSource[] = []
  readyState = FakeEventSource.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string; lastEventId: string }) => void) | null = null
  private listeners = new Map<string, ((e: { data?: string }) => void)[]>()
  constructor(public url: string) {
    FakeEventSource.opened.push(this)
  }
  addEventListener(name: string, fn: (e: { data?: string }) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn])
  }
  close() {
    this.readyState = FakeEventSource.CLOSED
  }
  open() {
    this.readyState = FakeEventSource.OPEN
    this.onopen?.()
  }
  line(data: string, lastEventId: string) {
    this.onmessage?.({ data, lastEventId })
  }
  fire(name: string, data?: string) {
    for (const fn of this.listeners.get(name) ?? []) fn({ data })
  }
  // The connection drops; the browser tries again on its own.
  drop() {
    this.readyState = FakeEventSource.CONNECTING
    this.fire('error')
  }
}

beforeEach(() => {
  FakeEventSource.opened = []
  vi.stubGlobal('EventSource', FakeEventSource)
})
afterEach(() => {
  fakeUnmount()
  vi.unstubAllGlobals()
})

const tr = (_key: string, fallback: string) => fallback
const pod = { name: 'web-0', namespace: 'shop', containers: [{ name: 'app' }] }

function openTab() {
  const props = { pod, selectedContainer: 'app', onSelectContainer: () => {}, containerSearchQuery: '', onContainerSearchChange: () => {}, tr }
  const render = () => fakeRender(() => PodLogsTab(props))
  const shown = () => textsOf(elementsOf(render(), (_, type) => type === 'pre')).join('')
  expect(shown()).toBe('Loading logs...')
  expect(FakeEventSource.opened.map((es) => new URL(es.url, 'http://x').searchParams.get('container'))).toEqual(['app'])
  return { es: FakeEventSource.opened[0], shown }
}

describe('the Logs tab of a followed log refused at the account\'s cap', () => {
  it('closes the stream and says why in place of the lines', () => {
    const { es, shown } = openTab()
    es.open()
    es.fire(STREAM_LIMIT_EVENT, 'followed_log_limit')
    expect(es.readyState, 'closed: the browser does not ask again').toBe(FakeEventSource.CLOSED)
    expect(shown()).toBe('» ' + followLimitText(tr) + '\n')
    expect(FakeEventSource.opened).toHaveLength(1)
  })

  it('keeps the lines it showed when its reconnect, after a server left, is refused at the cap', () => {
    const { es, shown } = openTab()
    es.open()
    es.line('one', '2026-11-20T00:00:01Z#1')
    es.drop()
    expect(es.readyState, 'a dropped connection is left to the browser').toBe(FakeEventSource.CONNECTING)
    expect(shown()).toBe('one\n')
    es.open()
    es.fire(STREAM_LIMIT_EVENT, 'followed_log_limit')
    expect(es.readyState).toBe(FakeEventSource.CLOSED)
    expect(shown()).toBe('one\n» ' + followLimitText(tr) + '\n')
  })

  it('reads the session\'s end apart from the cap', () => {
    const { es, shown } = openTab()
    es.open()
    es.line('one', '2026-11-20T00:00:01Z#1')
    es.fire(SESSION_ENDED_EVENT, 'session_signed_out')
    expect(es.readyState).toBe(FakeEventSource.CLOSED)
    expect(shown()).toBe('one\n» ' + liveSessionEndText(tr, 'session_signed_out') + '\n')
  })
})
