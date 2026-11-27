// The sample containers' output: a backlog that fits each app, then a new line every 0.5–2 s stamped with the time it
// appears. Lines are made when they are read (a Pod window's read, a followed log), never by a timer of their own, and
// each container keeps its newest 1 000. The crash-looping checkout-api starts again every 20 s and ends on its error.

export type LogStyle = 'web' | 'api' | 'ingress' | 'worker' | 'postgres' | 'valkey' | 'prometheus' | 'loki' | 'tempo' | 'grafana'
  | 'opencost' | 'agent' | 'coredns' | 'argocd' | 'reloader' | 'crash' | 'job' | 'jobfail'

// What one container's log is made from: its app, the Pod's address, and whether it is writing now.
export interface LogSource { key: string; style: LogStyle; app: string; image: string; ip: string; live: boolean; at: number }
export interface LogLine { t: number; text: string }

// When the page opened: the sample's "now" for what happened before it (the backlog, a node going away).
export const boot = Date.now()
const KEEP = 1000
const BACKLOG = 150
const CRASH_EVERY = 20_000
const CRASH_TAKES = 3500
// When the checkout-api change that does not start went out: about 25 minutes before the page opened, on the minute. The
// audit records, the alert and the graphs of the prepared answers are placed from it.
export const incident = Math.floor(boot / 60_000) * 60_000 - 25 * 60_000

// A crash-looping container's runs, from when its Pod was made (`at`): one every 20 s, and one under way as the page opens.
const firstRun = (at: number) => at + (at === incident ? (boot - 2000 - incident) % CRASH_EVERY : 0)
export const crashRuns = (at: number, now = Date.now()) => 1 + Math.max(0, Math.floor((now - firstRun(at)) / CRASH_EVERY))
export const crashRunAt = (at: number, run: number) => firstRun(at) + (run - 1) * CRASH_EVERY
export const crashRunEnd = (at: number, run: number) => crashRunAt(at, run) + CRASH_TAKES
// The runs that have ended: all of them, or all but the one under way.
export const crashEnded = (at: number, now = Date.now()) => crashRuns(at, now) - (now < crashRunEnd(at, crashRuns(at, now)) ? 1 : 0)

function rnd(key: string, n: number, salt: string): number {
  let h = 2166136261
  const s = key + '|' + n + '|' + salt
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  h ^= h >>> 13
  h = Math.imul(h, 0x5bd1e995)
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296
}
const pick = <T>(list: T[], r: number): T => list[Math.min(list.length - 1, Math.floor(r * list.length))]
const iso = (t: number) => new Date(t).toISOString()
const num = (r: number, from: number, to: number) => Math.floor(from + r * (to - from + 1))

const ROUTES: Record<string, Array<[string, string]>> = {
  storefront: [['GET', '/'], ['GET', '/products/{id}'], ['GET', '/products/{id}'], ['GET', '/cart'], ['POST', '/cart/items'], ['GET', '/search?q=running+shoes'], ['GET', '/static/js/app.3f9c1e.js']],
  catalog: [['GET', '/v1/items?category=shoes&page=2'], ['GET', '/v1/items/{id}'], ['GET', '/v1/items/{id}'], ['GET', '/v1/categories']],
  search: [['POST', '/v1/products/_search'], ['POST', '/v1/products/_search'], ['GET', '/v1/suggest?q=run']],
  'payment-api': [['POST', '/v1/payments'], ['GET', '/v1/payments/pay_{id}'], ['POST', '/v1/refunds']],
  notifications: [['POST', '/v1/notify/email'], ['POST', '/v1/notify/push']],
  'policy-reporter': [['GET', '/api/v1/reports?namespace=commerce'], ['GET', '/api/v1/results']],
  analytics: [['POST', '/v1/events'], ['POST', '/v1/events']],
  'event-router': [['POST', '/v1/route'], ['POST', '/v1/route']],
}
const PEERS = ['10.244.1.80', '10.244.2.81', '10.244.3.22', '10.244.4.23', '10.244.5.94']

function line(src: LogSource, n: number, t: number): string {
  const r = (salt: string) => rnd(src.key, n, salt)
  const ts = iso(t)
  const id = num(r('id'), 1000, 9999)
  const ms = Math.round(3 + r('lat') ** 4 * 1400)
  const odd = r('odd')
  switch (src.style) {
    case 'web':
    case 'api': {
      if (r('probe') < 0.12) return `${ts} INFO  GET /healthz 200 1ms remote=${src.ip.replace(/\.\d+$/, '.1')}`
      const [method, path] = pick(ROUTES[src.app] ?? [['GET', '/v1/status']], r('route'))
      const status = odd < 0.012 ? 503 : odd < 0.04 ? 404 : method === 'POST' ? 201 : 200
      const level = status >= 500 ? 'ERROR' : ms > 900 ? 'WARN ' : 'INFO '
      const tail = status >= 500 ? ' error="upstream request timeout"' : ms > 900 ? ' slow=true' : ''
      return `${ts} ${level} ${method} ${path.replace('{id}', String(id))} ${status} ${ms}ms remote=${pick(PEERS, r('peer'))}${tail}`
    }
    case 'ingress': {
      const when = new Date(t).toUTCString().replace(/^\w+, (\d+) (\w+) (\d+) ([\d:]+) GMT$/, '$1/$2/$3:$4 +0000')
      const client = '198.51.100.' + num(r('c'), 2, 250)
      if (r('route') < 0.12) {
        return `${client} - - [${when}] "POST /api/checkout/orders HTTP/2.0" 503 190 "https://shop.northstar.example/cart" "Mozilla/5.0" 0.001 [commerce-checkout-api-80] - - - 503 ${(id * 7919).toString(16)}`
      }
      const grafana = r('host') < 0.15
      const path = grafana ? '/api/ds/query' : pick(['/', '/products/' + id, '/cart', '/search?q=boots', '/static/js/app.3f9c1e.js'], r('p'))
      const upstream = grafana ? '10.244.6.53:3000' : pick(['10.244.1.21:8080', '10.244.2.12:8080'], r('u'))
      const status = odd < 0.03 ? 404 : 200
      return `${client} - - [${when}] "${grafana ? 'POST' : 'GET'} ${path} HTTP/2.0" ${status} ${num(r('b'), 400, 48000)} "-" "Mozilla/5.0" ${(ms / 1000).toFixed(3)} [${grafana ? 'observability-grafana-80' : 'commerce-storefront-80'}] ${upstream} ${status} ${(id * 104729).toString(16)}`
    }
    case 'worker':
      if (src.app === 'image-worker') {
        return odd < 0.04 ? `${ts} WARN  job=img-${id} retry=1 reason="source image read timed out"` : `${ts} INFO  job=img-${id} variants=3 size=${num(r('s'), 80, 2400)}KiB took=${ms}ms`
      }
      return odd < 0.03 ? `${ts} WARN  topic=order.created order=ord-${id} redelivered=true` : `${ts} INFO  consumed topic=${pick(['order.created', 'order.paid', 'cart.abandoned'], r('topic'))} order=ord-${id} took=${ms}ms`
    case 'postgres': {
      const at = iso(t).replace('T', ' ').replace('Z', ' UTC')
      const pid = 4100 + (((n % 300) + 300) % 300)
      const step = ((n % 40) + 40) % 40
      if (step === 0) return `${at} [58] LOG:  checkpoint starting: time`
      if (step === 1) return `${at} [58] LOG:  checkpoint complete: wrote ${num(r('w'), 80, 900)} buffers (${(r('p') * 5).toFixed(1)}%); 0 WAL file(s) added, 0 removed, 1 recycled; write=${(r('x') * 30).toFixed(3)} s, sync=0.004 s, total=${(r('x') * 30 + 0.01).toFixed(3)} s`
      if (step % 3 === 0) return `${at} [${pid}] LOG:  connection received: host=10.244.2.30 port=${num(r('port'), 40000, 60000)}`
      if (step % 3 === 1) return `${at} [${pid}] LOG:  connection authorized: user=ledger database=ledger application_name=payment-api`
      return odd < 0.03
        ? `${at} [${pid}] ERROR:  duplicate key value violates unique constraint "entries_idempotency_key"`
        : `${at} [${pid}] LOG:  disconnection: session time: 0:00:0${num(r('s'), 1, 9)}.${num(r('ms'), 100, 999)} user=ledger database=ledger host=10.244.2.30`
    }
    case 'valkey': {
      const at = new Date(t).toUTCString().replace(/^\w+, (\d+) (\w+) (\d+) ([\d:]+) GMT$/, '$1 $2 $3 $4') + '.' + String(t % 1000).padStart(3, '0')
      const step = ((n % 5) + 5) % 5
      return `1:M ${at} * ` + ['100 changes in 300 seconds. Saving...', 'Background saving started by pid ' + (400 + Math.floor(n / 5)), 'DB saved on disk', 'Fork CoW for RDB: current 1 MB, peak 1 MB, average 1 MB', 'Background saving terminated with success'][step]
    }
    case 'prometheus':
      if (odd < 0.08) return `time=${ts} level=WARN source=scrape.go:1561 msg="Scrape failed" component="scrape manager" scrape_pool=kubernetes-pods target=http://10.244.8.${pick(['70', '82'], r('t'))}:8080/metrics err="Get \\"http://10.244.8.70:8080/metrics\\": context deadline exceeded"`
      return `time=${ts} level=INFO source=${pick(['head.go:1288', 'compact.go:582', 'checkpoint.go:101', 'manager.go:173'], r('s'))} msg=${pick(['"Head GC completed" component=tsdb caller=truncateMemory duration=' + ms + 'ms', '"write block" component=tsdb mint=' + (t - 7200000) + ' maxt=' + t + ' duration=' + ms + 'ms', '"Creating checkpoint" component=tsdb from_segment=' + (4200 + n) + ' to_segment=' + (4202 + n), '"Rule group evaluation" group=kubernetes-apps duration=' + ms + 'ms'], r('m'))}`
    case 'loki':
      return `level=info ts=${ts} caller=flush.go:${pick(['308', '312', '461'], r('c'))} component=ingester msg="flushing stream" user=fake fp=${(id * 2654435761 >>> 0).toString(16)} immediate=false num_chunks=1 labels="{namespace=\\"${pick(['commerce', 'payments', 'edge', 'batch'], r('ns'))}\\"}"`
    case 'tempo':
      return `level=info ts=${ts} caller=flush.go:${pick(['244', '301'], r('c'))} msg="${pick(['flushed block', 'completing block', 'head block cut'], r('m'))}" tenant=single-tenant block=${(id * 40503).toString(16)}-${(n * 977).toString(16)} size=${num(r('s'), 200, 9000)}KiB`
    case 'grafana':
      return `logger=context userId=1 orgId=1 uname=admin t=${ts} level=info msg="Request Completed" method=${pick(['GET', 'POST'], r('m'))} path=${pick(['/api/ds/query', '/api/dashboards/uid/k8s-pods', '/api/search'], r('p'))} status=${odd < 0.02 ? 502 : 200} remote_addr=198.51.100.${num(r('c'), 2, 250)} time_ms=${ms} size=${num(r('s'), 300, 90000)}`
    case 'opencost':
      return `${ts} ${odd < 0.05 ? 'WRN' : 'INF'} ${odd < 0.05 ? 'Prometheus query returned no data for node prod-seoul-worker-h' : pick(['ComputeAllocation completed window=24h duration=' + ms + 'ms', 'Cache warmed window=7d', 'Pricing refreshed source=default-on-prem'], r('m'))}`
    case 'agent':
      return `time=${ts} level=INFO source=node_exporter.go:${num(r('l'), 110, 140)} msg="collector succeeded" name=${pick(['cpu', 'meminfo', 'filesystem', 'netdev', 'diskstats', 'loadavg'], r('c'))} duration_seconds=${(ms / 100000).toFixed(6)}`
    case 'coredns': {
      const host = pick(['catalog.commerce.svc.cluster.local.', 'ledger.payments.svc.cluster.local.', 'session-store.commerce.svc.cluster.local.', 'prometheus.observability.svc.cluster.local.', 'pay.northstar.example.'], r('h'))
      const nx = odd < 0.06
      return `[INFO] ${pick(PEERS, r('peer'))}:${num(r('port'), 32000, 61000)} - ${id * 7} "${pick(['A', 'AAAA'], r('t'))} IN ${nx ? 'payment-gateway.commerce.svc.cluster.local.' : host} udp ${num(r('b'), 40, 70)} false 1232" ${nx ? 'NXDOMAIN' : 'NOERROR'} qr,aa,rd ${num(r('s'), 90, 160)} 0.000${num(r('d'), 100, 900)}s`
    }
    case 'argocd':
      return `time="${ts}" level=info msg="Reconciliation completed" application=platform/${pick(['storefront', 'checkout-api', 'catalog', 'payment-api', 'ledger'], r('a'))} dedup_ms=0 diff_ms=${num(r('d'), 2, 40)} fields.level=1 time_ms=${ms}`
    case 'reloader':
      return `level=info ts=${ts} caller=reloader.go:${pick(['389', '412'], r('c'))} msg="${pick(['config file unchanged', 'watching for changes'], r('m'))}" cfg_in=/etc/prometheus/prometheus.yml`
    default:
      return `${ts} INFO  ${src.app} ok`
  }
}

const CRASH = [
  [0, 'INFO  Starting checkout-api 2.4.1 (pid 1)'],
  [600, 'INFO  Loading configuration from environment'],
  [1300, 'INFO  Connected to session-store:6379'],
  [2100, 'INFO  Payment client timeout 3000ms (default)'],
  [2900, 'ERROR PAYMENT_GATEWAY_URL is not set'],
  [3400, 'ERROR Startup failed: required configuration missing, exiting with code 1'],
] as const
const JOB = ['INFO  Export started window=30m', 'INFO  Read 1284 orders from ledger', 'INFO  Wrote 1284 rows to warehouse table orders_halfhourly', 'INFO  Export finished in 41.2s']
const JOB_FAIL = ['INFO  Schedule sync started', 'ERROR Could not acquire lock "schedule-sync": context deadline exceeded', 'ERROR Sync failed, exiting with code 1']

interface Feed { lines: LogLine[]; n: number; next: number }
const feeds = new Map<string, Feed>()
const keep = (f: Feed) => { if (f.lines.length > KEEP) f.lines.splice(0, f.lines.length - KEEP) }
const gap = (key: string, n: number) => 500 + Math.floor(rnd(key, n, 'gap') * 1500)

// The container's lines up to `now`, oldest first (at most 1 000).
export function logLines(src: LogSource, now = Date.now()): LogLine[] {
  if (src.style === 'crash') {
    const out: LogLine[] = []
    // from four runs before the page opened
    for (let run = Math.max(1, crashRuns(src.at, boot) - 4); run <= crashRuns(src.at, now); run++) {
      for (const [after, text] of CRASH) {
        const t = crashRunAt(src.at, run) + after
        if (t <= now) out.push({ t, text: iso(t) + ' ' + text })
      }
    }
    return out.slice(-KEEP)
  }
  if (src.style === 'job' || src.style === 'jobfail') {
    const texts = src.style === 'job' ? JOB : [...JOB_FAIL, ...JOB_FAIL, ...JOB_FAIL]
    return texts.map((text, i) => ({ t: src.at + i * 9000, text: iso(src.at + i * 9000) + ' ' + text })).filter((l) => l.t <= now)
  }
  let f = feeds.get(src.key)
  if (!f) {
    // the backlog: lines before the page opened, as far back as the container has run
    const lines: LogLine[] = []
    let t = Math.min(boot, now)
    for (let n = -1; n >= -BACKLOG && t > src.at; n--) {
      lines.unshift({ t, text: line(src, n, t) })
      t -= gap(src.key, n)
    }
    f = { lines, n: 0, next: Math.max(boot, src.at) + gap(src.key, 0) }
    feeds.set(src.key, f)
  }
  if (src.live) {
    while (f.next <= now) {
      f.lines.push({ t: f.next, text: line(src, f.n, f.next) })
      f.n++
      f.next += gap(src.key, f.n)
      keep(f)
    }
  }
  return f.lines
}

// The last `tail` lines as kubectl logs prints them.
export function logText(src: LogSource, tail: number, now = Date.now()): string {
  const lines = logLines(src, now)
  return lines.length ? lines.slice(-Math.max(1, tail)).map((l) => l.text).join('\n') + '\n' : ''
}
