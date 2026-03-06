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
  private connecting: Promise<WebSocket> | null = null

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

    const wsUrl = `${getWsBase()}/api/v1/cluster/wsMultiplexer`
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
    }

    this.connecting = (async () => {
      await this.waitForOpen(socket)
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

    const socket = await this.connect()
    if (socket.readyState !== WebSocket.OPEN) {
      await this.waitForOpen(socket)
    }
    socket.send(JSON.stringify(msg))

    return () => this.unsubscribe(msg, onMessage)
  }

  unsubscribe(msg: ClientMessage, onMessage: Listener) {
    const key = makeKey(msg.path, msg.query)
    const set = this.listeners.get(key)
    if (!set) return
    set.delete(onMessage)
    if (set.size > 0) return

    this.listeners.delete(key)
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ ...msg, type: 'CLOSE' }))
    }
  }
}

export const watchMultiplexer = new WebSocketMultiplexer()
export type { ClientMessage, ServerMessage }
