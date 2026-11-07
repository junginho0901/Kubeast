import { getCurrentClusterID } from './clusterRef'
import { liveSessionEnded, SESSION_ENDED_CLOSE_CODE } from './auth'
import { clearWatchProblem, recordWatchFrame } from './watchProblemStore'

type ClientMessage = {
  type: 'REQUEST' | 'CLOSE'
  clusterId: string
  path: string
  query: string
  userId?: string
  // the client missed what happened before this watch: the server answers one RESYNC once it is on
  resync?: boolean
}

type ServerMessage = {
  // the cluster its REQUEST named; a server older than this field leaves it out
  clusterId?: string
  path: string
  query: string
} & (
  | { type: 'DATA'; data: any }
  | { type: 'ERROR'; error: { message?: string; reason?: string; limit_scope?: string } }
  | { type: 'COMPLETE' }
  // the watch started over and cannot say what was deleted meanwhile: read the list again
  | { type: 'RESYNC' }
  // what a watch of changes covers changed (notify=1 in its query)
  | { type: 'CHANGED' }
)

type Listener = (msg: ServerMessage) => void

const getWsBase = () => {
  const raw = (import.meta.env.VITE_WS_URL || '').trim()
  if (raw) {
    return raw.replace(/^http/, 'ws')
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}`
}

const makeKey = (clusterId: string, path: string, query: string) => `${clusterId}\n${path}?${query}`

// A watch of changes sends no objects as it opens, so after a socket's gap only a read can say what it missed.
const watchesChanges = (query: string) => new URLSearchParams(query).get('notify') === '1'

// How long a watch refused a place waits to ask again: doubling up to the cap, each wait somewhere between half and one
// and a half of that, since the tabs a full server refuses were refused together.
const REFUSED_WAIT_MS = 30_000
const REFUSED_WAIT_MAX_MS = 300_000
const refusedWait = (tries: number) => Math.min(REFUSED_WAIT_MS * 2 ** tries, REFUSED_WAIT_MAX_MS) * (0.5 + Math.random())

const tabHidden = () => typeof document !== 'undefined' && document?.visibilityState === 'hidden'

class WebSocketMultiplexer {
  private socket: WebSocket | null = null
  private listeners = new Map<string, Set<Listener>>()
  // subscriptions: WS reconnect 시 어떤 (cluster, path, query) 들을 다시 REQUEST
  // 해야 하는지 알아야 하므로 ClientMessage 자체를 별도 보관. listeners 와 1:1.
  private subscriptions = new Map<string, ClientMessage>()
  private connecting: Promise<WebSocket> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private lastSessionEnd = 0
  // the watches the server refused a place, and how many times
  private refused = new Map<string, number>()
  private refusedTimer: ReturnType<typeof setTimeout> | null = null
  // the watches an earlier socket carried
  private carried = new Set<string>()
  // the watches a frame has answered on this socket
  private answered = new Set<string>()
  private closeListeners = new Set<() => void>()

  private getReconnectDelay(): number {
    // exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s (max); a restart closes every socket at once, so each waits half of that to all of it.
    const base = 1000
    const max = 30000
    const ceiling = Math.min(base * Math.pow(2, this.reconnectAttempts), max)
    return ceiling / 2 + Math.random() * (ceiling / 2)
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

  // A frame goes to the cluster it names, so one still on its way when the screen moved to another cluster goes
  // nowhere. A server that does not name clusters yet (an upgrade under way) leaves only the path and query to go by.
  private dispatch(msg: ServerMessage) {
    if (msg.clusterId) {
      const key = makeKey(msg.clusterId, msg.path, msg.query)
      if (this.listeners.has(key)) this.noteFrame(key, msg)
      this.listeners.get(key)?.forEach((fn) => fn(msg))
      return
    }
    for (const [key, sub] of this.subscriptions) {
      if (sub.path === msg.path && sub.query === msg.query) {
        this.noteFrame(key, msg)
        this.listeners.get(key)?.forEach((fn) => fn(msg))
      }
    }
  }

  private noteFrame(key: string, msg: ServerMessage) {
    recordWatchFrame(key, msg)
    if (msg.type === 'ERROR') this.answered.delete(key)
    else this.answered.add(key)
    if (msg.type === 'ERROR' && msg.error?.reason === 'limit') {
      this.refused.set(key, (this.refused.get(key) ?? -1) + 1)
      this.scheduleAskingRefused()
    } else {
      this.refused.delete(key)
    }
  }

  // Other refusals stay until the grant changes, and that ends the socket; a place may free up with nothing to say so.
  // A hidden tab takes no place from one somebody is looking at: it asks again soon after it shows.
  private scheduleAskingRefused() {
    if (this.refusedTimer || this.refused.size === 0) return
    this.refusedTimer = setTimeout(() => {
      this.refusedTimer = null
      if (tabHidden()) this.scheduleAskingRefused()
      else this.askRefused(this.refused.size)
    }, refusedWait(tabHidden() ? 0 : Math.max(...this.refused.values())))
  }

  // The answer is a frame: a refusal schedules the next time, a place ends it with the RESYNC this asks for.
  private askRefused(count: number) {
    if (this.socket?.readyState !== WebSocket.OPEN || tabHidden()) return
    for (const key of [...this.refused.keys()].slice(0, count)) {
      const msg = this.subscriptions.get(key)
      if (msg) this.socket.send(JSON.stringify({ ...msg, resync: true }))
    }
  }

  private forgetRefused() {
    this.refused.clear()
    if (this.refusedTimer) clearTimeout(this.refusedTimer)
    this.refusedTimer = null
  }

  // Whether this list is followed already, which a drawer on one of its objects can share.
  follows(clusterId: string, path: string, query: string): boolean {
    return this.subscriptions.has(makeKey(clusterId, path, query))
  }

  // Whether a frame has come on this socket: who joins such a watch hears nothing until something changes.
  answers(clusterId: string, path: string, query: string): boolean {
    return this.answered.has(makeKey(clusterId, path, query))
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
        this.dispatch(JSON.parse(evt.data) as ServerMessage)
      } catch (err) {
        console.warn('watch multiplexer parse error', err)
      }
    }

    socket.onclose = (event) => {
      this.socket = null
      this.connecting = null
      this.answered.clear()
      this.closeListeners.forEach((listener) => listener())
      if (event?.code === SESSION_ENDED_CLOSE_CODE) {
        const lastEnd = this.lastSessionEnd
        this.lastSessionEnd = Date.now()
        void liveSessionEnded(lastEnd).then((reopen) => {
          if (reopen) this.scheduleReconnect()
        })
        return
      }
      // 구독자가 남아있으면 backoff 후 자동 reconnect.
      this.scheduleReconnect()
    }

    this.connecting = (async () => {
      await this.waitForOpen(socket)
      // 연결 성공 시 backoff counter reset + 기존 구독 전부 재전송.
      this.reconnectAttempts = 0
      // A watch that still cannot start says so again.
      for (const key of this.subscriptions.keys()) clearWatchProblem(key)
      this.forgetRefused()
      for (const [key, msg] of this.subscriptions) {
        try {
          socket.send(JSON.stringify(this.carried.has(key) && watchesChanges(msg.query) ? { ...msg, resync: true } : msg))
          this.carried.add(key)
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

  // Told each time the socket closes: its watches have stopped, and no frame says so.
  onSocketClosed(listener: () => void): () => void {
    this.closeListeners.add(listener)
    return () => {
      this.closeListeners.delete(listener)
    }
  }

  async subscribe(msg: ClientMessage, onMessage: Listener): Promise<() => void> {
    const key = makeKey(msg.clusterId, msg.path, msg.query)
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
    // dropped while connecting (unsubscribe ran first): nothing to ask for
    if (wasOpenBefore && wasNewSubscription && this.listeners.get(key)?.has(onMessage)) {
      socket.send(JSON.stringify(msg))
      this.carried.add(key)
    }

    return () => this.unsubscribe(msg, onMessage)
  }

  unsubscribe(msg: ClientMessage, onMessage: Listener) {
    const key = makeKey(msg.clusterId, msg.path, msg.query)
    const set = this.listeners.get(key)
    if (!set) return
    set.delete(onMessage)
    if (set.size > 0) return

    this.listeners.delete(key)
    clearWatchProblem(key)
    this.subscriptions.delete(key)
    this.carried.delete(key)
    this.answered.delete(key)
    const heldAPlace = !this.refused.delete(key)
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ ...msg, type: 'CLOSE' }))
      // The place it held goes to a watch of this tab that was refused one.
      if (heldAPlace) this.askRefused(1)
    }
  }
}

export const watchMultiplexer = new WebSocketMultiplexer()
export { WebSocketMultiplexer }
export type { ClientMessage, ServerMessage }
