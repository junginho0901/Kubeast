import { execSync } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// The Endpoints, IngressClass, ReplicaSet, PersistentVolume, StorageClass and VolumeAttachment drawers show what the
// cluster has: on `self`, with number-check.netstore-fixture.yaml in a namespace of its own and what the spec adds to
// it (12 Ingresses of a class, 10 more volumes of a StorageClass, a ReplicaSet a ConfigMap controls, an attachment
// with errors written to its status, events about the objects), each drawer — opened from its list (the list's row)
// and by link (the object) — shows in its rows, badges, "(n)" titles, cards, tables, pagers, tags and notes what the
// object says, what kubectl prints of it (the API server's Table of pods) and the events kubectl describe lists. The
// whole drawer is compared, so a number on it that nothing here expects fails too.

const NS = 'e2e-netstore'
const CLUSTER = 'self'
const NODE = 'kubeast-control-plane'
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'
const FIXTURE = fs.readFileSync(path.join(__dirname, 'number-check.netstore-fixture.yaml'), 'utf8')
// the sections of other features, with number checks of their own (metrics, policy reports, the network views, log
// search): left out of what is read and of what is expected
const OTHER_FEATURES = ['Real-time Resource Usage', 'Policy violations', 'Network Policies', 'Recent Flows', 'Network Drops', 'Top Talkers', 'Log search']

const kc = execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' })
const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-netstore-drawers-')), 'kubeconfig')
fs.writeFileSync(kcPath, kc, { mode: 0o600 })
const kubectl = (args: string, input?: string) =>
  execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
const arg = (o: unknown) => `'${JSON.stringify(o).replace(/'/g, "'\\''")}'`

// the API server's Table of a list — what `kubectl get` prints — by object name and column
const pick = (k: string) => (kc.match(new RegExp(`${k}: (\\S+)`)) ?? [])[1] ?? ''
const server = new URL(pick('server'))
function apiTable(apiPath: string): Promise<Record<string, Record<string, string>>> {
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
      r.on('end', () => {
        if (r.statusCode !== 200) return reject(new Error(`${apiPath}: ${r.statusCode} ${s.slice(0, 200)}`))
        const t = JSON.parse(s) as { columnDefinitions: { name: string }[]; rows: { cells: unknown[]; object: { metadata: { name: string } } }[] }
        resolve(Object.fromEntries(t.rows.map((row) => [row.object.metadata.name,
          Object.fromEntries(t.columnDefinitions.map((c, i) => [c.name, row.cells[i] == null ? '' : String(row.cells[i])]))])))
      })
    }).on('error', reject).end()
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any

// A drawer as read: the summary badges, the "(n)" of section titles, and per section its rows (label → values), its
// cards (their "Label: value" lines, their other text, tables and chips), its tables, chips, tags ("key=value" of
// labels and the like), notes (text on its own), lines outside cards, pagers ("1-10 / 12") and JSON blocks.
type TableView = { head: string[]; rows: string[][] }
type Card = { lines: Record<string, string>; notes: string[]; tables: TableView[]; chips: string[] }
type Section = { rows: Record<string, string[]>; cards: Card[]; tables: TableView[]; chips: string[]; tags: string[]; notes: string[]; lines: Record<string, string>; pagers: string[]; json: unknown[] }
type View = { badges: Record<string, string>; counts: Record<string, number>; sections: Record<string, Section> }

async function readDrawer(page: Page): Promise<View> {
  return page.locator(DRAWER).last().evaluate((root, other) => {
    const txt = (el: Element) => (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim()
    const has = (el: Element, ...names: string[]) => names.every((n) => el.classList.contains(n))
    const tableOf = (tb: Element) => ({
      head: [...tb.querySelectorAll('thead th')].map(txt),
      rows: [...tb.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map(txt)),
    })
    const isRow = (g: Element) => g.children.length === 2 && g.children[0].tagName === 'SPAN' && g.children[1].tagName === 'SPAN' && has(g.children[0], 'text-slate-400')
    // "Label: value": a grid of a label and a value that is not an info row (a container's rows), or a div whose
    // first element is the grey label ending in ":"
    const linesOf = (els: Element[]) => {
      const out: Record<string, string> = {}
      for (const d of els) {
        const label = d.firstElementChild
        if (!label || label.tagName !== 'SPAN') continue
        if (has(d, 'grid') && d.children.length === 2 && !isRow(d)) out[txt(label)] = txt(d.children[1])
        else if (has(label, 'text-slate-400') && txt(label).endsWith(':')) out[txt(label).slice(0, -1)] = txt(d).slice(txt(label).length).trim()
      }
      return out
    }
    // text on its own: a p or a div with no element inside it, not in a row, a line, a table or a chip
    const inside = (el: Element, sel: string) => !!el.parentElement?.closest(sel)
    const notesOf = (els: Element[]) => els
      .filter((e) => (e.tagName === 'P' || (e.tagName === 'DIV' && e.children.length === 0)) && txt(e) !== '')
      .filter((e) => !inside(e, 'table') && !inside(e, 'div.grid'))
      .map(txt)
    const view = { badges: {} as Record<string, string>, counts: {} as Record<string, number>, sections: {} as Record<string, unknown> }
    for (const b of root.querySelectorAll('span.rounded-full')) {
      const bm = b.className.includes('py-0.5') ? /^([^:]+): (.*)$/.exec(txt(b)) : null
      if (bm) view.badges[bm[1]] = bm[2]
    }
    const skipped: Element[] = []
    for (const sec of root.querySelectorAll('div.rounded-lg.border')) {
      const title = sec.firstElementChild?.firstElementChild
      if (!title || title.tagName !== 'P') continue
      const m = /^(.*) \((\d+)\)$/.exec(txt(title))
      const name = m ? m[1] : txt(title)
      if ((other as string[]).includes(name) || skipped.some((s) => s.contains(sec))) {
        skipped.push(sec)
        continue
      }
      if (m) view.counts[name] = Number(m[2])
      const all = [...sec.querySelectorAll('*')].filter((e) => e !== title)
      const cards: Element[] = [...sec.querySelectorAll('div')].filter((d) => has(d, 'rounded-sm', 'border'))
      const inCard = (el: Element) => cards.some((c) => c !== el && c.contains(el))
      const tags = [...sec.querySelectorAll('span.rounded-full')].filter((s) => s.className.includes('py-1')).map((s) => {
        const parts = [...s.children].filter((c) => c.tagName === 'SPAN')
        return parts.length >= 3 ? `${parts[0].textContent?.trim()}=${parts[2].textContent?.trim()}` : txt(s)
      }).sort()
      const rows: Record<string, string[]> = {}
      for (const g of sec.querySelectorAll('div.grid')) if (isRow(g)) (rows[txt(g.children[0])] ??= []).push(txt(g.children[1]))
      view.sections[name] = {
        rows,
        cards: cards.filter((c) => !inCard(c)).map((c) => {
          const els = [...c.querySelectorAll('*')]
          return {
            lines: linesOf(els.filter((e) => e.tagName === 'DIV')),
            notes: notesOf(els),
            tables: [...c.querySelectorAll('table')].map(tableOf),
            chips: [...c.querySelectorAll('span')].filter((s) => has(s, 'rounded-sm', 'border')).map(txt),
          }
        }),
        tables: [...sec.querySelectorAll('table')].filter((t) => !inCard(t)).map(tableOf),
        chips: [...sec.querySelectorAll('span')].filter((s) => has(s, 'rounded-sm', 'border') && !inCard(s)).map(txt),
        tags,
        notes: notesOf(all.filter((e) => !inCard(e) && !cards.includes(e) && !e.closest('span.rounded-full'))),
        lines: linesOf(all.filter((e) => e.tagName === 'DIV' && !inCard(e) && !cards.includes(e))),
        pagers: [...sec.querySelectorAll('span')].map(txt).filter((s) => /^\d+-\d+ \/ \d+$/.test(s)),
        json: [...sec.querySelectorAll('pre')].map((p) => {
          try {
            return JSON.parse((p as HTMLElement).innerText)
          } catch {
            return (p as HTMLElement).innerText
          }
        }),
      }
    }
    return view as View
  }, OTHER_FEATURES)
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

// What a drawer must show, in Kubeast's words: an empty value is "-", booleans Yes/No
const dash = (v: unknown) => (v === undefined || v === null || v === '' ? '-' : String(v))
const at = (t?: string) => (t ? `@${t}` : '-')
const yesNo = (v: unknown) => (v ? 'Yes' : 'No')
const section = (s: Partial<Section> = {}): Section => ({ rows: {}, cards: [], tables: [], chips: [], tags: [], notes: [], lines: {}, pagers: [], json: [], ...s })
const card = (c: Partial<Card> = {}): Card => ({ lines: {}, notes: [], tables: [], chips: [], ...c })
const rowsOf = (rows: Record<string, string | undefined>) =>
  Object.fromEntries(Object.entries(rows).filter(([, v]) => v !== undefined).map(([k, v]) => [k, [v as string]]))
const tagsOf = (m: Record<string, string> | undefined) => Object.entries(m ?? {}).map(([k, v]) => `${k}=${v}`).sort()
// a section's "(n)", where the section is shown (it is not with no rows)
const countOf = (title: string, n: number): Record<string, number> => (n ? { [title]: n } : {})
// a page of 10 rows and its pager, as the drawers page their inner tables
const paged = <T>(items: T[]) => ({ page: items.slice(0, 10), pagers: items.length > 10 ? [`1-10 / ${items.length}`] : [] })
// an event's first and last time and count as kubectl's printEvent reads them (k8s-service eventtime.Seen)
function seen(e: Obj): { last: string; count: number } {
  const first = e.firstTimestamp ?? e.eventTime
  const last = e.series?.lastObservedTime ?? e.lastTimestamp ?? first
  return { last, count: e.series ? e.series.count : (e.count || 1) }
}
// the sections every one of these drawers ends with: labels and annotations where the object has them, and the events
// newest first — the Events section always, its "None" (a span, which a section here reads as nothing) without events
function closing(o: Obj, events: Obj[]): Record<string, Section> {
  const out: Record<string, Section> = {}
  if (Object.keys(o.metadata.labels ?? {}).length) out.Labels = section({ tags: tagsOf(o.metadata.labels) })
  if (Object.keys(o.metadata.annotations ?? {}).length) out.Annotations = section({ tags: tagsOf(o.metadata.annotations) })
  const rows = events.map((e) => ({ e, ...seen(e) })).sort((a, b) => Date.parse(b.last) - Date.parse(a.last))
    .map(({ e, last, count }) => [dash(e.type), dash(e.reason), dash(e.message), at(last), String(count)])
  const { page, pagers } = paged(rows)
  out.Events = rows.length ? section({ tables: [{ head: ['Type', 'Reason', 'Message', 'Last Seen', 'Count'], rows: page }], pagers }) : section()
  return out
}
// pods as kubectl get pods prints them (the API server's Table): STATUS, READY, RESTARTS without "(… ago)"
const podCells = (table: Record<string, Record<string, string>>, name: string) => {
  const r = table[name] ?? {}
  return { status: dash(r.Status), ready: dash(r.Ready), restarts: (r.Restarts ?? '').replace(/\s*\(.*\)$/, '') || '-' }
}

type Ctx = { o: Obj; events: Obj[]; get: (args: string) => Obj; podTable: Record<string, Record<string, string>> }
type Kind = { kind: string; plural: string; list: string; namespaced: boolean; names: (get: Ctx['get']) => string[]; want: (c: Ctx) => View }

// the claim's users as kubectl describe pvc lists them (getPodsForPVC): the pods with a volume of its name in the
// list's order, then its owner pod; each with the volumes it mounts the claim as
function claimUsers(claim: Obj, pods: Obj[]): { pod: Obj; mounts: string[] }[] {
  const byName = (p: Obj) => (p.spec.volumes ?? []).filter((v: Obj) => v.persistentVolumeClaim?.claimName === claim.metadata.name).map((v: Obj) => v.name)
  const owners = (claim.metadata.ownerReferences ?? []).filter((r: Obj) => r.kind === 'Pod').map((r: Obj) => r.uid)
  const ephemeral = (p: Obj) => (p.spec.volumes ?? []).filter((v: Obj) => v.ephemeral && `${p.metadata.name}-${v.name}` === claim.metadata.name).map((v: Obj) => v.name)
  return [
    ...pods.filter((p) => byName(p).length).map((p) => ({ pod: p, mounts: [...byName(p), ...(owners.includes(p.metadata.uid) ? ephemeral(p) : [])] })),
    ...pods.filter((p) => !byName(p).length && owners.includes(p.metadata.uid)).map((p) => ({ pod: p, mounts: ephemeral(p) })),
  ]
}
// a volume's source as the drawers write it: kind (detail)
function pvSource(pv: Obj): { source: string; driver: string } {
  const s = pv.spec
  if (s.csi) return { source: 'CSI', driver: s.csi.driver }
  if (s.nfs) return { source: 'NFS', driver: `${s.nfs.server}:${s.nfs.path}` }
  if (s.local) return { source: 'Local', driver: s.local.path }
  if (s.hostPath) return { source: 'HostPath', driver: s.hostPath.path }
  return { source: '', driver: '' }
}
// a claim's access modes as the claims list shows them: the volume's once bound, none before
const claimModes = (c: Obj) => (c.spec.volumeName ? (c.status.accessModes ?? []).join(', ') : '') || '-'

const KINDS: Kind[] = [
  {
    kind: 'Endpoints', plural: 'endpoints', list: '/network/endpoints', namespaced: true, names: () => ['nsd-web', 'nsd-hand'],
    want: ({ o, events }) => {
      const subsets: Obj[] = o.subsets ?? []
      const ready: Obj[] = subsets.flatMap((s) => s.addresses ?? [])
      const notReady: Obj[] = subsets.flatMap((s) => s.notReadyAddresses ?? [])
      const total = ready.length + notReady.length
      // the ports of every subset once (k8s-service formatEndpointsFull)
      const ports: Obj[] = []
      for (const p of subsets.flatMap((s) => s.ports ?? [])) {
        if (!ports.some((q) => (q.name ?? '') === (p.name ?? '') && q.port === p.port && q.protocol === p.protocol)) ports.push(p)
      }
      const target = (a: Obj) => card({ notes: [a.ip, a.targetRef?.name ? `${a.targetRef.kind || 'Target'}:${a.targetRef.name}` : 'targetRef: -', ...(a.nodeName ? [`node=${a.nodeName}`] : [])] })
      const ips = (list: Obj[] | undefined) => (list ?? []).map((a) => a.ip).join(', ') || 'None'
      const sections: Record<string, Section> = {
        'Endpoints Info': section({
          rows: rowsOf({
            Kind: 'Endpoints', Name: o.metadata.name, Namespace: NS, 'Ready Addresses': String(ready.length), 'Not Ready Addresses': String(notReady.length),
            'Ready Ratio': total ? `${Math.round((ready.length / total) * 100)}% (${ready.length}/${total})` : undefined,
            'Resource Version': o.metadata.resourceVersion, Created: at(o.metadata.creationTimestamp),
          }),
        }),
      }
      if (ports.length) sections.Ports = section({ tables: [{ head: ['Name', 'Port', 'Protocol'], rows: ports.map((p) => [p.name || '-', String(p.port), p.protocol || 'TCP']) }] })
      if (ready.length) sections['Ready Targets'] = section({ cards: ready.map(target) })
      if (notReady.length) sections['Not Ready Targets'] = section({ cards: notReady.map(target) })
      // each subset as kubectl describe lists it (a port without a name "-", as the list's Ports column writes it)
      if (subsets.length) {
        sections.Subsets = section({
          cards: subsets.map((s) => card({
            lines: {
              Addresses: ips(s.addresses), 'Not Ready Addresses': ips(s.notReadyAddresses),
              Ports: (s.ports ?? []).map((p: Obj) => `${p.name || '-'}:${p.port}/${p.protocol}`).join(', ') || 'None',
            },
          })),
        })
      }
      return { badges: {}, counts: {}, sections: { ...sections, ...closing(o, events) } }
    },
  },
  {
    kind: 'IngressClass', plural: 'ingressclasses', list: '/network/ingressclasses', namespaced: false, names: () => ['nsd-ic', 'nsd-ic-unused'],
    want: ({ o, events, get }) => {
      const name = o.metadata.name
      // the Ingresses of the class, every namespace, in the list's order
      const users: Obj[] = get('ingresses -A').items.filter((i: Obj) => (i.spec.ingressClassName ?? i.metadata.annotations?.['kubernetes.io/ingress.class']) === name)
      const p = o.spec.parameters
      const params = p ? [p.kind, p.apiGroup && `.${p.apiGroup}`, p.name && `/${p.name}`, p.scope && ` (${p.scope})`, p.namespace && ` ns=${p.namespace}`].filter(Boolean).join('') : '-'
      const { page, pagers } = paged(users)
      return {
        badges: {},
        counts: { 'Used By Ingresses': users.length },
        sections: {
          'IngressClass Info': section({
            rows: rowsOf({
              Name: name, Controller: o.spec.controller, Default: yesNo(o.metadata.annotations?.['ingressclass.kubernetes.io/is-default-class'] === 'true'),
              Parameters: params, Created: at(o.metadata.creationTimestamp),
            }),
          }),
          'Used By Ingresses': users.length
            ? section({ tables: [{ head: ['Namespace', 'Ingress', 'Age'], rows: page.map((i) => [i.metadata.namespace, i.metadata.name, at(i.metadata.creationTimestamp)]) }], pagers })
            : section({ notes: ['No Ingress in the cluster uses this IngressClass.'] }),
          ...((o.metadata.finalizers ?? []).length ? { Finalizers: section({ chips: o.metadata.finalizers }) } : {}),
          ...closing(o, events),
        },
      }
    },
  },
  {
    kind: 'ReplicaSet', plural: 'replicasets', list: '/workloads/replicasets', namespaced: true,
    names: (get) => [get(`replicasets -n ${NS} -l app=nsd-web`).items[0].metadata.name, 'nsd-owned'],
    want: ({ o, events, get, podTable }) => {
      const st = o.status
      const refs: Obj[] = o.metadata.ownerReferences ?? []
      // the list's Owner column: the controller reference, a Deployment by its name, another kind as kind/name
      const ref = refs.find((r) => r.controller) ?? refs[0]
      const owner = ref ? (ref.kind === 'Deployment' ? ref.name : `${ref.kind}/${ref.name}`) : undefined
      const pods: Obj[] = get(`pods -n ${NS}`).items.filter((p: Obj) => (p.metadata.ownerReferences ?? []).some((r: Obj) => r.uid === o.metadata.uid))
        .sort((a: Obj, b: Obj) => a.metadata.name.localeCompare(b.metadata.name))
      const { page, pagers } = paged(pods)
      const n = (v: unknown) => String(v ?? 0)
      const container = (c: Obj) => card({
        notes: [c.name],
        lines: {
          Image: c.image, Command: [...(c.command ?? []), ...(c.args ?? [])].join(' ') || '-', Env: String((c.env ?? []).length),
          ...(c.resources?.requests ? { Requests: Object.entries(c.resources.requests).map(([k, v]) => `${k}=${v}`).join(' ') } : {}),
          ...(c.resources?.limits ? { Limits: Object.entries(c.resources.limits).map(([k, v]) => `${k}=${v}`).join(' ') } : {}),
        },
        chips: [...Object.entries(c.resources?.requests ?? {}), ...Object.entries(c.resources?.limits ?? {})].map(([k, v]) => `${k}=${v}`),
      })
      return {
        badges: { Desired: n(o.spec.replicas), Ready: n(st.readyReplicas), Available: n(st.availableReplicas) },
        counts: countOf('Pods', pods.length),
        sections: {
          Replicas: section({ rows: rowsOf({ Desired: n(o.spec.replicas), Current: n(st.replicas), Ready: n(st.readyReplicas), Available: n(st.availableReplicas) }) }),
          'Basic Info': section({
            rows: rowsOf({
              Kind: 'ReplicaSet', Name: o.metadata.name, Namespace: NS, Created: at(o.metadata.creationTimestamp), UID: o.metadata.uid,
              'Resource Version': o.metadata.resourceVersion, Generation: String(o.metadata.generation),
            }),
          }),
          'Workload Settings': section({
            rows: rowsOf({
              Owner: owner, Revision: o.metadata.annotations?.['deployment.kubernetes.io/revision'],
              'Min Ready Seconds': o.spec.minReadySeconds ? String(o.spec.minReadySeconds) : undefined, 'Fully Labeled Replicas': n(st.fullyLabeledReplicas),
            }),
          }),
          ...(pods.length ? {
            Pods: section({
              tables: [{
                head: ['Name', 'Status', 'Ready', 'Restarts', 'Node'],
                rows: page.map((p) => {
                  const c = podCells(podTable, p.metadata.name)
                  return [p.metadata.name, c.status, c.ready, c.restarts, dash(p.spec.nodeName)]
                }),
              }],
              pagers,
            }),
          } : {}),
          Selector: section({ tags: tagsOf(o.spec.selector.matchLabels) }),
          Containers: section({ cards: o.spec.template.spec.containers.map(container) }),
          ...((st.conditions ?? []).length ? {
            Conditions: section({ tables: [{ head: ['Type', 'Status', 'Reason', 'Message', 'Last Transition'], rows: st.conditions.map((c: Obj) => [c.type, c.status, dash(c.reason), dash(c.message), at(c.lastTransitionTime)]) }] }),
          } : {}),
          ...closing(o, events),
        },
      }
    },
  },
  {
    kind: 'PersistentVolume', plural: 'persistentvolumes', list: '/storage?tab=pvs', namespaced: false,
    names: (get) => ['nsd-pv-nfs', 'nsd-pv-csi', ...['nsd-claim', 'nsd-eph-scratch'].map((c) => get(`pvc ${c} -n ${NS}`).spec.volumeName)],
    want: ({ o, events, get, podTable }) => {
      const s = o.spec
      const { source, driver } = pvSource(o)
      const ref = s.claimRef
      const claim: Obj | null = ref ? get(`pvc ${ref.name} -n ${ref.namespace}`) : null
      const users = claim ? claimUsers(claim, get(`pods -n ${ref.namespace}`).items) : []
      // spec.nodeAffinity as kubectl describe pv prints it, a term a line
      const terms: Obj[] = s.nodeAffinity?.required?.nodeSelectorTerms ?? []
      const affinity = terms.map((t, i) => `Term ${i}: ${[...(t.matchExpressions ?? []), ...(t.matchFields ?? [])].map((r: Obj) => `${r.key} ${String(r.operator).toLowerCase()}${r.values?.length ? ` [${r.values.join(', ')}]` : ''}`).join(', ')}`).join(' ')
      const out: Record<string, Section> = {
        'PersistentVolume Info': section({
          rows: rowsOf({
            Name: o.metadata.name, Status: o.status.phase, Capacity: s.capacity.storage, 'Access Modes': s.accessModes.join(', '),
            'Reclaim Policy': s.persistentVolumeReclaimPolicy, 'Storage Class': dash(s.storageClassName), 'Volume Mode': s.volumeMode ?? 'Filesystem',
            Claim: ref ? ref.name : '-', Source: source ? `${source}${driver ? ` (${driver})` : ''}` : '-',
            'Volume Handle': dash(s.csi?.volumeHandle), 'Node Affinity': affinity || '-', UID: o.metadata.uid, 'Resource Version': o.metadata.resourceVersion,
            Created: at(o.metadata.creationTimestamp), 'Last Phase Transition': o.status.lastPhaseTransitionTime ? at(o.status.lastPhaseTransitionTime) : undefined,
            'Failure Reason': o.status.reason || undefined, 'Failure Message': o.status.message || undefined,
          }),
        }),
      }
      if (Object.keys(s.csi?.volumeAttributes ?? {}).length) out['Volume Attributes'] = section({ tags: tagsOf(s.csi.volumeAttributes) })
      if (claim) {
        out['Bound PersistentVolumeClaim'] = section({
          rows: rowsOf({
            Name: `${claim.metadata.namespace}/${claim.metadata.name}`, Status: claim.status.phase, Requested: claim.spec.resources.requests.storage,
            Capacity: dash(claim.status.capacity?.storage), 'Storage Class': dash(claim.spec.storageClassName), 'Volume Mode': claim.spec.volumeMode ?? '-',
            'Access Modes': claimModes(claim),
          }),
        })
      }
      if (users.length) {
        const { page, pagers } = paged(users)
        out['Used By Pods'] = section({
          tables: [{
            head: ['Pod', 'Status', 'Ready', 'Restarts', 'Node', 'Mounted As', 'Age'],
            rows: page.map(({ pod, mounts }) => {
              const c = podCells(podTable, pod.metadata.name)
              return [pod.metadata.name, c.status, c.ready, c.restarts, dash(pod.spec.nodeName), mounts.join(', ') || '-', at(pod.metadata.creationTimestamp)]
            }),
          }],
          pagers,
        })
      }
      if ((o.metadata.finalizers ?? []).length) out.Finalizers = section({ notes: o.metadata.finalizers })
      return { badges: {}, counts: countOf('Used By Pods', users.length), sections: { ...out, ...closing(o, events) } }
    },
  },
  {
    kind: 'StorageClass', plural: 'storageclasses', list: '/storage?tab=storageclasses', namespaced: false, names: () => ['nsd-sc-topo'],
    want: ({ o, events, get }) => {
      const name = o.metadata.name
      const pvs: Obj[] = get('pv').items.filter((v: Obj) => v.spec.storageClassName === name)
      const pvcs: Obj[] = get('pvc -A').items.filter((c: Obj) => c.spec.storageClassName === name)
      const bound = (list: Obj[]) => list.filter((x) => x.status.phase === 'Bound').length
      const ann = o.metadata.annotations ?? {}
      const pvPage = paged(pvs)
      const pvcPage = paged(pvcs)
      const out: Record<string, Section> = {
        'StorageClass Info': section({
          rows: rowsOf({
            Name: name, Provisioner: o.provisioner,
            'Default Class': yesNo(ann['storageclass.kubernetes.io/is-default-class'] === 'true' || ann['storageclass.beta.kubernetes.io/is-default-class'] === 'true'),
            'Reclaim Policy': o.reclaimPolicy, 'Volume Binding Mode': o.volumeBindingMode, 'Allow Expansion': yesNo(o.allowVolumeExpansion),
            'Bound PVs / Total PVs': pvs.length ? `${bound(pvs)}/${pvs.length}` : '-', 'Bound PVCs / Total PVCs': pvcs.length ? `${bound(pvcs)}/${pvcs.length}` : '-',
            'Provisioning Success Rate': pvs.length ? `${Math.round((bound(pvs) / pvs.length) * 100)}%` : undefined,
            UID: o.metadata.uid, 'Resource Version': o.metadata.resourceVersion, Created: at(o.metadata.creationTimestamp),
          }),
        }),
      }
      if (Object.keys(o.parameters ?? {}).length) out.Parameters = section({ tags: tagsOf(o.parameters) })
      if ((o.mountOptions ?? []).length) out['Mount Options'] = section({ tags: [...o.mountOptions].sort() })
      // kubectl describe's AllowedTopologies, a term a line
      if ((o.allowedTopologies ?? []).length) {
        out['Allowed Topologies'] = section({
          notes: o.allowedTopologies.map((t: Obj, i: number) => `Term ${i}: ${(t.matchLabelExpressions ?? []).map((e: Obj) => `${e.key} in${e.values?.length ? ` [${e.values.join(', ')}]` : ''}`).join(', ') || '-'}`),
        })
      }
      if (pvs.length) {
        out['Related PersistentVolumes'] = section({
          tables: [{
            head: ['Name', 'Status', 'Capacity', 'Claim', 'Age'],
            rows: pvPage.page.map((v) => [v.metadata.name, v.status.phase, dash(v.spec.capacity?.storage), v.spec.claimRef ? `${v.spec.claimRef.namespace || '-'}/${v.spec.claimRef.name}` : '-', at(v.metadata.creationTimestamp)]),
          }],
          pagers: pvPage.pagers,
        })
      }
      if (pvcs.length) {
        out['Related PersistentVolumeClaims'] = section({
          tables: [{
            head: ['PVC', 'Status', 'Requested', 'Capacity', 'Volume', 'Age'],
            rows: pvcPage.page.map((c) => [`${c.metadata.namespace}/${c.metadata.name}`, c.status.phase, dash(c.spec.resources.requests?.storage), dash(c.status.capacity?.storage), dash(c.spec.volumeName), at(c.metadata.creationTimestamp)]),
          }],
          pagers: pvcPage.pagers,
        })
      }
      if ((o.metadata.finalizers ?? []).length) out.Finalizers = section({ notes: o.metadata.finalizers })
      return {
        badges: {},
        counts: { ...(pvs.length ? { 'Related PersistentVolumes': pvs.length } : {}), ...(pvcs.length ? { 'Related PersistentVolumeClaims': pvcs.length } : {}) },
        sections: { ...out, ...closing(o, events) },
      }
    },
  },
  {
    kind: 'VolumeAttachment', plural: 'volumeattachments', list: '/storage?tab=volumeattachments', namespaced: false, names: () => ['nsd-va', 'nsd-va-inline'],
    want: ({ o, events, get, podTable }) => {
      const st = o.status ?? {}
      const pvName: string | undefined = o.spec.source.persistentVolumeName
      const pv: Obj | null = pvName ? get(`pv ${pvName}`) : null
      const claim: Obj | null = pv?.spec.claimRef ? get(`pvc ${pv.spec.claimRef.name} -n ${pv.spec.claimRef.namespace}`) : null
      const users = claim ? claimUsers(claim, get(`pods -n ${claim.metadata.namespace}`).items) : []
      // Status as the list's column says it (an attach or detach error first), kubectl's ATTACHED beside it
      const status = st.attachError?.message || st.detachError?.message ? 'Error' : st.attached ? 'Attached' : 'Detached'
      const out: Record<string, Section> = {
        'VolumeAttachment Info': section({
          rows: rowsOf({
            Name: o.metadata.name, Status: status, Attached: yesNo(st.attached), Attacher: o.spec.attacher, Node: o.spec.nodeName,
            PersistentVolume: dash(pvName), UID: o.metadata.uid, 'Resource Version': o.metadata.resourceVersion, Created: at(o.metadata.creationTimestamp),
          }),
        }),
      }
      const errors = [['Attach Error', st.attachError], ['Detach Error', st.detachError]].filter(([, e]) => e?.message)
      if (errors.length) out['Attach/Detach Errors'] = section({ cards: errors.map(([label, e]) => card({ notes: [label, e.message, at(e.time)] })) })
      if (Object.keys(st.attachmentMetadata ?? {}).length) out['Attachment Metadata'] = section({ tags: tagsOf(st.attachmentMetadata) })
      if (pv) {
        const { source, driver } = pvSource(pv)
        out['Bound PersistentVolume Summary'] = section({
          rows: rowsOf({
            Name: pv.metadata.name, Status: pv.status.phase, Capacity: dash(pv.spec.capacity?.storage), 'Access Modes': pv.spec.accessModes.join(', '),
            'Storage Class': dash(pv.spec.storageClassName), 'Reclaim Policy': pv.spec.persistentVolumeReclaimPolicy, 'Volume Mode': dash(pv.spec.volumeMode),
            Source: dash(source), Driver: dash(driver), 'Volume Handle': dash(pv.spec.csi?.volumeHandle),
          }),
        })
      }
      if (claim) {
        const { page, pagers } = paged(users)
        out['Bound Chain — PV → PVC → Pods'] = section({
          rows: rowsOf({ PVC: `${claim.metadata.namespace}/${claim.metadata.name}` }),
          ...(users.length
            ? { tables: [{ head: ['Pod', 'Status', 'Node'], rows: page.map(({ pod }) => [pod.metadata.name, podCells(podTable, pod.metadata.name).status, dash(pod.spec.nodeName)]) }], pagers }
            : { notes: ['No pod currently mounts this PVC.'] }),
        })
      }
      if (o.spec.source.inlineVolumeSpec) out['Inline Volume Spec'] = section({ json: [o.spec.source.inlineVolumeSpec] })
      if ((o.metadata.finalizers ?? []).length) out.Finalizers = section({ notes: o.metadata.finalizers })
      return { badges: {}, counts: claim ? { 'Bound Chain — PV → PVC → Pods': users.length } as Record<string, number> : {}, sections: { ...out, ...closing(o, events) } }
    },
  },
]

// events about the objects as a controller records them, uid set as kubectl describe pairs them: an Endpoints'
// Warning seen three times and a Normal one, one about a Service of the Endpoints' name (its drawer leaves it out),
// the cluster-scoped kinds' in namespace default. [kind, apiVersion, name, reason, type, count, last and first seen,
// seconds ago]
const EVENTS: [string, string, string, string, string, number, number, number][] = [
  ['Endpoints', 'v1', 'nsd-hand', 'NumbersStale', 'Warning', 3, 120, 600],
  ['Endpoints', 'v1', 'nsd-hand', 'NumbersMirrored', 'Normal', 1, 300, 300],
  ['Service', 'v1', 'nsd-hand', 'NumbersElsewhere', 'Normal', 1, 30, 30],
  ['IngressClass', 'networking.k8s.io/v1', 'nsd-ic', 'NumbersAccepted', 'Normal', 1, 150, 150],
  ['PersistentVolume', 'v1', 'nsd-pv-nfs', 'NumbersMountFailed', 'Warning', 2, 90, 400],
  ['StorageClass', 'storage.k8s.io/v1', 'nsd-sc-topo', 'NumbersProvisioning', 'Normal', 1, 200, 200],
  ['VolumeAttachment', 'storage.k8s.io/v1', 'nsd-va', 'NumbersAttachFailed', 'Warning', 4, 60, 900],
]
const CLUSTER_SCOPED = new Set(['IngressClass', 'PersistentVolume', 'StorageClass', 'VolumeAttachment'])
const eventNs = (kind: string) => (CLUSTER_SCOPED.has(kind) ? 'default' : NS)
const eventName = (name: string, reason: string) => `${name}.${reason.toLowerCase()}`
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString().replace(/\.\d+Z$/, 'Z')
// the 10 volumes of nsd-sc-topo beside the fixture's two, so its drawer pages them
const MORE_PVS = Array.from({ length: 10 }, (_, i) => `nsd-pv-${String(i + 1).padStart(2, '0')}`)

test.describe('number check — network and storage drawers', () => {
  test('every Endpoints, IngressClass, ReplicaSet, PV, StorageClass and VolumeAttachment drawer shows the cluster, opened from its list and by link', async ({ page }) => {
    test.setTimeout(900_000)
    const get = (args: string): Obj => JSON.parse(kubectl(`get ${args} -o json`))
    // gone, not terminating, before and after
    const cleanup = () => {
      kubectl('delete volumeattachment nsd-va nsd-va-inline --ignore-not-found --wait=true')
      kubectl(`delete namespace ${NS} --wait=true --timeout=180s --ignore-not-found`)
      kubectl('delete ingressclass nsd-ic nsd-ic-unused --ignore-not-found --wait=true')
      kubectl(`delete pv nsd-pv-nfs nsd-pv-csi ${MORE_PVS.join(' ')} --ignore-not-found --wait=true`)
      kubectl('delete storageclass nsd-sc-topo --ignore-not-found --wait=true')
      kubectl(`delete event -n default ${EVENTS.filter(([kind]) => CLUSTER_SCOPED.has(kind)).map(([, , name, reason]) => eventName(name, reason)).join(' ')} --ignore-not-found`)
    }
    // the volumes local-path made for the namespace's claims go once their claims are gone
    const volumesGone = async () => {
      const deadline = Date.now() + 90_000
      while (get('pv').items.some((v: Obj) => v.spec.claimRef?.namespace === NS)) {
        if (Date.now() > deadline) throw new Error(`volumes of ${NS} are still there`)
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
    cleanup()
    await volumesGone()
    try {
      kubectl('apply --server-side --field-manager=e2e-netstore -f -', FIXTURE)
      // a ConfigMap that controls a ReplicaSet (the owner needs the object's uid)
      kubectl('create -f -', JSON.stringify({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'nsd-owner', namespace: NS }, data: { a: 'b' } }))
      const ownerUid = get(`configmap nsd-owner -n ${NS}`).metadata.uid
      const busybox = { name: 'app', image: 'busybox:1.37', imagePullPolicy: 'IfNotPresent', command: ['sleep', '86400'] }
      const backend = { service: { name: 'nsd-web', port: { number: 80 } } }
      const more = [
        {
          apiVersion: 'apps/v1', kind: 'ReplicaSet',
          metadata: { name: 'nsd-owned', namespace: NS, ownerReferences: [{ apiVersion: 'v1', kind: 'ConfigMap', name: 'nsd-owner', uid: ownerUid, controller: true }] },
          spec: { replicas: 1, selector: { matchLabels: { app: 'nsd-owned' } }, template: { metadata: { labels: { app: 'nsd-owned' } }, spec: { terminationGracePeriodSeconds: 0, containers: [busybox] } } },
        },
        // 11 Ingresses of nsd-ic by spec.ingressClassName and one by the old annotation: its drawer pages the 12
        ...Array.from({ length: 11 }, (_, i) => ({
          apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: `nsd-ing-${String(i + 1).padStart(2, '0')}`, namespace: NS },
          spec: { ingressClassName: 'nsd-ic', defaultBackend: backend },
        })),
        { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'nsd-ing-ann', namespace: NS, annotations: { 'kubernetes.io/ingress.class': 'nsd-ic' } }, spec: { defaultBackend: backend } },
        ...MORE_PVS.map((name) => ({
          apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name },
          spec: { capacity: { storage: '1Mi' }, accessModes: ['ReadWriteOnce'], persistentVolumeReclaimPolicy: 'Retain', storageClassName: 'nsd-sc-topo', nfs: { server: 'numbers.invalid', path: `/${name}` } },
        })),
      ]
      kubectl('create -f -', JSON.stringify({ apiVersion: 'v1', kind: 'List', items: more }))

      // settled: the Endpoints controller has the ready and the never-ready pods, the claims are bound, the sidecar
      // pod is ready, the other one waits on its init container
      const deadline = Date.now() + 150_000
      for (;;) {
        const pods: Obj[] = get(`pods -n ${NS}`).items
        const pod = (name: string) => pods.find((p) => p.metadata.name === name)
        const ep = get(`endpoints nsd-web -n ${NS}`)
        const bound = (c: string) => get(`pvc ${c} -n ${NS}`).status.phase === 'Bound'
        const settled =
          (ep.subsets ?? []).flatMap((s: Obj) => s.addresses ?? []).length === 2 &&
          (ep.subsets ?? []).flatMap((s: Obj) => s.notReadyAddresses ?? []).length === 1 &&
          [...(pod('nsd-user')?.status.containerStatuses ?? []), ...(pod('nsd-user')?.status.initContainerStatuses ?? [])].filter((c: Obj) => c.ready).length === 2 &&
          !!pod('nsd-wait')?.status.initContainerStatuses?.[0]?.state?.running &&
          pod('nsd-eph')?.status.phase === 'Running' &&
          get(`rs nsd-owned -n ${NS}`).status.readyReplicas === 1 &&
          bound('nsd-claim') && bound('nsd-eph-scratch')
        if (settled) break
        if (Date.now() > deadline) throw new Error('fixture did not settle')
        await new Promise((r) => setTimeout(r, 2000))
      }

      // an attachment of nsd-claim's volume, with the errors and metadata an attacher would write
      const claimVolume = get(`pvc nsd-claim -n ${NS}`).spec.volumeName
      kubectl('create -f -', JSON.stringify({
        apiVersion: 'storage.k8s.io/v1', kind: 'VolumeAttachment', metadata: { name: 'nsd-va' },
        spec: { attacher: 'numbers.kubeast.io', nodeName: NODE, source: { persistentVolumeName: claimVolume } },
      }))
      kubectl(`patch volumeattachment nsd-va --subresource=status --type=merge -p=${arg({
        status: {
          attached: true, attachmentMetadata: { devicePath: '/dev/numbers' },
          attachError: { time: ago(300), message: 'numbers: attach timed out' }, detachError: { time: ago(120), message: 'numbers: detach refused' },
        },
      })}`)

      const plural = (kind: string) => KINDS.find((x) => x.kind === kind)?.plural ?? `${kind.toLowerCase()}s`
      const items = EVENTS.map(([kind, apiVersion, name, reason, type, count, last, first]) => {
        let uid: string | undefined
        try {
          uid = get(`${plural(kind)} ${name}${CLUSTER_SCOPED.has(kind) ? '' : ` -n ${NS}`}`).metadata.uid
        } catch {
          uid = undefined
        }
        return {
          apiVersion: 'v1', kind: 'Event',
          metadata: { name: eventName(name, reason), namespace: eventNs(kind) },
          involvedObject: { apiVersion, kind, name, ...(CLUSTER_SCOPED.has(kind) ? {} : { namespace: NS }), ...(uid ? { uid } : {}) },
          reason, message: `${reason} by the number check`, type, count, firstTimestamp: ago(first), lastTimestamp: ago(last),
          source: { component: 'e2e-netstore' },
        }
      })
      kubectl('create -f -', JSON.stringify({ apiVersion: 'v1', kind: 'List', items }))

      // the object, the events kubectl describe lists about it (its name, kind and uid) and what kubectl prints of the
      // namespace's pods
      const clusterOf = async (x: Kind, name: string): Promise<Ctx> => {
        const o = get(`${x.plural} ${name}${x.namespaced ? ` -n ${NS}` : ''}`)
        const events = get(`events ${x.namespaced ? `-n ${NS}` : '-A'} --field-selector involvedObject.name=${name},involvedObject.kind=${x.kind}`).items
          .filter((e: Obj) => e.involvedObject.uid === o.metadata.uid)
        return { o, events, get, podTable: await apiTable(`/api/v1/namespaces/${NS}/pods`) }
      }
      const open = async (x: Kind, name: string, way: string) => {
        if (way === 'link') {
          await page.goto(`/?cluster=${CLUSTER}&detail=${encodeURIComponent(x.namespaced ? `${x.kind}/${NS}/${name}` : `${x.kind}/${name}`)}`)
        } else {
          await page.goto(`${x.list}${x.list.includes('?') ? '&' : '?'}cluster=${CLUSTER}${x.namespaced ? `&namespace=${NS}` : ''}`)
          // the row's name cell (the names here have no regular expression characters)
          const exact = { hasText: new RegExp(`^\\s*${name}\\s*$`) }
          await page.locator('main tbody tr').filter({ has: page.locator('td', exact) }).first().locator('td', exact).click({ timeout: 20_000 })
        }
        await page.locator(DRAWER).last().waitFor({ timeout: 20_000 })
      }

      await page.context().addInitScript(() => localStorage.setItem('kubeast.listPageSize', '100'))
      for (const x of KINDS) {
        for (const name of x.names(get)) {
          for (const way of ['list', 'link']) {
            await test.step(`${x.kind}/${name} · ${way}`, async () => {
              await open(x, name, way)
              const shown = async (want: View) => settle(await readDrawer(page), want)
              // the drawer shows the object as it was when it opened: what the cluster had then, else what it has
              // after (an object a controller wrote meanwhile)
              const before = x.want(await clusterOf(x, name))
              try {
                await expect.poll(() => shown(before), { timeout: 20_000 }).toEqual(before)
              } catch {
                const after = x.want(await clusterOf(x, name))
                expect.soft(await shown(after), `${x.kind}/${name} opened by ${way}`).toEqual(after)
              }
            })
          }
        }
      }
    } finally {
      cleanup()
      await volumesGone()
    }
  })
})
