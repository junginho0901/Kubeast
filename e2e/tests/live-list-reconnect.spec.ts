import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { test, expect, type Page, type Request, type WebSocketRoute } from '@playwright/test'

// A live list that missed changes while it was not following reads itself again once it follows again, so it ends
// equal to the cluster within the RESYNC spread and never shows an empty frame on the way. On cluster `self`, each case
// in a namespace of its own: a Cluster View node box scrolled away while its pods change and back within its 10 s
// staleTime; the Helm releases stream the browser opens again by itself after a release was uninstalled (Last-Event-ID,
// then a read past the server's 30 s list cache); and frames that come while a list is read again, applied onto an
// answer made before them. A list whose socket came back is `reads-on-change.spec.ts`'s. It skips without the kind
// cluster `kubeast`; the namespaces are removed after.
//
// The Pods screen reads its page from the server every few seconds and follows no watch, so the frames case runs on
// ConfigMaps, a list `useKubeWatchList` keeps.

const RUN = `e2e-reconnect-${Date.now().toString(36)}`
const CLUSTER = 'self'
// a RESYNC's read comes at a random moment within 5 s (RESYNC_READ_WITHIN_MS in useKubeWatchList.ts), then the read itself
const RESYNC_SPREAD_MS = 6_000

let kubectlFor: ((args: string, input?: string) => string) | null = null
let missing = ''
try {
  const kubeconfig = execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-reconnect-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  kubectlFor = (args, input) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
} catch (err) {
  missing = `the kind cluster kubeast is not reachable (kind get kubeconfig --name kubeast): ${String((err as Error).message).split('\n')[0]}`
}
const kubectl = (args: string, input?: string) => {
  if (!kubectlFor) throw new Error(missing)
  return kubectlFor(args, input)
}
const dropNamespace = (ns: string) => {
  try {
    kubectl(`delete namespace ${ns} --ignore-not-found --wait=false`)
  } catch {
    // the cluster went away meanwhile: nothing to remove
  }
}

type Msg = {
  type: string
  clusterId?: string
  path?: string
  query?: string
  resync?: boolean
  data?: { type?: string; object?: { name?: string; metadata?: { name?: string } } }
}
type Seen = { at: number; msg: Msg }

// The page's live-list socket, through the spec: the frames both ways are relayed and kept, and tell() sends the page a
// frame as if the server had.
async function routeSocket(page: Page) {
  const sent: Seen[] = []
  const got: Seen[] = []
  let current: WebSocketRoute | undefined
  await page.routeWebSocket(/wsMultiplexer/, (ws) => {
    const server = ws.connectToServer()
    current = ws
    ws.onMessage((message) => {
      sent.push({ at: Date.now(), msg: JSON.parse(String(message)) })
      server.send(message)
    })
    server.onMessage((message) => {
      got.push({ at: Date.now(), msg: JSON.parse(String(message)) })
      ws.send(message)
    })
  })
  return {
    sent,
    got,
    tell(msg: Msg) {
      current?.send(JSON.stringify(msg))
    },
  }
}

// What a list shows, read the same way by the spec and by the frame sampler: a table's rows as "name|next cell" (Data for
// ConfigMaps, Revision for Helm releases), or a Cluster View box's pod names (null while the box is not drawn).
type Probe = {
  read: (box: string | null) => string[] | null
  frames: (string[] | null)[]
  sampling: boolean
  sample: (box: string | null) => void
  stop: () => (string[] | null)[]
}
type ProbeWindow = { __e2eProbe: Probe }

async function probe(page: Page) {
  await page.addInitScript(() => {
    const read = (box: string | null): string[] | null => {
      if (box !== null) {
        const el = document.querySelector(`[data-testid="cluster-view-node"][data-node="${box}"]`)
        if (!el) return null
        return Array.from(el.querySelectorAll('button div.font-medium[title]')).map((d) => d.getAttribute('title') ?? '').sort()
      }
      return Array.from(document.querySelectorAll('main tbody tr td.font-medium'))
        .map((td) => `${(td as HTMLElement).innerText.trim()}|${((td.nextElementSibling as HTMLElement | null)?.innerText ?? '').trim()}`)
        .sort()
    }
    const p: Probe = {
      read,
      frames: [],
      sampling: false,
      sample(box) {
        p.frames = []
        p.sampling = true
        const tick = () => {
          if (!p.sampling) return
          p.frames.push(read(box))
          if (p.frames.length < 20_000) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      },
      stop() {
        p.sampling = false
        return p.frames
      },
    }
    ;(window as unknown as ProbeWindow).__e2eProbe = p
  })
}
const shown = (page: Page, box: string | null = null) => page.evaluate((b) => (window as unknown as ProbeWindow).__e2eProbe.read(b), box)
// every animation frame from now on, until stopFrames
const startFrames = (page: Page, box: string | null = null) => page.evaluate((b) => (window as unknown as ProbeWindow).__e2eProbe.sample(b), box)
const stopFrames = async (page: Page) =>
  (await page.evaluate(() => (window as unknown as ProbeWindow).__e2eProbe.stop())).filter((frame): frame is string[] => frame !== null)

// the moments of the GETs the page sends that match
function requestsTo(page: Page, match: (url: URL) => boolean): number[] {
  const at: number[] = []
  page.on('request', (request) => {
    if (request.method() === 'GET' && match(new URL(request.url()))) at.push(Date.now())
  })
  return at
}

// the namespace's ConfigMaps as the list's rows read them: name and the number of data keys
const configMapRows = (ns: string) =>
  (JSON.parse(kubectl(`-n ${ns} get configmaps -o json`)).items as { metadata: { name: string }; data?: Record<string, string> }[])
    .map((cm) => `${cm.metadata.name}|${Object.keys(cm.data ?? {}).length}`)
    .sort()

// pause pods bound to the node by name, so no scheduler is waited for
const pinnedPods = (ns: string, node: string, names: string[]) => JSON.stringify({
  apiVersion: 'v1',
  kind: 'List',
  items: names.map((name) => ({
    apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: ns },
    spec: {
      nodeName: node, terminationGracePeriodSeconds: 0, tolerations: [{ operator: 'Exists' }],
      containers: [{ name: 'pause', image: 'registry.k8s.io/pause:3.10', imagePullPolicy: 'IfNotPresent' }],
    },
  })),
})
// the six pods a stood-in node box shows
const fakePods = (node: string, ns: string) => Array.from({ length: 6 }, (_, i) => ({
  name: `${node}-p${i}`, namespace: ns, node_name: node, phase: 'Running', status: 'Running', ready: '1/1', restart_count: 0,
  containers: [{ name: 'c', ready: true, state: { running: {} } }], init_containers: [], created_at: new Date().toISOString(),
}))

// Helm keeps a release's revision in a Secret (type helm.sh/release.v1, labels name, owner=helm, status, version), the
// payload base64 of gzipped JSON — written by hand, as number-check-lists writes them
const helmSecret = (ns: string, name: string) => {
  const at = new Date().toISOString()
  const release = {
    name, namespace: ns, version: 1, config: {}, manifest: '',
    info: { status: 'deployed', first_deployed: at, last_deployed: at, description: 'live list reconnect' },
    chart: { metadata: { apiVersion: 'v2', name: 'reconnect-chart', version: '0.1.0', appVersion: '1.0.0' } },
  }
  const payload = zlib.gzipSync(Buffer.from(JSON.stringify(release))).toString('base64')
  return {
    apiVersion: 'v1', kind: 'Secret', type: 'helm.sh/release.v1',
    metadata: { name: `sh.helm.release.v1.${name}.v1`, namespace: ns, labels: { name, owner: 'helm', status: 'deployed', version: '1' } },
    data: { release: Buffer.from(payload).toString('base64') },
  }
}
// each release of the namespace by its newest revision, as the list's rows read them: name and revision
function releaseRows(ns: string): string[] {
  const newest = new Map<string, number>()
  const lines = kubectl(`-n ${ns} get secrets -l owner=helm -o jsonpath='{range .items[*]}{.metadata.labels.name} {.metadata.labels.version}{"\\n"}{end}'`)
  for (const line of lines.split('\n').filter(Boolean)) {
    const [name, version] = line.split(' ')
    newest.set(name, Math.max(newest.get(name) ?? 0, Number(version)))
  }
  return [...newest].map(([name, revision]) => `${name}|${revision}`).sort()
}

test.describe('live lists that missed changes read themselves again', () => {
  test.beforeEach(() => {
    test.skip(!kubectlFor, missing)
  })

  test('a Cluster View box scrolled away while its pods changed and back within its staleTime reads its pods again, with no empty frame', async ({ page }) => {
    test.setTimeout(120_000)
    const ns = `${RUN}-box`
    const podsPath = `/api/v1/namespaces/${ns}/pods`
    try {
      const node = kubectl('get nodes -o jsonpath={.items[0].metadata.name}')
      kubectl(`create namespace ${ns}`)
      kubectl('apply -f -', pinnedPods(ns, node, ['keep', 'goes']))
      const onNode = () => kubectl(`-n ${ns} get pods --field-selector spec.nodeName=${node} -o jsonpath={.items[*].metadata.name}`).split(' ').filter(Boolean).sort()
      const ofBox = (s: Seen) => s.msg.path === podsPath && decodeURIComponent(s.msg.query ?? '').includes(`spec.nodeName=${node}`)
      const box = page.locator(`[data-testid="cluster-view-node"][data-node="${node}"]`)

      await probe(page)
      const socket = await routeSocket(page)
      // forty stood-in boxes after this node's, so its box can leave the screen: in the map's answer and with six pods each
      const fakes = Array.from({ length: 40 }, (_, i) => `zz-e2e-reconnect-${String(i).padStart(2, '0')}`)
      await page.route('**/api/v1/cluster/pods/nodes?**', async (route) => {
        const response = await route.fetch()
        const body = await response.json()
        if (!body.unchanged) body.nodes = [...body.nodes, ...fakes.map((n) => ({ node: n, total: 6, ok: 6, warn: 0, error: 0 }))]
        await route.fulfill({ response, json: body })
      })
      await page.route('**/api/v1/cluster/pods/on-node?**', (route) => {
        const asked = new URL(route.request().url()).searchParams.get('node') ?? ''
        if (!fakes.includes(asked)) return route.fallback()
        return route.fulfill({ json: fakePods(asked, ns) })
      })
      const boxReads = requestsTo(page, (u) => u.pathname === '/api/v1/cluster/pods/on-node' && u.searchParams.get('node') === node)

      await page.goto(`/cluster-view?cluster=${CLUSTER}&namespace=${ns}`)
      await expect.poll(() => shown(page, node), { timeout: 20_000 }).toEqual(onNode())

      // a change the box takes from its watch, so its 10 s staleTime counts from here
      const labelled = Date.now()
      kubectl(`-n ${ns} label pod keep e2e-reconnect=touched --overwrite`)
      const named = (s: Seen) => s.msg.data?.object?.name ?? s.msg.data?.object?.metadata?.name
      await expect.poll(() => socket.got.some((s) => s.at >= labelled && ofBox(s) && s.msg.data?.type === 'MODIFIED' && named(s) === 'keep'), { timeout: 10_000 }).toBe(true)
      const touched = Date.now()
      // frames are gathered for 100 ms (LIST_GATHER_MS) before the box takes them
      await page.waitForTimeout(300)

      // TanStack Virtual on the window's scroll: at the bottom the box is not drawn, and its watch closes
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      await expect(box, 'the box left the screen').toHaveCount(0, { timeout: 5_000 })
      await expect.poll(() => socket.sent.some((s) => ofBox(s) && s.msg.type === 'CLOSE'), { message: 'the box\'s watch closed', timeout: 5_000 }).toBe(true)

      kubectl(`-n ${ns} delete pod goes --grace-period=0 --force --wait=false`)
      kubectl('apply -f -', pinnedPods(ns, node, ['comes']))
      await expect.poll(onNode, { timeout: 5_000 }).toEqual(['comes', 'keep'])

      const sentBefore = socket.sent.length
      const readsBefore = boxReads.length
      const back = Date.now()
      await startFrames(page, node)
      await page.evaluate(() => window.scrollTo(0, 0))
      await expect(box, 'the box is drawn again').toHaveCount(1, { timeout: 5_000 })
      expect(back - touched, 'back within the box\'s 10 s staleTime, where its query reads nothing by itself').toBeLessThan(10_000)
      await expect.poll(() => socket.sent.slice(sentBefore).find((s) => ofBox(s) && s.msg.type === 'REQUEST')?.msg.resync, {
        message: 'the box shown again asks for a RESYNC',
        timeout: 5_000,
      }).toBe(true)
      await expect.poll(() => socket.got.some((s) => s.at >= back && ofBox(s) && s.msg.type === 'RESYNC'), {
        message: 'the server says RESYNC once the box\'s watch is on',
        timeout: 10_000,
      }).toBe(true)
      await expect.poll(() => shown(page, node), { message: 'the box read again within the RESYNC spread', timeout: RESYNC_SPREAD_MS }).toEqual(onNode())
      expect(boxReads.length - readsBefore, 'one read of the box for the gap').toBe(1)

      const frames = await stopFrames(page)
      expect(frames.length, 'the box was sampled while it came back').toBeGreaterThan(10)
      expect(frames.filter((names) => names.length === 0), 'no frame of the box without pods').toEqual([])
    } finally {
      dropNamespace(ns)
    }
  })

  test('the Helm releases stream the browser opens again after a release was uninstalled reads the list past the server\'s cache, with no empty frame', async ({ page }) => {
    test.setTimeout(120_000)
    const ns = `${RUN}-helm`
    let letGo = () => {}
    try {
      kubectl(`create namespace ${ns}`)
      kubectl('apply -f -', JSON.stringify({ apiVersion: 'v1', kind: 'List', items: [helmSecret(ns, 'keep'), helmSecret(ns, 'goes')] }))
      await probe(page)
      // The page's first stream ends right after the stream's opening line (its id), as a stream the network cut does. The
      // browser opens it again by itself, sending that id as Last-Event-ID, and that request waits here until let go.
      const reopened: Request[] = []
      const released = new Promise<void>((resolve) => {
        letGo = resolve
      })
      let streams = 0
      await page.route(/\/api\/v1\/helm\/releases\/stream\?/, async (route) => {
        const asked = new URL(route.request().url()).searchParams
        if (asked.get('cluster') !== CLUSTER || asked.get('namespace') !== ns) return route.continue()
        streams += 1
        if (streams === 1) {
          return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, body: 'id: helm-releases\nretry: 500\n\n' })
        }
        reopened.push(route.request())
        await released
        return route.continue()
      })
      const forced = requestsTo(page, (u) => u.pathname === '/api/v1/helm/releases' && u.searchParams.get('force_refresh') === 'true')

      await page.goto(`/helm/releases?cluster=${CLUSTER}&namespace=${ns}`)
      await expect.poll(() => shown(page), { timeout: 20_000 }).toEqual(releaseRows(ns))
      await expect.poll(() => reopened.length, { message: 'the browser opened the stream again', timeout: 10_000 }).toBeGreaterThan(0)
      expect(await reopened[0].headerValue('last-event-id'), 'the stream\'s id, sent back').toBe('helm-releases')
      await startFrames(page)

      kubectl(`-n ${ns} delete secret sh.helm.release.v1.goes.v1`)
      expect(releaseRows(ns)).toEqual(['keep|1'])
      // nothing told the page: the list still shows what it had
      expect(await shown(page)).toEqual(['goes|1', 'keep|1'])

      const at = Date.now()
      letGo()
      await expect.poll(() => forced.filter((t) => t >= at).length, {
        message: 'the stream said resync once its watch was on, and the list was read with force_refresh',
        timeout: RESYNC_SPREAD_MS + 2_000,
      }).toBe(1)
      await expect.poll(() => shown(page), { message: 'the list read again within the RESYNC spread', timeout: RESYNC_SPREAD_MS }).toEqual(releaseRows(ns))
      expect(streams, 'one stream reopened, no more').toBe(2)

      const frames = await stopFrames(page)
      expect(frames.length, 'the list was sampled while the stream was away and back').toBeGreaterThan(10)
      expect(frames.filter((rows) => rows.length === 0), 'no frame of the list without rows').toEqual([])
    } finally {
      letGo()
      dropNamespace(ns)
    }
  })

  test('frames that come while a list is read again stay on screen once the answer, made before them, lands', async ({ page }) => {
    test.setTimeout(120_000)
    const ns = `${RUN}-frames`
    const listPath = `/api/v1/namespaces/${ns}/configmaps`
    let letGo = () => {}
    try {
      kubectl(`create namespace ${ns}`)
      for (const name of ['stays', 'goes', 'changes']) kubectl(`-n ${ns} create configmap ${name} --from-literal=a=1`)
      await probe(page)
      const socket = await routeSocket(page)
      // The next read of the list once armed: its answer is made at once, before the changes below, and handed to the page
      // only when let go.
      let armed = false
      let made: string | undefined
      let handed = false
      const released = new Promise<void>((resolve) => {
        letGo = resolve
      })
      await page.route(new RegExp(`/api/v1/cluster/namespaces/${ns}/configmaps(\\?|$)`), async (route) => {
        if (!armed || route.request().method() !== 'GET') return route.fallback()
        armed = false
        const response = await route.fetch()
        made = await response.text()
        await released
        await route.fulfill({ response })
        handed = true
      })

      await page.goto(`/configuration/configmaps?cluster=${CLUSTER}&namespace=${ns}`)
      await expect.poll(() => shown(page), { timeout: 20_000 }).toEqual(configMapRows(ns))
      await expect.poll(() => socket.sent.some((s) => s.msg.type === 'REQUEST' && s.msg.path === listPath), { timeout: 10_000 }).toBe(true)
      const asked = socket.sent.find((s) => s.msg.type === 'REQUEST' && s.msg.path === listPath)!.msg

      // a RESYNC, as the server sends one when the watch's version expired: the list reads itself again within 5 s, while
      // its watch goes on
      armed = true
      socket.tell({ type: 'RESYNC', clusterId: asked.clusterId, path: listPath, query: asked.query })
      await expect.poll(() => made !== undefined, { message: 'the RESYNC read went out', timeout: RESYNC_SPREAD_MS + 2_000 }).toBe(true)

      kubectl(`-n ${ns} delete configmap goes`)
      kubectl(`-n ${ns} create configmap comes --from-literal=a=1`)
      kubectl(`-n ${ns} patch configmap changes --type=merge -p '{"data":{"b":"2"}}'`)
      const want = configMapRows(ns)
      expect(want).toEqual(['changes|2', 'comes|1', 'kube-root-ca.crt|1', 'stays|1'])
      // the watch's frames of the three changes reach the list while its read is on its way
      await expect.poll(() => shown(page), { message: 'the frames while the read is on its way', timeout: 10_000 }).toEqual(want)
      // the answer held back was made before them
      const answer = (JSON.parse(made!) as { name: string; data_count: number }[]).map((cm) => `${cm.name}|${cm.data_count}`).sort()
      expect(answer, 'the answer made before the changes').toEqual(['changes|1', 'goes|1', 'kube-root-ca.crt|1', 'stays|1'])

      await startFrames(page)
      letGo()
      await expect.poll(() => handed, { message: 'the answer was handed to the page', timeout: 5_000 }).toBe(true)
      // the answer goes through the API client and the query cache, then a drawing: a second is past all of it
      await page.waitForTimeout(1_000)
      expect(await shown(page), 'the changes stay once the answer lands').toEqual(configMapRows(ns))

      const frames = await stopFrames(page)
      expect(frames.length, 'the list was sampled while the answer landed').toBeGreaterThan(10)
      expect(frames.filter((rows) => JSON.stringify(rows) !== JSON.stringify(want)), 'no frame drew the answer without the changes').toEqual([])
    } finally {
      letGo()
      dropNamespace(ns)
    }
  })
})
