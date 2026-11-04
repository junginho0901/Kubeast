import { execSync } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

import { GW, arg, gatewayFixture, gatewayVersions, routeConds, summary, writeGatewayStatus } from './number-check.gateway-shared'

// Every Gateway API drawer's numbers are the cluster's: on test2, with number-check.gateway-fixture.yaml in a namespace
// of its own, the statuses a controller would write and events about the objects, each of the six drawers — opened
// from its list (the list's row) and by link (the object), a BackendTLSPolicy also from Gateway → Policies — shows in
// its rows, badges, "(n)" titles, cards, tables and notes what the object says, what kubectl prints of it (the API
// server's Table of the CRD's columns) and the events kubectl describe lists. The whole drawer is compared, so a
// number on it that nothing here expects fails too.

const NS = 'e2e-gw-drawers'
const CLUSTER = 'test2'
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any
type Cells = Record<string, string>
type Kube = { kubectl: (args: string, input?: string) => string; table: (apiPath: string) => Promise<Record<string, Cells>> }

// test2's kubectl and the API server's Table — what `kubectl get` prints — by object name and column; null without
// the kind cluster
function test2(): Kube | null {
  let kc: string
  try {
    kc = execSync(`kind get kubeconfig --name ${CLUSTER}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  } catch {
    return null
  }
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-gw-drawers-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kc, { mode: 0o600 })
  const pick = (k: string) => (kc.match(new RegExp(`${k}: (\\S+)`)) ?? [])[1] ?? ''
  const server = new URL(pick('server'))
  return {
    kubectl: (args, input) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim(),
    table: (apiPath) => new Promise((resolve, reject) => {
      https.request({
        host: server.hostname, port: server.port, path: apiPath, method: 'GET',
        ca: Buffer.from(pick('certificate-authority-data'), 'base64'),
        cert: Buffer.from(pick('client-certificate-data'), 'base64'),
        key: Buffer.from(pick('client-key-data'), 'base64'),
        headers: { Accept: 'application/json;as=Table;g=meta.k8s.io;v=v1' },
      }, (r) => {
        let s = ''
        r.on('data', (c) => (s += c))
        r.on('end', () => {
          if (r.statusCode !== 200) return reject(new Error(`${apiPath}: ${r.statusCode} ${s.slice(0, 200)}`))
          const t = JSON.parse(s) as { columnDefinitions: { name: string }[]; rows: { cells: unknown[]; object: { metadata: { name: string } } }[] }
          resolve(Object.fromEntries(t.rows.map((row) => [row.object.metadata.name,
            Object.fromEntries(t.columnDefinitions.map((c, i) => [c.name, row.cells[i] == null ? '' : String(row.cells[i])]))])))
        })
      }).on('error', reject).end()
    }),
  }
}

// A drawer as read: the rows (label → values), the summary badges, the "(n)" of section titles, and per section its
// cards (their "Label: value" lines, or their text, and tables), its tables, chips, notes and lines outside cards.
type TableView = { head: string[]; rows: string[][] }
type Card = { lines: Record<string, string>; tables: TableView[] }
type Section = { cards: Card[]; tables: TableView[]; chips: string[]; notes: string[]; lines: Record<string, string> }
type View = { badges: Record<string, string>; rows: Record<string, string[]>; counts: Record<string, number>; sections: Record<string, Section> }

async function readDrawer(page: Page): Promise<View> {
  return page.locator(DRAWER).last().evaluate((root) => {
    const txt = (el: Element) => (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim()
    const has = (el: Element, ...names: string[]) => names.every((n) => el.classList.contains(n))
    const tableOf = (tb: Element) => ({
      head: [...tb.querySelectorAll('thead th')].map(txt),
      rows: [...tb.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map(txt)),
    })
    // "Label: value": a div whose first element is the grey label ending in ":"
    const linesOf = (els: Element[]) => {
      const out: Record<string, string> = {}
      for (const d of els) {
        const label = d.firstElementChild
        if (!label || label.tagName !== 'SPAN' || !has(label, 'text-slate-400') || !txt(label).endsWith(':')) continue
        out[txt(label).slice(0, -1)] = txt(d).slice(txt(label).length).trim()
      }
      return out
    }
    const view: View = { badges: {}, rows: {}, counts: {}, sections: {} }
    for (const sec of root.querySelectorAll('div.rounded-lg.border')) {
      const title = sec.firstElementChild?.firstElementChild
      if (!title || title.tagName !== 'P') continue
      const m = /^(.*) \((\d+)\)$/.exec(txt(title))
      const name = m ? m[1] : txt(title)
      if (m) view.counts[name] = Number(m[2])
      const cards = [...sec.querySelectorAll('div')].filter((d) => has(d, 'rounded-sm', 'border'))
      const inCard = (el: Element) => cards.some((c) => c.contains(el))
      const divs = [...sec.querySelectorAll('div')]
      for (const g of divs.filter((d) => has(d, 'grid'))) {
        const spans = [...g.children].filter((c) => c.tagName === 'SPAN')
        if (spans.length === 2 && g.children.length === 2 && has(spans[0], 'text-slate-400')) (view.rows[txt(spans[0])] ??= []).push(txt(spans[1]))
      }
      for (const b of sec.querySelectorAll('span.rounded-full')) {
        const bm = b.className.includes('py-0.5') ? /^([^:]+): (.*)$/.exec(txt(b)) : null
        if (bm) view.badges[bm[1]] = bm[2]
      }
      view.sections[name] = {
        cards: cards.map((c) => {
          const lines = linesOf([...c.querySelectorAll('div')])
          return { lines: Object.keys(lines).length ? lines : { '#': txt(c) }, tables: [...c.querySelectorAll('table')].map(tableOf) }
        }),
        tables: [...sec.querySelectorAll('table')].filter((t) => !inCard(t)).map(tableOf),
        chips: [...sec.querySelectorAll('span')].filter((s) => has(s, 'rounded-sm', 'border')).map(txt),
        notes: [...sec.querySelectorAll('p')].filter((p) => p !== title && !inCard(p)).map(txt),
        lines: linesOf(divs.filter((d) => !inCard(d))),
      }
    }
    return view
  })
}

// A time the drawer shows as an age, or as "YYYY-MM-DD HH:mm:ss (age)", is written "@<RFC 3339>" in what the drawer
// must show; a shown time that is that one (to the second, the age within 15 s or 15 %) reads the same, so the rest
// compares with toEqual.
function ageSeconds(s: string): number {
  const units: Record<string, number> = { y: 31536000, d: 86400, h: 3600, m: 60, s: 1 }
  let total = 0
  for (const m of s.matchAll(/(\d+)([ydhms])/g)) total += Number(m[1]) * units[m[2]]
  return /\d/.test(s) ? total : NaN
}
function sameTime(shown: string, iso: string): boolean {
  const at = Date.parse(iso)
  const real = (Date.now() - at) / 1000
  const closeAge = (age: string) => Math.abs(ageSeconds(age) - real) <= Math.max(15, real * 0.15)
  const abs = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) \((.+)\)$/.exec(shown)
  if (abs) return Math.abs(new Date(`${abs[1]}T${abs[2]}`).getTime() - at) <= 1000 && closeAge(abs[3])
  return closeAge(shown)
}
function settle(got: unknown, want: unknown): unknown {
  if (typeof want === 'string' && want.startsWith('@') && typeof got === 'string') return sameTime(got, want.slice(1)) ? want : got
  if (Array.isArray(got)) return got.map((g, i) => settle(g, Array.isArray(want) ? want[i] : undefined))
  if (got && typeof got === 'object') {
    const w = (want && typeof want === 'object' ? want : {}) as Record<string, unknown>
    return Object.fromEntries(Object.entries(got).map(([k, v]) => [k, settle(v, w[k])]))
  }
  return got
}

// What the drawer must show, in Kubeast's words: an empty value is "-"
const dash = (v: unknown) => (v === undefined || v === null || v === '' ? '-' : String(v))
// the Unix epoch a CRD's default condition carries (Gateway API: "Waiting for controller") is no time on screen
// (utils/time), as an absent one
const at = (t?: string) => (t && new Date(t).getUTCFullYear() >= 1980 ? `@${t}` : '-')
const section = (s: Partial<Section> = {}): Section => ({ cards: [], tables: [], chips: [], notes: [], lines: {}, ...s })
const rowsOf = (rows: Record<string, string>) => Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, [v]]))
// a condition's status as kubectl's column prints it; a route's parents pooled — True when one says so, else the first
const conditionOf = (conds: Obj[], type: string) => {
  const of = conds.filter((c) => c.type === type)
  return dash((of.find((c) => c.status === 'True') ?? of[0])?.status)
}
const conditionsTable = (conds: Obj[]): TableView[] => (conds.length
  ? [{ head: ['Type', 'Status', 'Reason', 'Message', 'Last Transition'], rows: conds.map((c) => [dash(c.type), dash(c.status), dash(c.reason), dash(c.message), at(c.lastTransitionTime)]) }]
  : [])
// newest first, as kubectl's printEvent dates them
const eventsTable = (events: Obj[]): TableView[] => (events.length
  ? [{ head: ['Type', 'Reason', 'Message', 'Last Seen', 'Count'], rows: events.map((e) => [dash(e.type), dash(e.reason), dash(e.message), at(e.lastTimestamp ?? e.firstTimestamp), String(e.count ?? 1)]) }]
  : [])
const backendTable = (refs: Obj[]): TableView => ({
  head: ['Name', 'Namespace', 'Kind', 'Group', 'Port', 'Weight'],
  rows: refs.map((b) => [dash(b.name), dash(b.namespace), dash(b.kind), dash(b.group), dash(b.port), dash(b.weight)]),
})
// a parent or ancestor reference: Kind.group/name (ns=…, section=…, port=…)
const parentRef = (r: Obj) => {
  const extras = [r.namespace && `ns=${r.namespace}`, r.sectionName && `section=${r.sectionName}`, r.port != null && `port=${r.port}`].filter(Boolean)
  const head = `${dash(r.kind)}${r.group ? `.${r.group}` : ''}/${dash(r.name)}`
  return extras.length ? `${head} (${extras.join(', ')})` : head
}
const lifecycle = (o: Obj) => ({ UID: o.metadata.uid, 'Resource Version': o.metadata.resourceVersion, 'API Version': o.apiVersion, Finalizers: (o.metadata.finalizers ?? []).join(', ') || '-' })
// the sections after a drawer's own: events, the object's metadata, labels and annotations when it has any
function closing(c: Ctx, withLifecycle = true): Record<string, Section> {
  return {
    Events: section({ tables: eventsTable(c.events) }),
    ...(withLifecycle ? { Lifecycle: section() } : {}),
    ...(Object.keys(c.o.metadata.labels ?? {}).length ? { Labels: section() } : {}),
    ...(Object.keys(c.o.metadata.annotations ?? {}).length ? { Annotations: section() } : {}),
  }
}

type Ctx = { o: Obj; cells: Cells; events: Obj[] }
type Kind = { kind: string; plural: string; list: string; namespaced: boolean; names: string[]; want: (c: Ctx) => View }

const KINDS: Kind[] = [
  {
    kind: 'GatewayClass', plural: 'gatewayclasses', list: '/gateway/gatewayclasses', namespaced: false, names: ['num-gc-ready', 'num-gc-plain'],
    want: (c) => {
      const { o, cells } = c
      const conds = o.status?.conditions ?? []
      const p = o.spec.parametersRef
      const features: Obj[] = o.status?.supportedFeatures ?? []
      return {
        badges: { Status: summary(conds, 'Accepted'), Accepted: dash(cells.Accepted) },
        rows: rowsOf({
          Name: o.metadata.name, Controller: dash(cells.Controller), Description: dash(cells.Description ?? o.spec.description),
          'Parameters Ref': p ? `${dash(p.kind)}${p.group ? `.${p.group}` : ''}${p.name ? `/${p.name}` : ''}${p.namespace ? ` (ns: ${p.namespace})` : ''}` : '-',
          Created: at(o.metadata.creationTimestamp), ...lifecycle(o),
        }),
        counts: features.length ? { 'Supported Features': features.length } : {} as Record<string, number>,
        sections: {
          'GatewayClass Info': section(),
          Conditions: section({ tables: conditionsTable(conds) }),
          ...(features.length ? { 'Supported Features': section({ chips: features.map((f) => dash(f.name)) }) } : {}),
          ...closing(c),
        },
      }
    },
  },
  {
    kind: 'Gateway', plural: 'gateways', list: '/gateway/gateways', namespaced: true, names: ['num-gw-a', 'num-gw-b', 'num-gw-c'],
    want: (c) => {
      const { o, cells } = c
      const conds = o.status?.conditions ?? []
      const listeners: Obj[] = o.spec.listeners ?? []
      const statuses: Obj[] = o.status?.listeners ?? []
      const addresses: Obj[] = o.status?.addresses ?? []
      const attached = statuses.reduce((s, l) => s + Number(l.attachedRoutes ?? 0), 0)
      const kinds = (s: Obj) => (s?.supportedKinds ?? []).map((k: Obj) => (k.group ? `${dash(k.kind)}.${k.group}` : dash(k.kind))).join(', ') || '-'
      return {
        badges: { Status: summary(conds, 'Programmed', 'Accepted'), Programmed: dash(cells.Programmed), Accepted: conditionOf(conds, 'Accepted') },
        rows: rowsOf({
          Name: o.metadata.name, Namespace: NS, 'Gateway Class': dash(cells.Class), Listeners: String(listeners.length),
          'Attached Routes': String(attached), Addresses: String(addresses.length),
          Created: at(o.metadata.creationTimestamp), ...lifecycle(o),
        }),
        counts: {},
        sections: {
          'Gateway Info': section(),
          Addresses: addresses.length ? section({ tables: [{ head: ['Type', 'Value'], rows: addresses.map((a) => [dash(a.type), dash(a.value)]) }] }) : section({ notes: ['None'] }),
          Listeners: listeners.length
            ? section({
              cards: listeners.map((l) => {
                const s = statuses.find((x) => x.name === l.name)
                return {
                  lines: { Name: dash(l.name), Hostname: dash(l.hostname), Protocol: dash(l.protocol), Port: dash(l.port), 'Attached Routes': dash(s?.attachedRoutes), 'Supported Kinds': kinds(s) },
                  tables: conditionsTable(s?.conditions ?? []),
                }
              }),
            })
            : section({ notes: ['None'] }),
          'Attached Routes Summary': statuses.length
            ? section({
              cards: statuses.map((s) => ({ lines: { Listener: dash(s.name), 'Attached Routes': String(Number(s.attachedRoutes ?? 0)), 'Accepted Kinds': kinds(s) }, tables: [] })),
              notes: [`Total: ${attached} route(s) attached across ${statuses.length} listener(s). Route details are available in HTTPRoute / GRPCRoute resources that reference this gateway.`],
            })
            : section({ notes: ['No listener status data available to determine attached routes.'] }),
          Conditions: section({ tables: conditionsTable(conds) }),
          ...closing(c),
        },
      }
    },
  },
  {
    kind: 'HTTPRoute', plural: 'httproutes', list: '/gateway/httproutes', namespaced: true, names: ['num-http-a', 'num-http-b', 'num-http-c'],
    want: (c) => {
      const { o } = c
      const rules: Obj[] = o.spec.rules ?? []
      const parentRefs: Obj[] = o.spec.parentRefs ?? []
      return {
        ...routeHead(c),
        sections: {
          'HTTPRoute Info': section(),
          'Parent Refs': parentRefs.length
            ? section({ cards: parentRefs.map((p) => ({ lines: { '#': p.sectionName ? `${p.name} section=${p.sectionName}` : p.name }, tables: [] })) })
            : section({ notes: ['None'] }),
          Rules: rules.length
            ? section({
              cards: rules.map((r) => {
                const matches: Obj[] = r.matches ?? []
                const backends: Obj[] = r.backendRefs ?? []
                return {
                  lines: { 'Rule Name': dash(r.name), Matches: String(matches.length), 'Backend Refs': String(backends.length), Filters: String((r.filters ?? []).length) },
                  tables: [
                    ...(matches.length ? [{
                      head: ['Path Type', 'Path', 'Method', 'Headers', 'Query Params'],
                      rows: matches.map((m) => [dash(m.path?.type), dash(m.path?.value), dash(m.method), String((m.headers ?? []).length), String((m.queryParams ?? []).length)]),
                    }] : []),
                    ...(backends.length ? [backendTable(backends)] : []),
                  ],
                }
              }),
            })
            : section({ notes: ['None'] }),
          ...routeTail(c),
        },
      }
    },
  },
  {
    kind: 'GRPCRoute', plural: 'grpcroutes', list: '/gateway/grpcroutes', namespaced: true, names: ['num-grpc-a', 'num-grpc-b'],
    want: (c) => {
      const { o } = c
      const rules: Obj[] = o.spec.rules ?? []
      const parentRefs: Obj[] = o.spec.parentRefs ?? []
      return {
        ...routeHead(c),
        sections: {
          'GRPCRoute Info': section(),
          'Parent Refs': parentRefs.length
            ? section({
              tables: [{
                head: ['Name', 'Namespace', 'Kind', 'Group', 'Section', 'Port'],
                rows: parentRefs.map((p) => [dash(p.name), dash(p.namespace), dash(p.kind), dash(p.group), dash(p.sectionName), dash(p.port)]),
              }],
            })
            : section({ notes: ['None'] }),
          Rules: rules.length
            ? section({
              cards: rules.map((r) => {
                const matches: Obj[] = r.matches ?? []
                const backends: Obj[] = r.backendRefs ?? []
                return {
                  lines: { Matches: String(matches.length), 'Backend Refs': String(backends.length), Filters: String((r.filters ?? []).length) },
                  tables: [
                    ...(matches.length ? [{
                      head: ['Service', 'Method', 'Headers', 'Type'],
                      rows: matches.map((m) => [dash(m.method?.service), dash(m.method?.method), String((m.headers ?? []).length), dash(m.method?.type)]),
                    }] : []),
                    ...(backends.length ? [backendTable(backends)] : []),
                  ],
                }
              }),
            })
            : section({ notes: ['None'] }),
          ...routeTail(c),
        },
      }
    },
  },
  {
    kind: 'ReferenceGrant', plural: 'referencegrants', list: '/gateway/referencegrants', namespaced: true, names: ['num-rg-a', 'num-rg-b'],
    want: (c) => {
      const { o } = c
      const from: Obj[] = o.spec.from ?? []
      const to: Obj[] = o.spec.to ?? []
      return {
        badges: {},
        rows: rowsOf({ Name: o.metadata.name, Namespace: NS, 'From Rules': String(from.length), 'To Rules': String(to.length), Created: at(o.metadata.creationTimestamp), ...lifecycle(o) }),
        counts: {},
        sections: {
          'ReferenceGrant Info': section(),
          From: from.length ? section({ tables: [{ head: ['Group', 'Kind', 'Namespace'], rows: from.map((f) => [dash(f.group), dash(f.kind), dash(f.namespace)]) }] }) : section({ notes: ['None'] }),
          To: to.length ? section({ tables: [{ head: ['Group', 'Kind', 'Name'], rows: to.map((t) => [dash(t.group), dash(t.kind), dash(t.name)]) }] }) : section({ notes: ['None'] }),
          ...closing(c),
        },
      }
    },
  },
  {
    kind: 'BackendTLSPolicy', plural: 'backendtlspolicies', list: '/gateway/backendtlspolicies', namespaced: true, names: ['num-btls-a', 'num-btls-b'],
    want: (c) => {
      const { o } = c
      const refs: Obj[] = o.spec.targetRefs ?? []
      const v = o.spec.validation
      const cas: Obj[] = v?.caCertificateRefs ?? []
      const ancestors: Obj[] = o.status?.ancestors ?? []
      return {
        badges: {},
        rows: rowsOf({
          Name: o.metadata.name, Namespace: NS, 'Target Refs': String(refs.length), Created: at(o.metadata.creationTimestamp),
          ...(v ? { Hostname: dash(v.hostname), 'Well-Known CA Certificates': dash(v.wellKnownCACertificates) } : {}),
        }),
        counts: {},
        sections: {
          'BackendTLSPolicy Info': section(),
          'Target Refs': refs.length
            ? section({ tables: [{ head: ['Group', 'Kind', 'Name', 'Section'], rows: refs.map((r) => [dash(r.group), dash(r.kind), dash(r.name), dash(r.sectionName)]) }] })
            : section({ notes: ['None'] }),
          ...(v ? {
            'TLS Validation': section(cas.length ? { notes: ['CA Certificate Refs'], tables: [{ head: ['Group', 'Kind', 'Name'], rows: cas.map((r) => [dash(r.group), dash(r.kind), dash(r.name)]) }] } : {}),
          } : {}),
          ...(ancestors.length ? {
            Status: section({ cards: ancestors.map((a) => ({ lines: { Controller: dash(a.controllerName), Ancestor: parentRef(a.ancestorRef ?? {}) }, tables: conditionsTable(a.conditions ?? []) })) }),
          } : {}),
          ...closing(c, false),
        },
      }
    },
  },
]

// a route's badges and rows: the list's Status, Accepted and ResolvedRefs over every parent, kubectl's HOSTNAMES
function routeHead(c: Ctx): Omit<View, 'sections'> {
  const { o, cells } = c
  const conds = routeConds(o)
  const rules: Obj[] = o.spec.rules ?? []
  const hostnames: string[] = cells.Hostnames ? JSON.parse(cells.Hostnames) : []
  return {
    badges: { Status: summary(conds, 'Accepted', 'ResolvedRefs'), Accepted: conditionOf(conds, 'Accepted'), ResolvedRefs: conditionOf(conds, 'ResolvedRefs') },
    rows: rowsOf({
      Name: o.metadata.name, Namespace: NS, Hostnames: hostnames.length ? hostnames.map((h) => h || '*').join(', ') : '*',
      'Parent Refs': String((o.spec.parentRefs ?? []).length), Rules: String(rules.length),
      'Backend Refs': String(rules.reduce((s, r) => s + (r.backendRefs ?? []).length, 0)),
      Created: at(o.metadata.creationTimestamp), ...lifecycle(o),
    }),
    counts: {},
  }
}
// a route's parent status (each parent's controller, reference and conditions), the conditions pooled, and the rest
function routeTail(c: Ctx): Record<string, Section> {
  const parents: Obj[] = c.o.status?.parents ?? []
  return {
    'Parent Status': parents.length
      ? section({ cards: parents.map((p) => ({ lines: { Controller: dash(p.controllerName), 'Parent Ref': parentRef(p.parentRef ?? {}) }, tables: conditionsTable(p.conditions ?? []) })) })
      : section({ notes: ['None'] }),
    Conditions: section({ tables: conditionsTable(routeConds(c.o)) }),
    ...closing(c),
  }
}

// events about the objects as a controller records them: two about a Gateway, one about an HTTPRoute of that Gateway's
// name (the Gateway's drawer leaves it out), a Warning seen twice, a cluster-scoped class's in namespace default.
// [kind, name, reason, type, count, last seen and first seen, seconds ago]
const EVENTS: [string, string, string, string, number, number, number][] = [
  ['Gateway', 'num-gw-a', 'NumbersSynced', 'Normal', 1, 300, 300],
  ['Gateway', 'num-gw-a', 'NumbersProgrammed', 'Normal', 3, 60, 900],
  ['HTTPRoute', 'num-gw-a', 'NumbersElsewhere', 'Normal', 1, 30, 30],
  ['HTTPRoute', 'num-http-a', 'NumbersAttached', 'Warning', 2, 120, 600],
  ['GRPCRoute', 'num-grpc-a', 'NumbersAttached', 'Normal', 1, 90, 90],
  ['ReferenceGrant', 'num-rg-a', 'NumbersSeen', 'Normal', 1, 45, 45],
  ['BackendTLSPolicy', 'num-btls-b', 'NumbersRejected', 'Warning', 4, 200, 1200],
  ['GatewayClass', 'num-gc-ready', 'NumbersAccepted', 'Normal', 1, 150, 150],
]
const eventNs = (kind: string) => (kind === 'GatewayClass' ? 'default' : NS)
const eventName = (name: string, reason: string) => `${name}.${reason.toLowerCase()}`
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString().replace(/\.\d+Z$/, 'Z')

test.describe('number check — Gateway API drawers', () => {
  test('every Gateway API drawer shows the numbers the cluster has, opened from its list and by link', async ({ page }) => {
    test.setTimeout(900_000)
    const k = test2()
    const served = k ? gatewayVersions(k.kubectl) : null
    const clusters = await (await page.request.get('/api/v1/clusters')).json()
    const registered = (Array.isArray(clusters) ? clusters : clusters.items ?? []).some((x: Obj) => x.id === CLUSTER)
    test.skip(!k || !served || !registered, 'needs the kind cluster test2, registered as test2, serving the Gateway API (experimental channel CRDs)')
    const t2 = k!
    const kindOf = (kind: string) => KINDS.find((x) => x.kind === kind)!
    const get = (kind: string, name: string): Obj => {
      const x = kindOf(kind)
      return JSON.parse(t2.kubectl(`get ${x.plural}.${GW} ${name}${x.namespaced ? ` -n ${NS}` : ''} -o json`))
    }
    // gone, not terminating, before and after: the list check makes the same classes
    const cleanup = () => {
      t2.kubectl(`delete namespace ${NS} --wait=true --timeout=180s --ignore-not-found`)
      t2.kubectl('delete gatewayclass/num-gc-ready gatewayclass/num-gc-plain --ignore-not-found --wait=true')
      t2.kubectl(`delete event -n default ${eventName('num-gc-ready', 'NumbersAccepted')} --ignore-not-found`)
    }
    cleanup()
    try {
      t2.kubectl('apply --server-side --field-manager=e2e-gw-drawers -f -', gatewayFixture(served!, NS))
      writeGatewayStatus(t2.kubectl, NS)
      // the features a controller says the class supports (alphabetical, as the API asks)
      t2.kubectl(`patch gatewayclass num-gc-ready --subresource=status --type=merge -p=${arg({ status: { supportedFeatures: [{ name: 'GRPCRoute' }, { name: 'HTTPRoute' }] } })}`)
      const items = EVENTS.map(([kind, name, reason, type, count, last, first]) => {
        let uid: string | undefined
        try {
          uid = get(kind, name).metadata.uid
        } catch {
          uid = undefined
        }
        return {
          apiVersion: 'v1', kind: 'Event',
          metadata: { name: eventName(name, reason), namespace: eventNs(kind) },
          involvedObject: { apiVersion: `${GW}/${served![kindOf(kind).plural]}`, kind, name, ...(kind === 'GatewayClass' ? {} : { namespace: NS }), ...(uid ? { uid } : {}) },
          reason, message: `${reason} by the number check`, type, count, firstTimestamp: ago(first), lastTimestamp: ago(last),
          source: { component: 'e2e-gw-drawers' },
        }
      })
      t2.kubectl('create -f -', JSON.stringify({ apiVersion: 'v1', kind: 'List', items }))

      // the object, kubectl's columns of it and the events kubectl describe lists about it (its name, kind and uid)
      const clusterOf = async (x: Kind, name: string): Promise<Ctx> => {
        const o = get(x.kind, name)
        const cells = (await t2.table(`/apis/${GW}/${served![x.plural]}/${x.namespaced ? `namespaces/${NS}/` : ''}${x.plural}`))[name] ?? {}
        const events = JSON.parse(t2.kubectl(`get events ${x.namespaced ? `-n ${NS}` : '-A'} --field-selector involvedObject.name=${name},involvedObject.kind=${x.kind} -o json`)).items
          .filter((e: Obj) => e.involvedObject.uid === o.metadata.uid)
          .sort((a: Obj, b: Obj) => Date.parse(b.lastTimestamp ?? b.firstTimestamp) - Date.parse(a.lastTimestamp ?? a.firstTimestamp))
        return { o, cells, events }
      }
      const open = async (x: Kind, name: string, way: string) => {
        if (way === 'link') {
          await page.goto(`/?cluster=${CLUSTER}&detail=${encodeURIComponent(x.namespaced ? `${x.kind}/${NS}/${name}` : `${x.kind}/${name}`)}`)
        } else {
          await page.goto(way === 'Gateway → Policies' ? `/gateway/policies?cluster=${CLUSTER}` : `${x.list}?cluster=${CLUSTER}${x.namespaced ? `&namespace=${NS}` : ''}`)
          // the row's name cell (the names here have no regular expression characters); Gateway → Policies lists every
          // namespace
          const exact = (v: string) => ({ hasText: new RegExp(`^\\s*${v}\\s*$`) })
          let row = page.locator('main tbody tr').filter({ has: page.locator('td', exact(name)) })
          if (way === 'Gateway → Policies') row = row.filter({ has: page.locator('td', exact(NS)) })
          await row.first().locator('td', exact(name)).click({ timeout: 20_000 })
        }
        await page.locator(DRAWER).last().waitFor({ timeout: 20_000 })
      }

      await page.context().addInitScript(() => localStorage.setItem('kubeast.listPageSize', '100'))
      for (const x of KINDS) {
        for (const name of x.names) {
          const ways = ['list', 'link', ...(x.kind === 'BackendTLSPolicy' ? ['Gateway → Policies'] : [])]
          for (const way of ways) {
            await test.step(`${x.kind}/${name} · ${way}`, async () => {
              const want = x.want(await clusterOf(x, name))
              await open(x, name, way)
              const shown = async () => settle(await readDrawer(page), want)
              try {
                await expect.poll(shown, { timeout: 20_000 }).toEqual(want)
              } catch {
                expect.soft(await shown(), `${x.kind}/${name} opened by ${way}`).toEqual(want)
              }
            })
          }
        }
      }
    } finally {
      cleanup()
    }
  })
})
