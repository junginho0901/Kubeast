// watchMultiplexer 단위 테스트.
//
// 핵심 검증: WS 가 끊겼을 때 자동 reconnect + 모든 기존 (path, query) 구독을
// 백엔드에 다시 REQUEST 하는지 확인. 이전엔 socket.onclose 가 socket=null 만
// 하고 listeners 는 그대로 살아있어서, 다음 mount 가 일어날 때까지 watch 가
// 영구 중단 (= ClusterView 의 'Deleting...' 라벨이 안 풀리던 증상의 root
// cause).
//
// jsdom 없이 node 환경에서 실행 — WebSocket 을 직접 mock 으로 교체.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WebSocketMultiplexer } from './watchMultiplexer'

// import.meta.env / window 는 vite 가 아니라 node 에서 실행되므로 직접 stub.
;(globalThis as any).import_meta_env_VITE_WS_URL = 'ws://test.local'
;(globalThis as any).window = {
  location: { protocol: 'http:', host: 'test.local' },
}

class MockWebSocket {
  static OPEN = 1
  static CLOSED = 3
  static CONNECTING = 0
  static CLOSING = 2
  static instances: MockWebSocket[] = []

  readyState = MockWebSocket.CONNECTING
  url: string
  sent: string[] = []
  onmessage: ((evt: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null
  private eventListeners = new Map<string, Set<(payload?: unknown) => void>>()

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  static reset() {
    MockWebSocket.instances = []
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
    this.fire('close')
    this.onclose?.()
  }

  addEventListener(event: string, fn: (payload?: unknown) => void) {
    const set = this.eventListeners.get(event) ?? new Set()
    set.add(fn)
    this.eventListeners.set(event, set)
  }

  removeEventListener(event: string, fn: (payload?: unknown) => void) {
    this.eventListeners.get(event)?.delete(fn)
  }

  private fire(event: string, payload?: unknown) {
    this.eventListeners.get(event)?.forEach((fn) => fn(payload))
  }

  // --- 시뮬레이션 helpers (테스트에서 호출) ---

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN
    this.fire('open')
    this.onopen?.()
  }

  simulateMessage(data: unknown) {
    const evt = { data: typeof data === 'string' ? data : JSON.stringify(data) }
    this.onmessage?.(evt)
  }

  simulateServerClose() {
    // 서버가 일방적으로 끊은 케이스 (proxy idle timeout 등)
    this.readyState = MockWebSocket.CLOSED
    this.fire('close')
    this.onclose?.()
  }
}

(globalThis as any).WebSocket = MockWebSocket

// import.meta.env 는 vitest 의 vite 환경에서 자동 주입되지만, env value 가
// 비어있으면 watchMultiplexer 가 window.location 으로 fallback. test 에서는
// 비워둬도 동작 — 위에서 window mock 셋업.

// microtask 기반 flush — fake timer 가 setTimeout 을 가로채도 영향 없음.
// promise chain 한두 단계 진행시키는 용도.
const flush = async () => {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve()
  }
}

// 매 테스트마다 새 인스턴스를 받기 위해 모듈 리셋.

describe('WebSocketMultiplexer', () => {
  beforeEach(() => {
    MockWebSocket.reset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('첫 subscribe 시 WS 연결 + REQUEST 전송', async () => {
    const mux = new WebSocketMultiplexer()

    const listener = vi.fn()
    const subPromise = mux.subscribe(
      { type: 'REQUEST', clusterId: 'default', path: '/api/v1/pods', query: 'watch=1' },
      listener,
    )
    await flush()

    const ws = MockWebSocket.instances[0]
    expect(ws).toBeDefined()
    ws.simulateOpen()

    const unsub = await subPromise

    expect(ws.sent).toHaveLength(1)
    expect(JSON.parse(ws.sent[0])).toMatchObject({
      type: 'REQUEST',
      path: '/api/v1/pods',
      query: 'watch=1',
    })

    unsub()
  })

  it('같은 path+query 두 번째 subscribe 는 REQUEST 재전송 안 함 (dedup)', async () => {
    const mux = new WebSocketMultiplexer()
    const msg = { type: 'REQUEST' as const, clusterId: 'default', path: '/api/v1/pods', query: 'watch=1' }

    const p1 = mux.subscribe(msg, vi.fn())
    await flush()
    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    await p1

    const p2 = mux.subscribe(msg, vi.fn())
    await flush()
    await p2

    // REQUEST 는 첫 구독에서 1회만 전송. 두 번째 listener 는 같은 stream 사용.
    expect(ws.sent).toHaveLength(1)
  })

  it('WS 가 close 되면 backoff 후 자동 reconnect + 기존 subscription REQUEST 재전송', async () => {
    const mux = new WebSocketMultiplexer()
    const listener = vi.fn()
    const msg = { type: 'REQUEST' as const, clusterId: 'default', path: '/api/v1/pods', query: 'watch=1' }

    const p = mux.subscribe(msg, listener)
    await flush()
    const ws1 = MockWebSocket.instances[0]
    ws1.simulateOpen()
    await p

    expect(ws1.sent).toHaveLength(1) // 첫 REQUEST

    // 서버가 끊음
    ws1.simulateServerClose()

    // 첫 backoff 는 1s.
    await vi.advanceTimersByTimeAsync(1000)
    await flush()

    expect(MockWebSocket.instances).toHaveLength(2)
    const ws2 = MockWebSocket.instances[1]
    ws2.simulateOpen()
    await flush()

    // reconnect 후 자동으로 같은 REQUEST 재전송.
    expect(ws2.sent).toHaveLength(1)
    expect(JSON.parse(ws2.sent[0])).toMatchObject({
      type: 'REQUEST',
      path: '/api/v1/pods',
      query: 'watch=1',
    })

    // 새 socket 으로 도착한 메시지가 listener 에 전달.
    ws2.simulateMessage({ type: 'DATA', path: '/api/v1/pods', query: 'watch=1', data: { type: 'ADDED' } })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'DATA' }))
  })

  it('구독자가 모두 unsubscribe 한 뒤 WS 가 끊기면 reconnect 안 함', async () => {
    const mux = new WebSocketMultiplexer()
    const msg = { type: 'REQUEST' as const, clusterId: 'default', path: '/api/v1/pods', query: 'watch=1' }

    const subPromise = mux.subscribe(msg, vi.fn())
    await flush()
    const ws1 = MockWebSocket.instances[0]
    ws1.simulateOpen()
    const unsub = await subPromise

    unsub() // 마지막 구독 해제

    ws1.simulateServerClose()
    await vi.advanceTimersByTimeAsync(60000) // 충분히 기다림
    await flush()

    // 새 소켓이 만들어지지 않아야 함.
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('reconnect 가 실패하면 backoff 가 늘어남 (1s → 2s → 4s)', async () => {
    const mux = new WebSocketMultiplexer()
    const msg = { type: 'REQUEST' as const, clusterId: 'default', path: '/api/v1/pods', query: 'watch=1' }

    const p = mux.subscribe(msg, vi.fn())
    await flush()
    const ws1 = MockWebSocket.instances[0]
    ws1.simulateOpen()
    await p

    // 1차 끊김 → 1s 후 reconnect 시도
    ws1.simulateServerClose()
    await vi.advanceTimersByTimeAsync(1000)
    await flush()
    expect(MockWebSocket.instances).toHaveLength(2)
    const ws2 = MockWebSocket.instances[1]

    // 2차 끊김 (open 도 못 한 채) → 2s 후 reconnect
    ws2.simulateServerClose()
    await vi.advanceTimersByTimeAsync(1500)
    await flush()
    expect(MockWebSocket.instances).toHaveLength(2) // 아직 안 옴

    await vi.advanceTimersByTimeAsync(700)
    await flush()
    expect(MockWebSocket.instances).toHaveLength(3) // 2s 경과 후 옴
  })

  it('마지막 listener unsubscribe 시 backend 에 CLOSE 전송', async () => {
    const mux = new WebSocketMultiplexer()
    const msg = { type: 'REQUEST' as const, clusterId: 'default', path: '/api/v1/pods', query: 'watch=1' }

    const subPromise = mux.subscribe(msg, vi.fn())
    await flush()
    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    const unsub = await subPromise

    expect(ws.sent).toHaveLength(1) // REQUEST

    unsub()
    expect(ws.sent).toHaveLength(2) // CLOSE
    expect(JSON.parse(ws.sent[1])).toMatchObject({
      type: 'CLOSE',
      path: '/api/v1/pods',
      query: 'watch=1',
    })
  })
})
