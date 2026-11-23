import { describe, expect, it } from 'vitest'
import { SESSION_ENDED_EVENT } from '@/services/auth'
import { STREAM_LIMIT_EVENT } from '@/utils/serverShutdown'
import { followLogFile, SOURCE_CONNECTING, type FollowSource, type FollowStop } from './logFileFollow'

// A stand-in EventSource the test drives: what the browser does when a server leaves, when it refuses the
// reconnect, and when the server itself ends the stream.
const OPEN = 1
const CLOSED = 2

class FakeSource implements FollowSource {
  readyState = OPEN
  onopen: ((e: Event) => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  closed = false
  private listeners = new Map<string, ((e: Event) => void)[]>()
  addEventListener(type: string, listener: (e: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  close() {
    this.closed = true
    this.readyState = CLOSED
  }
  emit(type: string, data?: string) {
    const e = data === undefined ? new Event(type) : new MessageEvent(type, { data })
    this.listeners.get(type)?.forEach((fn) => fn(e))
  }
  line(text: string) {
    this.onmessage?.(new MessageEvent('message', { data: text }))
  }
  // The connection drops and the browser tries again (readyState CONNECTING), then opens again.
  drop() {
    this.readyState = SOURCE_CONNECTING
    this.emit('error')
  }
  reopen() {
    this.readyState = OPEN
    this.onopen?.(new Event('open'))
  }
}

const follow = () => {
  const es = new FakeSource()
  const seen = { lines: [] as string[], notices: [] as string[], reconnecting: [] as boolean[], stops: [] as FollowStop[] }
  followLogFile(es, {
    line: (t) => seen.lines.push(t),
    notice: (t) => seen.notices.push(t),
    reconnecting: (on) => seen.reconnecting.push(on),
    stopped: (why) => seen.stops.push(why),
  })
  return { es, seen }
}

describe('a followed log file', () => {
  it('keeps following when the server leaves: it says it is reconnecting, then goes on', () => {
    const { es, seen } = follow()
    es.line('l1')
    es.drop()
    expect(seen.reconnecting).toEqual([true])
    expect(es.closed).toBe(false)
    expect(seen.stops).toEqual([])
    es.reopen()
    es.line('l2')
    expect(seen.reconnecting).toEqual([true, false])
    expect(seen.lines).toEqual(['l1', 'l2'])
    expect(seen.stops).toEqual([])
  })

  it('stops when the reconnect is refused (the browser gives up: CLOSED)', () => {
    const { es, seen } = follow()
    es.drop()
    es.readyState = CLOSED
    es.emit('error')
    expect(es.closed).toBe(true)
    expect(seen.stops).toEqual([{ kind: 'error', reason: undefined }])
    expect(seen.reconnecting).toEqual([true, false])
  })

  it('stops with the server\'s reason on its error event, without reconnecting', () => {
    const { es, seen } = follow()
    es.readyState = SOURCE_CONNECTING // the event comes before the stream closes, whatever the state
    es.emit('error', 'permission denied')
    expect(es.closed).toBe(true)
    expect(seen.stops).toEqual([{ kind: 'error', reason: 'permission denied' }])
    expect(seen.reconnecting).toEqual([false])
  })

  it('stops on the server\'s end and on the session\'s end', () => {
    const ended = follow()
    ended.es.emit('end', 'stream ended')
    expect(ended.es.closed).toBe(true)
    expect(ended.seen.stops).toEqual([{ kind: 'end' }])

    const session = follow()
    session.es.emit(SESSION_ENDED_EVENT, 'session_revoked')
    expect(session.es.closed).toBe(true)
    expect(session.seen.stops).toEqual([{ kind: 'session', code: 'session_revoked' }])
  })

  it('stops, without reconnecting, when the server refuses it at the account\'s cap', () => {
    const { es, seen } = follow()
    es.emit(STREAM_LIMIT_EVENT, 'followed_log_limit')
    expect(es.closed).toBe(true)
    expect(seen.stops).toEqual([{ kind: 'limit' }])
    expect(seen.reconnecting).toEqual([false])
    expect(seen.lines).toEqual([])
  })

  it('shows the server\'s notices as notices', () => {
    const { es, seen } = follow()
    es.emit('notice', 'the file was replaced or truncated while reconnecting; showing its last lines')
    expect(seen.notices).toEqual(['the file was replaced or truncated while reconnecting; showing its last lines'])
    expect(seen.lines).toEqual([])
  })
})
