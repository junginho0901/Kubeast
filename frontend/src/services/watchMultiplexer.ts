import { getCurrentClusterID } from './clusterRef'

type ClientMessage = {
  type: 'REQUEST' | 'CLOSE'
  clusterId: string
  path: string
  query: string
  userId?: string
}

type ServerMessage =
  | {
      type: 'DATA'
      path: string
      query: string
      data: any
    }
  | {
      type: 'ERROR'
      path: string
      query: string
      error: { message?: string }
    }
  | {
      type: 'COMPLETE'
      path: string
      query: string
    }

type Listener = (msg: ServerMessage) => void

const getWsBase = () => {
  const raw = (import.meta.env.VITE_WS_URL || '').trim()
  if (raw) {
    return raw.replace(/^http/, 'ws')
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}`
}

const makeKey = (path: string, query: string) => `${path}?${query}`

class WebSocketMultiplexer {
  private socket: WebSocket | null = null
  private listeners = new Map<string, Set<Listener>>()
  // subscriptions: WS reconnect 시 어떤 (path, query) 들을 다시 REQUEST 해야
  // 하는지 알아야 하므로 ClientMessage 자체를 별도 보관. listeners 와 1:1.
  private subscriptions = new Map<string, ClientMessage>()
  private connecting: Promise<WebSocket> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0

  private getReconnectDelay(): number {
    // exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s (max).
    const base = 1000
    const max = 30000
    return Math.min(base * Math.pow(2, this.reconnectAttempts), max)
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    if (this.subscriptions.size === 0) return // 구독자 없으면 reconnect 불필요
    const delay = this.getReconnectDelay()
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.reconnectAttempts += 1
      this.connect().catch(() => {
        // connect 실패 → 다시 backoff
        this.scheduleReconnect()
      })
    }, delay)
  }

  private waitForOpen(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.OPEN) return Promise.resolve()

    return new Promise<void>((resolve, reject) => {
      const handleOpen = () => {
        cleanup()
        resolve()
      }
      const handleError = () => {
        cleanup()
        reject(new Error('WebSocket connection failed'))
      }
      const handleClose = () => {
        cleanup()
        reject(new Error('WebSocket closed before open'))
      }
      const cleanup = () => {
        socket.removeEventListener('open', handleOpen)
        socket.removeEventListener('error', handleError)
        socket.removeEventListener('close', handleClose)
      }
      socket.addEventListener('open', handleOpen)
      socket.addEventListener('error', handleError)
      socket.addEventListener('close', handleClose)
    })
  }

  private async connect(): Promise<WebSocket> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return this.socket
    }

    if (this.socket && this.socket.readyState === WebSocket.CONNECTING) {
      await this.waitForOpen(this.socket)
      return this.socket
    }

    if (this.connecting) {
      return this.connecting
    }

    // The handshake is gated on ?cluster= like every REST call (k8s-service
    // ClusterMiddleware); without it the server checks the default cluster,
    // which a user with a grant on another cluster only cannot open. Each
    // REQUEST message still names its own clusterId and is gated again.
    const cid = getCurrentClusterID()
    const wsUrl = `${getWsBase()}/api/v1/cluster/wsMultiplexer${cid ? `?cluster=${encodeURIComponent(cid)}` : ''}`
    const socket = new WebSocket(wsUrl)
    this.socket = socket

    socket.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data) as ServerMessage
        const key = makeKey(msg.path, msg.query)
        const handlers = this.listeners.get(key)
        if (handlers) {
          handlers.forEach((fn) => fn(msg))
        }
      } catch (err) {
        console.warn('watch multiplexer parse error', err)
      }
    }

    socket.onclose = () => {
      this.socket = null
      this.connecting = null
      // 구독자가 남아있으면 backoff 후 자동 reconnect.
      this.scheduleReconnect()
    }

    this.connecting = (async () => {
      await this.waitForOpen(socket)
      // 연결 성공 시 backoff counter reset + 기존 구독 전부 재전송.
      this.reconnectAttempts = 0
      for (const msg of this.subscriptions.values()) {
        try {
          socket.send(JSON.stringify(msg))
        } catch {
          // send 실패는 onclose 가 처리.
        }
      }
      return socket
    })()

    try {
      return await this.connecting
    } finally {
      this.connecting = null
    }
  }

  async subscribe(msg: ClientMessage, onMessage: Listener): Promise<() => void> {
    const key = makeKey(msg.path, msg.query)
    const set = this.listeners.get(key) || new Set()
    set.add(onMessage)
    this.listeners.set(key, set)

    const wasNewSubscription = !this.subscriptions.has(key)
    this.subscriptions.set(key, msg)

    // connect() 가 새 socket 을 만들면 onopen 에서 모든 subscriptions 의
    // REQUEST 를 전송. 이미 OPEN 인 socket 에 새 subscription 이 추가되는
    // 경우만 여기서 직접 REQUEST 보냄 (dedup: 기존 subscription 은 무시).
    const wasOpenBefore = this.socket?.readyState === WebSocket.OPEN
    const socket = await this.connect()
    if (socket.readyState !== WebSocket.OPEN) {
      await this.waitForOpen(socket)
    }
    if (wasOpenBefore && wasNewSubscription) {
      socket.send(JSON.stringify(msg))
    }

    return () => this.unsubscribe(msg, onMessage)
  }

  unsubscribe(msg: ClientMessage, onMessage: Listener) {
    const key = makeKey(msg.path, msg.query)
    const set = this.listeners.get(key)
    if (!set) return
    set.delete(onMessage)
    if (set.size > 0) return

    this.listeners.delete(key)
    this.subscriptions.delete(key)
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ ...msg, type: 'CLOSE' }))
    }
  }
}

export const watchMultiplexer = new WebSocketMultiplexer()
export { WebSocketMultiplexer }
export type { ClientMessage, ServerMessage }
