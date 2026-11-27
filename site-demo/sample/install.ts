// Imported first by the demo entry, before any console module runs. It keeps the whole demo inside the page:
// - localStorage and sessionStorage are page memory, so a reload starts from the prepared state and nothing is kept;
// - fetch (and axios, switched to its fetch adapter), XMLHttpRequest, EventSource and WebSocket to /api/… are answered
//   from the sample data (./api); a request to anywhere else than the demo's own files is refused, so the page sends
//   nothing out. The demo's index.html also sets a Content-Security-Policy with connect-src 'self'.
import axios from 'axios'
import { handle, unsupported, type Reply } from './api'
import { advance, logFollow, watchRows } from './cluster'
import { logLines } from './logs'
import { hideSuggestions, terminalNote } from './notice'

// ---- Storage in page memory

class MemoryStorage {
  private items = new Map<string, string>()
  get length() { return this.items.size }
  key(index: number) { return [...this.items.keys()][index] ?? null }
  getItem(key: string) { return this.items.has(String(key)) ? this.items.get(String(key))! : null }
  setItem(key: string, value: string) { this.items.set(String(key), String(value)) }
  removeItem(key: string) { this.items.delete(String(key)) }
  clear() { this.items.clear() }
}
for (const name of ['localStorage', 'sessionStorage'] as const) {
  const store = new MemoryStorage()
  try { Object.defineProperty(window, name, { configurable: true, get: () => store }) } catch { /* checked below */ }
}
if (!(window.localStorage instanceof MemoryStorage) || !(window.sessionStorage instanceof MemoryStorage)) {
  // A browser that keeps its own storage objects: their methods write to a map per object instead.
  const maps = new WeakMap<Storage, Map<string, string>>()
  const of = (s: Storage) => { let m = maps.get(s); if (!m) { m = new Map(); maps.set(s, m) } return m }
  Object.assign(Storage.prototype, {
    getItem(this: Storage, k: string) { const m = of(this); return m.has(String(k)) ? m.get(String(k))! : null },
    setItem(this: Storage, k: string, v: string) { of(this).set(String(k), String(v)) },
    removeItem(this: Storage, k: string) { of(this).delete(String(k)) },
    clear(this: Storage) { of(this).clear() },
    key(this: Storage, i: number) { return [...of(this).keys()][i] ?? null },
  })
}

// ---- Where a request goes

const ownFiles = new URL(import.meta.env.BASE_URL, location.href)
const isOwnFile = (url: URL) => url.origin === location.origin && url.pathname.startsWith(ownFiles.pathname)
const isApi = (url: URL) => url.origin === location.origin && (url.pathname.startsWith('/api/') || url.pathname === '/health')
const isLocalData = (url: URL) => url.protocol === 'blob:' || url.protocol === 'data:'
const refused = (url: URL) => new TypeError('The demo sends no request outside the page: ' + url.origin + url.pathname)

const wait = (ms: number, signal?: AbortSignal | null) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
  const timer = window.setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { window.clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
})

function toResponse(reply: Reply, signal?: AbortSignal | null): Response {
  if (reply.stream) return new Response(reply.stream(signal), { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } })
  if (reply.status === 204 || reply.status === 304) return new Response(null, { status: reply.status })
  if (reply.text !== undefined) return new Response(reply.text, { status: reply.status, headers: reply.headers })
  return new Response(JSON.stringify(reply.data ?? null), { status: reply.status, headers: { 'Content-Type': 'application/json', ...(reply.headers || {}) } })
}

async function bodyText(body: unknown): Promise<string> {
  if (body == null) return ''
  if (typeof body === 'string') return body
  try { return await new Response(body as BodyInit).text() } catch { return '' }
}

// ---- fetch

const pageFetch = window.fetch.bind(window)
window.fetch = async function demoFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : null
  const url = new URL(request ? request.url : input instanceof URL ? input.href : String(input), location.href)
  if (isOwnFile(url) || isLocalData(url)) return pageFetch(input, init)
  if (!isApi(url)) {
    console.warn('[demo] refused', url.href)
    throw refused(url)
  }
  const method = String(init?.method || request?.method || 'GET').toUpperCase()
  const signal = init?.signal ?? request?.signal ?? null
  const text = init?.body != null ? await bodyText(init.body) : request && method !== 'GET' && method !== 'HEAD' ? await request.clone().text() : ''
  await wait(60, signal)
  return toResponse(handle(method, url, text), signal)
}

// The console's axios client is made with axios.create after this module has run, so it takes the fetch adapter too.
axios.defaults.adapter = 'fetch'

// ---- XMLHttpRequest (nothing in the demo uses it once axios takes fetch; answered the same way if anything does)

const xhrOpen = XMLHttpRequest.prototype.open
const xhrSend = XMLHttpRequest.prototype.send
const xhrTarget = new WeakMap<XMLHttpRequest, { method: string; url: URL }>()
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: any[]) {
  xhrTarget.set(this, { method: String(method).toUpperCase(), url: new URL(String(url), location.href) })
  return (xhrOpen as any).call(this, method, url, ...rest)
} as typeof XMLHttpRequest.prototype.open
XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
  const target = xhrTarget.get(this)
  if (!target || isOwnFile(target.url) || isLocalData(target.url)) return xhrSend.call(this, body)
  const xhr = this
  const settle = (status: number, text: string, headers: Record<string, string>) => {
    const own = (name: string, value: unknown) => Object.defineProperty(xhr, name, { configurable: true, get: () => value })
    own('readyState', 4); own('status', status); own('statusText', status === 200 ? 'OK' : '')
    own('responseText', text); own('response', xhr.responseType === 'json' ? (() => { try { return JSON.parse(text) } catch { return null } })() : text)
    own('responseURL', target.url.href)
    xhr.getAllResponseHeaders = () => Object.entries(headers).map(([k, v]) => k + ': ' + v).join('\r\n')
    xhr.getResponseHeader = (name: string) => headers[Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase()) || ''] ?? null
    for (const type of status ? ['readystatechange', 'load', 'loadend'] : ['readystatechange', 'error', 'loadend']) xhr.dispatchEvent(new ProgressEvent(type))
  }
  if (!isApi(target.url)) { console.warn('[demo] refused', target.url.href); window.setTimeout(() => settle(0, '', {}), 0); return }
  void bodyText(body).then(async (text) => {
    await wait(60)
    const reply = handle(target.method, target.url, text)
    if (reply.stream) { settle(501, JSON.stringify(unsupported(false).data), { 'Content-Type': 'application/json' }); return }
    settle(reply.status, reply.text ?? (reply.status === 204 ? '' : JSON.stringify(reply.data ?? null)), reply.headers || { 'Content-Type': 'application/json' })
  })
}

// ---- EventSource: the Helm list's stream says it follows; a followed Pod log sends its last lines and then each new one
// as it is written (an SSE id of `<UTC second>#<place in that second>`, as k8s-service sends). One that cannot be read says
// why and ends, as does one whose Pod goes; a browser opens an ended stream again after 3 s, from the last line it had. Any
// other stream ends, and the screen reads its list instead.

type Handler = ((this: any, ev: any) => any) | null
class DemoEventSource extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSED = 2
  readyState = 0
  readonly url: string
  readonly withCredentials: boolean
  onopen: Handler = null
  onmessage: Handler = null
  onerror: Handler = null
  constructor(url: string | URL, init?: EventSourceInit) {
    super()
    const target = new URL(String(url), location.href)
    this.url = target.href
    this.withCredentials = !!init?.withCredentials
    window.setTimeout(() => {
      if (this.readyState === 2) return
      if (isApi(target) && /\/helm\/releases\/stream$/.test(target.pathname)) {
        this.readyState = 1
        this.emit('open')
        this.emit('following', '{}')
        return
      }
      const log = isApi(target) && target.pathname.match(/\/cluster\/namespaces\/([^/]+)\/pods\/([^/]+)\/logs\/stream$/)
      if (log) {
        this.follow(decodeURIComponent(log[1]), decodeURIComponent(log[2]), target.searchParams.get('container') || undefined, Number(target.searchParams.get('tail_lines')) || 100)
        return
      }
      if (!isApi(target)) console.warn('[demo] refused', target.href)
      this.readyState = 2
      this.emit('error')
    }, 0)
  }
  private timer = 0
  private last = { t: 0, second: '', place: 0 }
  private ended() { return this.readyState === 2 }
  private follow(namespace: string, pod: string, container: string | undefined, tail: number) {
    if (this.ended()) return
    advance()
    this.readyState = 1
    this.emit('open')
    const read = (first: boolean) => {
      if (this.ended()) return
      const source = logFollow(namespace, pod, container)
      if (typeof source === 'string') {
        this.emit('error', source)
        if (this.ended()) return
        this.readyState = 0
        this.emit('error')
        if (!this.ended()) this.timer = window.setTimeout(() => this.follow(namespace, pod, container, tail), 3000)
        return
      }
      const lines = logLines(source)
      for (const line of first && !this.last.t ? lines.slice(-tail) : lines.filter((l) => l.t > this.last.t)) {
        const stamp = new Date(line.t).toISOString().slice(0, 19) + 'Z'
        this.last = { t: line.t, second: stamp, place: stamp === this.last.second ? this.last.place + 1 : 0 }
        this.emit('message', line.text, stamp + '#' + this.last.place)
        if (this.ended()) return
      }
      this.timer = window.setTimeout(() => read(false), 250)
    }
    read(true)
  }
  close() { this.readyState = 2; window.clearTimeout(this.timer) }
  private emit(type: string, data?: string, lastEventId = '') {
    const event = data === undefined ? new Event(type) : new MessageEvent(type, { data, lastEventId })
    this.dispatchEvent(event)
    const handler = (this as any)['on' + type] as Handler
    if (typeof handler === 'function') handler.call(this, event)
  }
}

// ---- WebSocket: the list watch socket sends a followed list's objects and then each change as the watch's own events
// (the nodes, a node's Pods); it acknowledges any other watch with RESYNC, so that list reads itself from the sample data.
// A terminal (pod exec, node shell) opens, says in its own window that the demo has no cluster to open it on, and closes.

interface Watch { message: { clusterId?: string; path: string; query: string }; rows: () => Array<Record<string, any>>; sent: Map<string, string> }

class DemoWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readyState = 0
  binaryType: BinaryType = 'blob'
  readonly bufferedAmount = 0
  readonly extensions = ''
  readonly protocol = ''
  readonly url: string
  onopen: Handler = null
  onmessage: Handler = null
  onerror: Handler = null
  onclose: Handler = null
  constructor(url: string | URL) {
    super()
    const target = new URL(String(url), location.href)
    this.url = target.href
    window.setTimeout(() => {
      if (this.readyState !== 0) return
      if (target.host === location.host && target.pathname.endsWith('/api/v1/cluster/wsMultiplexer')) {
        this.readyState = 1
        this.emit(new Event('open'))
        return
      }
      if (target.host === location.host && target.pathname.startsWith('/api/')) {
        this.readyState = 1
        this.emit(new Event('open'))
        this.emit(new MessageEvent('message', { data: terminalNote() }))
        this.readyState = 3
        this.emit(new CloseEvent('close', { code: 1000, reason: '', wasClean: true }))
        return
      }
      console.warn('[demo] refused', target.href)
      this.readyState = 3
      this.emit(new Event('error'))
      this.emit(new CloseEvent('close', { code: 1000, reason: 'not in the demo', wasClean: true }))
    }, 0)
  }
  send(data: string) {
    if (this.readyState !== 1) throw new DOMException('The socket is not open.', 'InvalidStateError')
    let message: any
    try { message = JSON.parse(String(data)) } catch { return }
    const key = message?.path + '?' + message?.query
    if (message?.type === 'CLOSE') { this.asked.delete(key); this.watches.delete(key); return }
    if (message?.type !== 'REQUEST') return
    this.asked.add(key)
    window.setTimeout(() => {
      if (this.readyState !== 1) return
      const rows = watchRows(String(message.path), String(message.query))
      if (!rows) { this.frame(message, { type: 'RESYNC' }); return }
      if (!this.asked.has(key)) return
      if (!this.watches.has(key)) this.watches.set(key, { message, rows, sent: new Map() })
      if (message.resync) this.frame(message, { type: 'RESYNC' })
      this.sendChanges()
    }, 30)
  }
  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return
    this.readyState = 3
    this.watches.clear()
    window.clearTimeout(this.timer)
    window.setTimeout(() => this.emit(new CloseEvent('close', { code, reason, wasClean: true })), 0)
  }
  private asked = new Set<string>()
  private watches = new Map<string, Watch>()
  private timer = 0
  private frame(to: Watch['message'], body: Record<string, unknown>) {
    this.emit(new MessageEvent('message', { data: JSON.stringify({ ...body, clusterId: to.clusterId, path: to.path, query: to.query }) }))
  }
  // What each followed list has not been sent yet, looked at every half second while one is followed.
  private sendChanges() {
    window.clearTimeout(this.timer)
    if (this.readyState !== 1 || !this.watches.size) return
    advance()
    for (const watch of this.watches.values()) {
      const now = new Map(watch.rows().map((row) => [(row.namespace ?? '') + '/' + row.name, row]))
      for (const [key, sent] of watch.sent) {
        if (now.has(key)) continue
        watch.sent.delete(key)
        this.frame(watch.message, { type: 'DATA', data: { type: 'DELETED', object: JSON.parse(sent) } })
      }
      for (const [key, row] of now) {
        const text = JSON.stringify(row), sent = watch.sent.get(key)
        if (text === sent) continue
        watch.sent.set(key, text)
        this.frame(watch.message, { type: 'DATA', data: { type: sent === undefined ? 'ADDED' : 'MODIFIED', object: row } })
      }
    }
    this.timer = window.setTimeout(() => this.sendChanges(), 500)
  }
  private emit(event: Event) {
    this.dispatchEvent(event)
    const handler = (this as any)['on' + event.type] as Handler
    if (typeof handler === 'function') handler.call(this, event)
  }
}

Object.defineProperty(window, 'EventSource', { configurable: true, writable: true, value: DemoEventSource })
Object.defineProperty(window, 'WebSocket', { configurable: true, writable: true, value: DemoWebSocket })

// A beacon would leave the page too.
if (navigator.sendBeacon) navigator.sendBeacon = () => false

// Bringing an element into view goes on to the page around a frame of the same origin, so a log followed line by line could
// keep the site's page from being scrolled: in the site's frame it moves the frame's own scroll boxes only.
if (window.parent !== window) {
  Element.prototype.scrollIntoView = function (this: Element, arg?: boolean | ScrollIntoViewOptions) {
    const options: ScrollIntoViewOptions = typeof arg === 'object' && arg ? arg : { block: arg === false ? 'end' : 'start' }
    const { block = 'start', behavior = 'auto' } = options
    for (let box = this.parentElement; box; box = box.parentElement) {
      const page = box === document.scrollingElement
      if (box.scrollHeight <= box.clientHeight || (!page && !/auto|scroll/.test(getComputedStyle(box).overflowY))) continue
      const top = page ? 0 : box.getBoundingClientRect().top + box.clientTop, bottom = top + box.clientHeight
      const at = this.getBoundingClientRect()
      const end = at.bottom - bottom, start = at.top - top
      const by = block === 'end' ? end : block === 'center' ? (start + end) / 2 : block === 'start' ? start : start < 0 ? start : end > 0 ? end : 0
      if (by) box.scrollBy({ top: by, behavior })
    }
  }
}

window.addEventListener('hashchange', hideSuggestions)
