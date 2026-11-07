import { execSync } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// The DRA screens' numbers are the cluster's, on test2 with the DRA example driver (scripts/kind-gpu.sh up — eight
// mock GPUs of gpu.example.com on the node): the four lists' rows, columns and cards against the API server's Table
// (what kubectl get prints: a claim's STATE, a slice's NODE, DRIVER and POOL) and the objects, from the list API and
// live; each list updated live as objects come, change and go (a claim allocated to a pod, then released); the four
// drawers' rows, tables and "(n)" counts worked out from the objects; a grant limited to namespaces reads "-" on the
// cards of the cluster-scoped kinds it may not list; a cluster that does not serve resource.k8s.io says "not
// installed". The fixture lives in namespace e2e-dra-num and two cluster-scoped objects, made here and removed after.

const CLUSTER = 'test2'
const NS = 'e2e-dra-num'
const DRIVER = 'gpu.example.com'
const CLASS = 'e2e-dra-num.example.com'
const LIVE_CLASS = 'e2e-dra-num-live.example.com'
const ALL_SLICE = 'e2e-dra-num-all'
const LIVE_SLICE = 'e2e-dra-num-live'
const READ_GROUP = 'kubeast:role:read'
const R = '/apis/resource.k8s.io/v1'
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any
type Table = { columnDefinitions: { name: string }[]; rows: { cells: unknown[]; object: Obj }[] }

// test2's kubectl, and the API server's Table — what `kubectl get` prints — through the kubeconfig's client certificate
const kc = execSync(`kind get kubeconfig --name ${CLUSTER}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-number-dra-')), 'kubeconfig')
fs.writeFileSync(kcPath, kc, { mode: 0o600 })
const kubectl = (args: string, input?: string) =>
  execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim()
const pick = (k: string) => (kc.match(new RegExp(`${k}: (\\S+)`)) ?? [])[1] ?? ''
const server = new URL(pick('server'))
function apiTable(apiPath: string): Promise<Table> {
  return new Promise((resolve, reject) => {
    https.request({
      host: server.hostname, port: server.port, path: apiPath, method: 'GET',
      ca: Buffer.from(pick('certificate-authority-data'), 'base64'),
      cert: Buffer.from(pick('client-certificate-data'), 'base64'),
      key: Buffer.from(pick('client-key-data'), 'base64'),
      headers: { Accept: 'application/json;as=Table;g=meta.k8s.io;v=v1' },
    }, (r) => {
      let s = ''
      r.on('data', (c) => (s += c))
      r.on('end', () => (r.statusCode === 200 ? resolve(JSON.parse(s)) : reject(new Error(`${apiPath}: ${r.statusCode} ${s.slice(0, 200)}`))))
    }).on('error', reject).end()
  })
}
// a Table's cell by column name, for the object named key (namespace/name for a namespaced kind)
const keyOf = (m: { name: string; namespace?: string }) => (m.namespace ? `${m.namespace}/${m.name}` : m.name)
const cellsByKey = (t: Table) => Object.fromEntries(t.rows.map((r) => [keyOf(r.object.metadata),
  Object.fromEntries(t.columnDefinitions.map((c, i) => [c.name, String(r.cells[i] ?? '')]))]))
const objects = (plural: string): Obj[] => JSON.parse(kubectl(`get ${plural} -A -o json`)).items

const box = { name: 'app', image: 'busybox:1.37', imagePullPolicy: 'IfNotPresent', command: ['sleep', '3600'], resources: { claims: [{ name: 'gpu' }] } }
const pod = (name: string, claim: Record<string, string>) => ({
  apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: NS },
  spec: { terminationGracePeriodSeconds: 0, resourceClaims: [{ name: 'gpu', ...claim }], containers: [box] },
})
const claimSpec = (requests: Obj[]) => ({ devices: { requests } })
const dra = (kind: string, name: string, spec: Obj, namespaced = true) => ({
  apiVersion: 'resource.k8s.io/v1', kind, metadata: { name, ...(namespaced ? { namespace: NS } : {}) }, spec,
})
const list = (items: Obj[]) => JSON.stringify({ apiVersion: 'v1', kind: 'List', items })

// A class of its own with two selectors, config and an extended resource name (used by a claim no pod runs, so its
// config is never handed to the driver); templates of one request and of two (exactly with a selector and count, and a
// firstAvailable of two subrequests); a claim a pod holds, one nobody holds (All devices), one of the own class; a pod
// of the one-request template; a slice of all nodes of a driver nothing runs.
const FIXTURE = list([
  { apiVersion: 'v1', kind: 'Namespace', metadata: { name: NS } },
  dra('DeviceClass', CLASS, {
    selectors: [{ cel: { expression: `device.driver == '${DRIVER}'` } }, { cel: { expression: `device.attributes['${DRIVER}'].index < 4` } }],
    config: [{ opaque: { driver: DRIVER, parameters: { apiVersion: 'gpu.resource.example.com/v1alpha1', kind: 'GpuConfig', sharing: { strategy: 'TimeSlicing' } } } }],
    extendedResourceName: `${CLASS}/gpu`,
  }, false),
  dra('ResourceSlice', ALL_SLICE, {
    driver: CLASS, allNodes: true, pool: { name: 'num-pool', generation: 1, resourceSliceCount: 1 },
    devices: [{ name: 'd0', attributes: { index: { int: 0 } }, capacity: { memory: { value: '1Gi' } } }, { name: 'd1' }],
  }, false),
  dra('ResourceClaimTemplate', 'num-one', { spec: claimSpec([{ name: 'gpu', exactly: { deviceClassName: DRIVER } }]) }),
  dra('ResourceClaimTemplate', 'num-two', { spec: claimSpec([
    { name: 'pair', exactly: { deviceClassName: DRIVER, count: 2, selectors: [{ cel: { expression: `device.attributes['${DRIVER}'].index >= 0` } }] } },
    { name: 'pick', firstAvailable: [{ name: 'big', deviceClassName: CLASS }, { name: 'small', deviceClassName: DRIVER, count: 1 }] },
  ]) }),
  dra('ResourceClaim', 'num-held', claimSpec([{ name: 'gpu', exactly: { deviceClassName: DRIVER } }])),
  dra('ResourceClaim', 'num-free', claimSpec([{ name: 'gpu', exactly: { deviceClassName: DRIVER, allocationMode: 'All' } }])),
  dra('ResourceClaim', 'num-class', claimSpec([
    { name: 'one', exactly: { deviceClassName: CLASS } },
    { name: 'two', firstAvailable: [{ name: 'a', deviceClassName: CLASS }] },
  ])),
  pod('num-pod-held', { resourceClaimName: 'num-held' }),
  pod('num-pod-tmpl', { resourceClaimTemplateName: 'num-one' }),
])

function cleanUp() {
  kubectl(`delete namespace ${NS} --wait=true --timeout=180s --ignore-not-found`)
  kubectl(`delete deviceclass ${CLASS} ${LIVE_CLASS} --ignore-not-found --wait=true`)
  kubectl(`delete resourceslice ${ALL_SLICE} ${LIVE_SLICE} --ignore-not-found --wait=true`)
}

// the claim made for num-pod-tmpl from num-one (its name the controller picks)
const madeClaim = () => {
  const p = JSON.parse(kubectl(`get pod num-pod-tmpl -n ${NS} -o json`))
  return (p.status?.resourceClaimStatuses ?? []).find((s: Obj) => s.name === 'gpu')?.resourceClaimName as string | undefined
}

const registeredOn = async (page: Page, id: string) => {
  const body = await (await page.request.get('/api/v1/clusters')).json()
  return (Array.isArray(body) ? body : body.items ?? []).some((c: Obj) => c.id === id)
}

// ── list screens ─────────────────────────────────────────────────────────────────────────────────────────────────────

type Screen = {
  path: string
  plural: string
  // columns kubectl does not print: what the object says
  extra: Partial<Record<string, (o: Obj) => string>>
  // summary card label → the count that label means, over kubectl's rows (column → cell) and the objects
  cards: (rows: Record<string, string>[], objs: Obj[]) => Record<string, string>
}
const AGE = 'dates-pages.spec.ts compares ages with kubectl; the format is formatAge everywhere'
const len = (v: unknown) => String(Array.isArray(v) ? v.length : 0)
const words = (state: string) => state.split(',').filter(Boolean)
const SCREENS: Screen[] = [
  {
    path: '/gpu/deviceclasses', plural: 'deviceclasses',
    extra: { Selectors: (o) => len(o.spec?.selectors) },
    cards: (rows) => ({ Total: String(rows.length) }),
  },
  {
    path: '/gpu/resourceclaims', plural: 'resourceclaims',
    extra: { Requests: (o) => len(o.spec?.devices?.requests) },
    // a card counts the claims whose kubectl STATE has its word
    cards: (rows) => ({
      Total: String(rows.length),
      Allocated: String(rows.filter((r) => words(r.State).includes('allocated')).length),
      Reserved: String(rows.filter((r) => words(r.State).includes('reserved')).length),
      Pending: String(rows.filter((r) => words(r.State).includes('pending')).length),
    }),
  },
  {
    path: '/gpu/resourceclaimtemplates', plural: 'resourceclaimtemplates',
    extra: { Requests: (o) => len(o.spec?.spec?.devices?.requests) },
    cards: (rows) => ({ Total: String(rows.length) }),
  },
  {
    path: '/gpu/resourceslices', plural: 'resourceslices',
    extra: { Devices: (o) => len(o.spec?.devices) },
    cards: (rows, objs) => ({ Total: String(rows.length), 'Total Devices': String(objs.reduce((n, o) => n + Number(len(o.spec?.devices)), 0)) }),
  },
]
const screen = (p: string) => SCREENS.find((s) => s.path === p)!

type ScreenRead = { heads: string[]; rows: string[][]; cards: Record<string, string> }
async function readScreen(page: Page): Promise<ScreenRead> {
  return page.evaluate(() => {
    const heads = [...document.querySelectorAll('main thead th')].map((th) => (th as HTMLElement).innerText.trim())
    const rows = [...document.querySelectorAll('main tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => (td as HTMLElement).innerText.trim()))
    const cards: Record<string, string> = {}
    // a summary card: a bordered box of two lines, the label and a number ("-" for a list the cluster refused)
    for (const b of document.querySelectorAll('main div.rounded-lg.border')) {
      const lines = [...b.children] as HTMLElement[]
      if (lines.length === 2 && /^(\d+|-)$/.test(lines[1].innerText.trim())) cards[lines[0].innerText.trim()] = lines[1].innerText.trim()
    }
    return { heads, rows, cards }
  })
}

const EMPTY = new Set(['', '-', '<none>'])
const same = (a: string, b: string) => (EMPTY.has(a.trim()) && EMPTY.has(b.trim())) || a.trim() === b.trim()
const norm = (h: string) => h.toLowerCase().replace(/[\s_()-]/g, '')

// what differs between the screen and the cluster now: the rows (namespace/name), every column kubectl prints, the
// columns only Kubeast prints from the objects, and the cards — [] when the screen shows what the cluster has
async function screenDiff(page: Page, s: Screen): Promise<string[]> {
  const table = await apiTable(`${R}/${s.plural}`)
  const byKey = cellsByKey(table)
  const objs = Object.fromEntries(objects(s.plural).map((o) => [keyOf(o.metadata), o]))
  const { heads, rows, cards } = await readScreen(page)
  const nameAt = heads.findIndex((h) => /^name$/i.test(h))
  const nsAt = heads.findIndex((h) => /^namespace$/i.test(h))
  const shown = rows.filter((r) => r[nameAt] && r.length === heads.length).map((r) => [nsAt >= 0 ? `${r[nsAt]}/${r[nameAt]}` : r[nameAt], r] as const)
  const diffs: string[] = []
  const want = Object.keys(byKey).sort()
  const got = shown.map(([k]) => k).sort()
  if (JSON.stringify(got) !== JSON.stringify(want)) diffs.push(`rows: screen ${JSON.stringify(got)}, kubectl ${JSON.stringify(want)}`)
  const cols = table.columnDefinitions.map((c) => c.name)
  for (const [key, r] of shown) {
    if (!byKey[key]) continue
    heads.forEach((h, i) => {
      if (i === nameAt || i === nsAt || h === 'Age') return
      const extra = s.extra[h]
      const col = cols.find((c) => norm(c) === norm(h))
      const value = extra ? extra(objs[key]) : col ? byKey[key][col] : undefined
      if (value === undefined) diffs.push(`${h}: no column of kubectl's and nothing to compare`)
      else if (!same(r[i], value)) diffs.push(`${key} · ${h}: screen "${r[i]}", ${extra ? 'object' : 'kubectl'} "${value}"`)
    })
  }
  // every card on the screen is one the cluster's numbers give, and no card is missing
  const wantCards = s.cards(Object.values(byKey), Object.values(objs))
  const sorted = (c: Record<string, string>) => JSON.stringify(Object.entries(c).sort())
  if (sorted(cards) !== sorted(wantCards)) diffs.push(`cards: screen ${JSON.stringify(cards)}, cluster ${JSON.stringify(wantCards)}`)
  return [...new Set(diffs)]
}

const url = (p: string, extra = '') => `${p}?cluster=${CLUSTER}${extra}`

// ── drawers ──────────────────────────────────────────────────────────────────────────────────────────────────────────

// A drawer by section: its title without the count, the count in the title, its label/value rows, its tag chips and
// its tables (a cell of chips as "key=value" sorted).
type Section = { count?: string; rows: [string, string][]; chips: Record<string, string>; tables: { head: string[]; rows: string[][] }[] }
async function readDrawer(page: Page): Promise<Record<string, Section>> {
  return page.locator(DRAWER).last().evaluate((root) => {
    const chipsOf = (el: Element) => [...el.querySelectorAll('span.rounded-full')].map((c) => {
      const parts = [...c.children] as HTMLElement[]
      return [parts[0]?.textContent?.trim() ?? '', parts[2]?.textContent?.trim() ?? ''] as [string, string]
    })
    const out: Record<string, Section> = {}
    for (const p of root.querySelectorAll('div.rounded-lg.border > div.flex > p.text-xs')) {
      const sec = p.parentElement!.parentElement!
      const m = /^(.*?)(?: \((\d+|-)\))?$/.exec((p as HTMLElement).innerText.trim())!
      const rows: [string, string][] = []
      for (const g of sec.querySelectorAll('div.grid')) {
        const spans = [...g.children].filter((c) => c.tagName === 'SPAN') as HTMLElement[]
        if (spans.length === 2 && spans[0].className.includes('text-slate-400')) rows.push([spans[0].innerText.trim(), spans[1].innerText.trim()])
      }
      const tables = [...sec.querySelectorAll('table')].map((tb) => ({
        head: [...tb.querySelectorAll('thead th')].map((th) => (th as HTMLElement).innerText.trim()),
        rows: [...tb.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => {
          const chips = chipsOf(td)
          return chips.length ? chips.map(([k, v]) => `${k}=${v}`).sort().join(', ') : (td as HTMLElement).innerText.trim()
        })),
      }))
      const chips = Object.fromEntries(sec.querySelector('table') ? [] : chipsOf(sec))
      out[m[1]] = { count: m[2], rows, chips, tables }
    }
    return out
  })
}

// what a drawer must show, per section title: the count, rows (each must be there), chips, one table (rows in any order)
type WantSection = { count?: string; rows?: [string, string][]; chips?: Record<string, string>; table?: { head: string[]; rows: string[][] } }
function drawerDiff(got: Record<string, Section>, want: Record<string, WantSection>): string[] {
  const diffs: string[] = []
  for (const [title, w] of Object.entries(want)) {
    const g = got[title]
    if (!g) {
      diffs.push(`${title}: no such section (sections: ${Object.keys(got).join(', ')})`)
      continue
    }
    if (w.count !== undefined && g.count !== w.count) diffs.push(`${title}: count ${g.count}, want ${w.count}`)
    for (const [label, value] of w.rows ?? []) {
      if (!g.rows.some(([l, v]) => l === label && same(v, value))) diffs.push(`${title} · ${label}: drawer ${JSON.stringify(g.rows.filter(([l]) => l === label).map(([, v]) => v))}, want "${value}"`)
    }
    if (w.chips && JSON.stringify(Object.entries(g.chips).sort()) !== JSON.stringify(Object.entries(w.chips).sort())) {
      diffs.push(`${title} chips: drawer ${JSON.stringify(g.chips)}, want ${JSON.stringify(w.chips)}`)
    }
    if (w.table) {
      const t = g.tables.find((x) => JSON.stringify(x.head) === JSON.stringify(w.table!.head))
      const sort = (rows: string[][]) => rows.map((r) => r.map((c) => (EMPTY.has(c) ? '-' : c))).map((r) => JSON.stringify(r)).sort()
      if (!t) diffs.push(`${title}: no table ${JSON.stringify(w.table.head)} (tables: ${JSON.stringify(g.tables.map((x) => x.head))})`)
      else if (JSON.stringify(sort(t.rows)) !== JSON.stringify(sort(w.table.rows))) diffs.push(`${title} table: drawer ${JSON.stringify(sort(t.rows))}, want ${JSON.stringify(sort(w.table.rows))}`)
    }
  }
  return diffs
}

// the cluster as the drawers read it
type Snap = { claims: Obj[]; claimState: Record<string, string>; pods: Obj[]; podStatus: Record<string, string>; classes: Obj[]; slices: Obj[]; templates: Obj[] }
async function snapshot(): Promise<Snap> {
  const claimTable = cellsByKey(await apiTable(`${R}/resourceclaims`))
  const podTable = cellsByKey(await apiTable(`/api/v1/namespaces/${NS}/pods`))
  return {
    claims: objects('resourceclaims'),
    claimState: Object.fromEntries(Object.entries(claimTable).map(([k, c]) => [k, c.State])),
    pods: JSON.parse(kubectl(`get pods -n ${NS} -o json`)).items,
    podStatus: Object.fromEntries(Object.entries(podTable).map(([k, c]) => [k, c.Status])),
    classes: objects('deviceclasses'),
    slices: objects('resourceslices'),
    templates: objects('resourceclaimtemplates'),
  }
}
const str = (v: unknown) => (v === undefined || v === null || v === '' ? '-' : String(v))
const typed = (m: Obj) => Object.entries(m ?? {}).map(([k, v]) => {
  const keys = v && typeof v === 'object' ? Object.keys(v as Obj) : []
  return `${k}=${keys.length === 1 ? String((v as Obj)[keys[0]]) : JSON.stringify(v)}`
}).sort().join(', ')
// a claim spec's request table: exactly (or a v1beta1 request itself), or one row per firstAvailable subrequest
const requestRows = (requests: Obj[] = []) => requests.flatMap((r) => {
  const row = (name: string, x: Obj) => [name, str(x.deviceClassName), (x.selectors ?? []).map((s: Obj) => s.cel?.expression).join('; ') || '-', str(x.count), str(x.allocationMode)]
  return r.firstAvailable?.length ? r.firstAvailable.map((s: Obj) => row(`${r.name}/${s.name}`, s)) : [row(r.name, r.exactly ?? r)]
})
const REQUESTS = ['Name', 'Device Class', 'Selectors', 'Count', 'Allocation Mode']
const usesClass = (c: Obj, cls: string) => (c.spec?.devices?.requests ?? [])
  .filter((r: Obj) => r.exactly?.deviceClassName === cls || r.deviceClassName === cls || (r.firstAvailable ?? []).some((s: Obj) => s.deviceClassName === cls))
  .map((r: Obj) => r.name)

const classWant = (s: Snap, name: string): Record<string, WantSection> => {
  const o = s.classes.find((c) => c.metadata.name === name)
  const users = s.claims.filter((c) => usesClass(c, name).length > 0)
  const config = (o.spec?.config ?? []).map((c: Obj) => c.opaque).filter(Boolean)
  return {
    'DeviceClass Info': { rows: [['Name', name], ['Extended Resource Name', str(o.spec?.extendedResourceName)]] },
    ...(o.spec?.selectors?.length ? { Selectors: { table: { head: ['Expression'], rows: o.spec.selectors.map((x: Obj) => [x.cel.expression]) } } } : {}),
    ...(config.length ? { Config: {
      rows: config.map((c: Obj) => ['Driver', c.driver] as [string, string]),
      chips: Object.fromEntries(config.flatMap((c: Obj) => Object.entries(c.parameters ?? {}).map(([k, v]) => [k, v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v)]))),
    } } : {}),
    'Used By ResourceClaims': {
      count: String(users.length),
      ...(users.length ? { table: { head: ['Namespace', 'ResourceClaim', 'Requests', 'State'], rows: users.map((c) => [c.metadata.namespace, c.metadata.name, usesClass(c, name).join(', '), s.claimState[keyOf(c.metadata)]]) } } : {}),
    },
  }
}

const sliceWant = (s: Snap, name: string): Record<string, WantSection> => {
  const o = s.slices.find((x) => x.metadata.name === name)
  const devices: Obj[] = o.spec.devices ?? []
  const names = new Set(devices.map((d) => d.name))
  const held = s.claims.flatMap((c) => (c.status?.allocation?.devices?.results ?? [])
    .filter((r: Obj) => r.driver === o.spec.driver && r.pool === o.spec.pool.name && names.has(r.device))
    .map((r: Obj) => [`${c.metadata.namespace}/${c.metadata.name}`, r.device, r.driver, r.request]))
  return {
    'Slice Info': { rows: [['Name', name], ['Node Name', str(o.spec.nodeName)], ['All Nodes', o.spec.allNodes ? 'Yes' : 'No'], ['Driver Name', o.spec.driver]] },
    Pool: { rows: [['Name', o.spec.pool.name], ['Generation', String(o.spec.pool.generation)], ['Slice Count', String(o.spec.pool.resourceSliceCount)]] },
    ...(devices.length ? { Devices: { table: { head: ['Name', 'Attributes', 'Capacity'], rows: devices.map((d) => [d.name, typed(d.attributes) || '-', typed(d.capacity) || '-']) } } } : {}),
    'Device Allocations': { count: String(held.length), ...(held.length ? { table: { head: ['ResourceClaim', 'Device', 'Driver', 'Request'], rows: held } } : {}) },
  }
}

const claimWant = (s: Snap, name: string): Record<string, WantSection> => {
  const o = s.claims.find((c) => c.metadata.namespace === NS && c.metadata.name === name)
  // the namespace's pods that name the claim, or whose status names it as the claim made for them
  const using = s.pods.filter((p) => (p.spec.resourceClaims ?? []).some((c: Obj) => c.resourceClaimName === name) ||
    (p.status?.resourceClaimStatuses ?? []).some((c: Obj) => c.resourceClaimName === name))
  const results: Obj[] = o.status?.allocation?.devices?.results ?? []
  const reserved: Obj[] = o.status?.reservedFor ?? []
  return {
    'Claim Info': { rows: [['Name', name], ['Namespace', NS], ['State', s.claimState[`${NS}/${name}`]]] },
    Devices: { table: { head: REQUESTS, rows: requestRows(o.spec.devices?.requests) } },
    ...(results.length ? { Allocation: { table: { head: ['Request', 'Driver', 'Pool', 'Device'], rows: results.map((r) => [r.request, r.driver, r.pool, r.device]) } } } : {}),
    ...(reserved.length ? { 'Reserved For': { table: { head: ['Name', 'Resource', 'API Group'], rows: reserved.map((r) => [r.name, r.resource, str(r.apiGroup)]) } } } : {}),
    'Using Pods': {
      count: String(using.length),
      ...(using.length ? { table: { head: ['Pod', 'Status', 'Node'], rows: using.map((p) => [p.metadata.name, s.podStatus[`${NS}/${p.metadata.name}`], str(p.spec.nodeName)]) } } : {}),
    },
  }
}

const templateWant = (s: Snap, name: string): Record<string, WantSection> => {
  const o = s.templates.find((t) => t.metadata.namespace === NS && t.metadata.name === name)
  // the claims made from it: what its pods' status.resourceClaimStatuses name for the entries naming the template
  const made = s.pods.flatMap((p) => (p.spec.resourceClaims ?? []).filter((c: Obj) => c.resourceClaimTemplateName === name)
    .flatMap((c: Obj) => (p.status?.resourceClaimStatuses ?? []).filter((x: Obj) => x.name === c.name && x.resourceClaimName).map((x: Obj) => [x.resourceClaimName, p.metadata.name])))
  return {
    'Template Info': { rows: [['Name', name], ['Namespace', NS]] },
    'Related ResourceClaims': { count: String(made.length), ...(made.length ? { table: { head: ['ResourceClaim', 'Pod'], rows: made } } : {}) },
    'Claim Spec - Requests': { table: { head: REQUESTS, rows: requestRows(o.spec.spec.devices?.requests) } },
  }
}

// ── tests ────────────────────────────────────────────────────────────────────────────────────────────────────────────

let ready = ''
let driverSlice = ''

test.describe('number check — DRA screens', () => {
  test.beforeAll(async () => {
    test.setTimeout(400_000)
    try {
      driverSlice = (JSON.parse(kubectl('get resourceslices -o json')).items as Obj[]).find((s) => s.spec?.driver === DRIVER)?.metadata.name ?? ''
    } catch {
      driverSlice = ''
    }
    if (!driverSlice) return
    cleanUp()
    kubectl('apply --server-side --field-manager=e2e-dra-num -f -', FIXTURE)
    // settled: both pods run, the claim each holds is allocated and reserved for it
    const deadline = Date.now() + 150_000
    for (;;) {
      const pods: Obj[] = JSON.parse(kubectl(`get pods -n ${NS} -o json`)).items
      const states = cellsByKey(await apiTable(`${R}/namespaces/${NS}/resourceclaims`))
      const made = madeClaim()
      const running = pods.length === 2 && pods.every((p) => p.status.phase === 'Running')
      if (running && made && states[`${NS}/num-held`]?.State === 'allocated,reserved' && states[`${NS}/${made}`]?.State === 'allocated,reserved') break
      if (Date.now() > deadline) throw new Error(`DRA fixture did not settle: ${JSON.stringify({ pods: pods.map((p) => [p.metadata.name, p.status.phase]), states })}`)
      await new Promise((r) => setTimeout(r, 2000))
    }
    ready = 'yes'
  })

  test.afterAll(() => {
    if (driverSlice) cleanUp()
  })

  const skipUnlessReady = async (page: Page) => {
    test.skip(!driverSlice, `needs the DRA example driver on ${CLUSTER} (scripts/kind-gpu.sh up)`)
    test.skip(!(await registeredOn(page, CLUSTER)), `needs the kind cluster ${CLUSTER}, registered as ${CLUSTER}`)
    expect(ready, 'the fixture settled').toBe('yes')
  }

  // each screen read from the list API alone (live updates held back) and with the live updates on top (a watch first
  // sends every object as ADDED); wide enough that no column folds
  test('the four DRA list screens show the rows, columns and cards the cluster has', async ({ page }) => {
    test.setTimeout(300_000)
    await skipUnlessReady(page)
    await page.context().addInitScript(() => localStorage.setItem('kubeast.listPageSize', '100'))
    const held = await page.context().newPage()
    await held.routeWebSocket(/wsMultiplexer/, () => {})
    for (const p of [held, page]) await p.setViewportSize({ width: 2560, height: 1200 })
    for (const s of SCREENS) {
      for (const [way, p] of [['list API', held], ['live', page]] as const) {
        await test.step(`${s.path} · ${way}`, async () => {
          await p.goto(url(s.path))
          await expect.poll(() => screenDiff(p, s), { timeout: 30_000, message: `${s.path} (${way})` }).toEqual([])
        })
      }
    }
    await held.close()
  })

  // each list follows the cluster without a reload: an object made, changed (a claim allocated to a pod, then released
  // — the state goes back to pending, not the allocation it had) and removed
  test('the four DRA list screens follow the cluster live', async ({ page }) => {
    test.setTimeout(400_000)
    await skipUnlessReady(page)
    await page.addInitScript(() => localStorage.setItem('kubeast.listPageSize', '100'))
    await page.setViewportSize({ width: 2560, height: 1200 })
    // a slice of all nodes of a driver nothing runs (no class selects it), so no claim is allocated from it
    const liveSlice = (devices: string[]) => JSON.stringify(dra('ResourceSlice', LIVE_SLICE, {
      driver: CLASS, allNodes: true, pool: { name: 'num-live', generation: 1, resourceSliceCount: 1 }, devices: devices.map((name) => ({ name })),
    }, false))
    const stateOf = async (name: string) => cellsByKey(await apiTable(`${R}/namespaces/${NS}/resourceclaims`))[`${NS}/${name}`]?.State
    const steps: { path: string; seen: string; changes: { what: string; run: () => void; until?: () => Promise<boolean> }[] }[] = [
      { path: '/gpu/deviceclasses', seen: CLASS, changes: [
        { what: 'a class made', run: () => kubectl('apply -f -', JSON.stringify(dra('DeviceClass', LIVE_CLASS, { selectors: [{ cel: { expression: 'true' } }] }, false))) },
        { what: 'its selectors changed', run: () => kubectl('apply -f -', JSON.stringify(dra('DeviceClass', LIVE_CLASS, { selectors: [{ cel: { expression: 'true' } }, { cel: { expression: 'false' } }] }, false))) },
        { what: 'the class removed', run: () => kubectl(`delete deviceclass ${LIVE_CLASS} --wait=true`) },
      ] },
      { path: '/gpu/resourceclaimtemplates', seen: 'num-two', changes: [
        { what: 'a template made', run: () => kubectl('apply -f -', JSON.stringify(dra('ResourceClaimTemplate', 'num-live-tmpl', { spec: claimSpec([{ name: 'a', exactly: { deviceClassName: DRIVER } }]) }))) },
        { what: 'the template removed', run: () => kubectl(`delete resourceclaimtemplate num-live-tmpl -n ${NS} --wait=true`) },
      ] },
      { path: '/gpu/resourceclaims', seen: 'num-held', changes: [
        { what: 'a claim made', run: () => kubectl('apply -f -', JSON.stringify(dra('ResourceClaim', 'num-live', claimSpec([{ name: 'gpu', exactly: { deviceClassName: DRIVER } }])))), until: async () => (await stateOf('num-live')) === 'pending' },
        { what: 'a pod holding it', run: () => kubectl('apply -f -', JSON.stringify(pod('num-pod-live', { resourceClaimName: 'num-live' }))), until: async () => (await stateOf('num-live')) === 'allocated,reserved' },
        { what: 'the pod gone, the claim released', run: () => kubectl(`delete pod num-pod-live -n ${NS} --wait=false`), until: async () => (await stateOf('num-live')) === 'pending' },
        { what: 'the claim removed', run: () => kubectl(`delete resourceclaim num-live -n ${NS} --wait=true`), until: async () => (await stateOf('num-live')) === undefined },
      ] },
      { path: '/gpu/resourceslices', seen: driverSlice, changes: [
        { what: 'a slice made', run: () => kubectl('apply -f -', liveSlice(['a', 'b', 'c'])) },
        { what: 'its devices changed', run: () => kubectl('apply -f -', liveSlice(['a'])) },
        { what: 'the slice removed', run: () => kubectl(`delete resourceslice ${LIVE_SLICE} --wait=true`) },
      ] },
    ]
    for (const step of steps) {
      const s = screen(step.path)
      await test.step(`${s.path} · live`, async () => {
        // the watch has sent the objects there are (its first events) before anything changes
        const socket = page.waitForEvent('websocket', (ws) => /wsMultiplexer/.test(ws.url()))
        await page.goto(url(s.path))
        const sent = await (await socket).waitForEvent('framereceived', { predicate: (f) => String(f.payload).includes(step.seen), timeout: 20_000 }).then(() => true, () => false)
        expect(sent, `${s.path}: the live updates send ${step.seen}`).toBe(true)
        await expect.poll(() => screenDiff(page, s), { timeout: 30_000, message: `${s.path} before the changes` }).toEqual([])
        for (const change of step.changes) {
          change.run()
          await expect.poll(async () => (change.until && !(await change.until()) ? ['the cluster has not got there yet'] : screenDiff(page, s)), {
            timeout: 60_000, message: `${s.path} · ${change.what}, without a reload`,
          }).toEqual([])
        }
      })
    }
  })

  // the drawers' rows, tables and "(n)" counts, worked out from the objects (a drawer reads its object when it opens)
  test('the four DRA drawers show the rows, tables and counts the objects give', async ({ page }) => {
    test.setTimeout(300_000)
    await skipUnlessReady(page)
    const made = madeClaim()!
    const targets: { detail: string; want: (s: Snap) => Record<string, WantSection> }[] = [
      { detail: `DeviceClass/${CLASS}`, want: (s) => classWant(s, CLASS) },
      { detail: `DeviceClass/${DRIVER}`, want: (s) => classWant(s, DRIVER) },
      { detail: `ResourceSlice/${driverSlice}`, want: (s) => sliceWant(s, driverSlice) },
      { detail: `ResourceSlice/${ALL_SLICE}`, want: (s) => sliceWant(s, ALL_SLICE) },
      { detail: `ResourceClaim/${NS}/num-held`, want: (s) => claimWant(s, 'num-held') },
      { detail: `ResourceClaim/${NS}/${made}`, want: (s) => claimWant(s, made) },
      { detail: `ResourceClaim/${NS}/num-class`, want: (s) => claimWant(s, 'num-class') },
      { detail: `ResourceClaimTemplate/${NS}/num-one`, want: (s) => templateWant(s, 'num-one') },
      { detail: `ResourceClaimTemplate/${NS}/num-two`, want: (s) => templateWant(s, 'num-two') },
    ]
    for (const t of targets) {
      await test.step(t.detail, async () => {
        const kind = t.detail.split('/')[0]
        const pagePath = { DeviceClass: '/gpu/deviceclasses', ResourceSlice: '/gpu/resourceslices', ResourceClaim: '/gpu/resourceclaims', ResourceClaimTemplate: '/gpu/resourceclaimtemplates' }[kind]!
        await page.goto(url(pagePath, `&detail=${encodeURIComponent(t.detail)}`))
        await page.locator(DRAWER).last().waitFor({ timeout: 20_000 })
        await expect.poll(async () => drawerDiff(await readDrawer(page), t.want(await snapshot())), { timeout: 30_000, message: t.detail }).toEqual([])
      })
    }
  })

  // what kubectl describe's generic describer lists: the events of the object's kind and name, in its namespace, a
  // cluster-scoped object's in every namespace ("default", where recorders write them); none is a section without a table
  test('the four DRA drawers list the events about the object, and an empty section without any', async ({ page }) => {
    test.setTimeout(150_000)
    await skipUnlessReady(page)
    const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
    const written: string[] = []
    const write = (ns: string, kind: string, name: string) => {
      const eventName = `${name}.e2e-dra-events`.toLowerCase()
      if (ns === 'default') written.push(eventName)
      kubectl('create -f -', JSON.stringify({
        apiVersion: 'v1', kind: 'Event', metadata: { name: eventName, namespace: ns },
        involvedObject: { apiVersion: 'resource.k8s.io/v1', kind, name, ...(ns === 'default' ? {} : { namespace: ns }) },
        reason: 'NumSeen', message: `${kind} seen by the e2e run`, type: 'Normal', count: 1, firstTimestamp: at, lastTimestamp: at, source: { component: 'e2e' },
      }))
    }
    write('default', 'DeviceClass', CLASS)
    write('default', 'ResourceSlice', ALL_SLICE)
    write(NS, 'ResourceClaim', 'num-held')
    write(NS, 'ResourceClaimTemplate', 'num-one')
    try {
      const pages: Record<string, string> = { DeviceClass: '/gpu/deviceclasses', ResourceSlice: '/gpu/resourceslices', ResourceClaim: '/gpu/resourceclaims', ResourceClaimTemplate: '/gpu/resourceclaimtemplates' }
      const eventsOf = async () => {
        const events = (await readDrawer(page)).Events
        return events ? events.tables.flatMap((t) => t.rows.map((r) => r.slice(0, 3))) : 'no Events section'
      }
      for (const [detail, kind, seen] of [
        [`DeviceClass/${CLASS}`, 'DeviceClass', true], [`ResourceSlice/${ALL_SLICE}`, 'ResourceSlice', true],
        [`ResourceClaim/${NS}/num-held`, 'ResourceClaim', true], [`ResourceClaimTemplate/${NS}/num-one`, 'ResourceClaimTemplate', true],
        [`ResourceClaim/${NS}/num-free`, 'ResourceClaim', false], [`ResourceClaimTemplate/${NS}/num-two`, 'ResourceClaimTemplate', false],
      ] as [string, string, boolean][]) await test.step(detail, async () => {
        await page.goto(url(pages[kind], `&detail=${encodeURIComponent(detail)}`))
        await page.locator(DRAWER).last().waitFor({ timeout: 20_000 })
        await expect.poll(eventsOf, { timeout: 20_000, message: detail }).toEqual(seen ? [['Normal', 'NumSeen', `${kind} seen by the e2e run`]] : [])
      })
    } finally {
      if (written.length) kubectl(`delete events -n default ${written.join(' ')} --ignore-not-found`)
    }
  })

  // a Read grant limited to the fixture's namespace: the cluster refuses it DeviceClasses and ResourceSlices, so their
  // cards read "-" (not 0) and the table says why; ResourceClaims of every namespace are those of its namespace
  test('a grant limited to namespaces reads "-" on the cards of the kinds it may not list', async ({ page, browser, request }) => {
    test.setTimeout(150_000)
    await skipUnlessReady(page)
    const admin = process.env.E2E_USER_EMAIL || 'admin'
    const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })
    const login = async (email: string, password: string) => {
      const res = await request.post('/api/v1/auth/login', { data: { email, password } })
      expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
      return (await res.json()).access_token as string
    }
    const adminToken = await login(admin, process.env.E2E_USER_PASSWORD || '')
    const id = Date.now().toString(36)
    const email = `e2e-dra-scoped-${id}@kubeast.local`
    const password = `dra-${id}-pw`
    const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(adminToken), data: { name: `E2E dra ${id}`, email, password } })
    expect(created.status(), await created.text()).toBe(201)
    const userId = (await created.json()).id
    const binding = JSON.stringify({
      apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: { name: 'e2e-dra-num-read', namespace: NS },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'view' },
      subjects: [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: READ_GROUP }],
    })
    const ctx = await browser.newContext({ baseURL: process.env.E2E_BASE_URL || 'http://localhost:30080', viewport: { width: 2560, height: 1200 } })
    try {
      kubectl('apply -f -', binding)
      const put = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(adminToken), data: { role: 'Read', namespaces: [NS] } })
      expect(put.ok(), await put.text()).toBeTruthy()
      // the identity Kubeast acts as for the user: refused the cluster-scoped kinds, allowed the namespace's claims
      // (kubectl auth can-i exits 1 on "no")
      const as = `--as=${email} --as-group=kubeast:authenticated --as-group=${READ_GROUP}`
      const canI = (args: string) => { try { return kubectl(`auth can-i ${args} ${as}`) } catch (e) { return String((e as { stdout?: string }).stdout ?? '').trim() } }
      for (const r of ['deviceclasses', 'resourceslices']) expect(canI(`list ${r}.resource.k8s.io`), `list ${r} as the grant`).toBe('no')
      const claims = (JSON.parse(kubectl(`get resourceclaims -n ${NS} ${as} -o json`)).items as Obj[]).map((c) => `${NS}/${c.metadata.name}`).sort()
      const states = cellsByKey(await apiTable(`${R}/namespaces/${NS}/resourceclaims`))

      const user = await ctx.newPage()
      await user.goto('/login')
      await user.locator('input[autocomplete="email"]').first().fill(email)
      await user.locator('input[type="password"]').first().fill(password)
      await user.locator('button[type="submit"]').first().click()
      await user.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), { timeout: 20_000 })
      for (const [p, cards] of [['/gpu/deviceclasses', { Total: '-' }], ['/gpu/resourceslices', { Total: '-', 'Total Devices': '-' }]] as const) {
        await user.goto(url(p))
        await expect(user.getByTestId('table-forbidden'), `${p}: the table says why`).toHaveText(/permission/i, { timeout: 20_000 })
        await expect.poll(async () => (await readScreen(user)).cards, { message: `${p}: cards` }).toEqual(cards)
      }
      await user.goto(url('/gpu/resourceclaims'))
      const count = (w: string) => String(claims.filter((k) => words(states[k]?.State ?? '').includes(w)).length)
      const want = { Total: String(claims.length), Allocated: count('allocated'), Reserved: count('reserved'), Pending: count('pending') }
      await expect.poll(async () => {
        const { heads, rows, cards } = await readScreen(user)
        const at = (h: string) => heads.findIndex((x) => x === h)
        // the table's filler rows (empty cells) are not rows of the list
        return { rows: rows.filter((r) => r.length === heads.length && r[at('Name')]).map((r) => `${r[at('Namespace')]}/${r[at('Name')]}`).sort(), cards }
      }, { timeout: 20_000, message: 'ResourceClaims of every namespace, as the grant' }).toEqual({ rows: claims, cards: want })
    } finally {
      await ctx.close()
      await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(adminToken) })
      kubectl(`delete rolebinding e2e-dra-num-read -n ${NS} --ignore-not-found`)
    }
  })

  // a cluster that does not serve resource.k8s.io (before 1.31, or the API turned off): the server answers each list
  // empty with X-Kubeast-Not-Installed (ListIfServed), the page says the cluster does not serve the kind — a built-in
  // API, so not the CRD text — and offers no Create; the answer stood in for here, since every dev cluster serves DRA
  test('a cluster without DRA says it does not serve the kind on the four lists', async ({ page }) => {
    test.skip(!(await registeredOn(page, CLUSTER)), `needs the kind cluster ${CLUSTER}, registered as ${CLUSTER}`)
    const lists: Record<string, string> = { '/gpu/deviceclasses': 'deviceclasses', '/gpu/resourceclaims': 'resourceclaims', '/gpu/resourceclaimtemplates': 'resourceclaimtemplates', '/gpu/resourceslices': 'resourceslices' }
    await page.route((u) => /\/api\/v1\/cluster\/(deviceclasses|resourceslices|resourceclaims\/all|resourceclaimtemplates\/all)$/.test(u.pathname), (route) => {
      const resource = /\/cluster\/(\w+)/.exec(new URL(route.request().url()).pathname)![1]
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'X-Kubeast-Not-Installed': resource }, body: '[]' })
    })
    // such a cluster sends no live updates of these kinds either: the list API's answer alone
    await page.routeWebSocket(/wsMultiplexer/, () => {})
    const kinds: Record<string, string> = { deviceclasses: 'DeviceClass', resourceclaims: 'ResourceClaim', resourceclaimtemplates: 'ResourceClaimTemplate', resourceslices: 'ResourceSlice' }
    for (const [p, resource] of Object.entries(lists)) {
      await page.goto(url(p))
      await expect(page.getByTestId('table-not-installed'), p).toHaveText(new RegExp(`^${kinds[resource]} is not served by this cluster \\(a built-in Kubernetes API`), { timeout: 20_000 })
      await expect(page.getByRole('button', { name: /^Create / }), `${p}: no Create`).toHaveCount(0)
    }
  })
})
