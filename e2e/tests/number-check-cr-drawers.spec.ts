import { execSync } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

import { arg } from './number-check.gateway-shared'
import { CR_CRD, GWPOL_CRD, VPA17_MISSING, crInstances, numbersPolicies, vpa17, vpaFixture, vpaPrintsWideColumns, writeNumbersPolicyStatus, writeVpaStatus, writeWidgetStatus } from './number-check.cr-shared'

// The VPA, CustomResourceDefinition and custom resource drawers, the drawer of a kind Kubeast has no view for, and the
// policy violations of a drawer opened from Policy Reports show what the cluster has: on test2, in a namespace of its
// own, number-check.vpa-fixture.yaml with its statuses and target workloads, number-check.cr-crd.yaml's Widget with
// number-check.cr-instances.yaml and more instances, a Widget of a third group with fields beside spec and status,
// number-check.gwpol-crd.yaml's policies and a VerticalPodAutoscalerCheckpoint with many annotations, and events about
// them and the CRDs; on default, number-check.polr-fixture.yaml and the pod it names. Each drawer — opened from its list
// (a custom resource also from Gateway → Policies, Advanced Search and the Timeline, which pass its apiVersion; the pod
// from Policy Reports) and by link — is read whole and compared with the object, what kubectl prints of it (the API
// server's Table of the CRD's columns) and the events kubectl describe lists, so a number on it that nothing here
// expects fails too; the pod's drawer is held to the reports in its policy violations only (the rest of a Pod drawer
// is number-check-drawers.spec.ts's), a PolicyReport's drawer to its fields beside spec and status.

const NS = 'e2e-cr-drawers'
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'
// the screen's words as the English catalog has them, else the code's own
const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/en.json'), 'utf8'))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const say = (key: string, fallback: string): string => key.split('.').reduce((o: any, k) => o?.[k], EN) ?? fallback

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any
type TableJSON = { columnDefinitions: { name: string; type: string; format?: string }[]; rows: { cells: unknown[]; object: { metadata: { name: string; namespace?: string } } }[] }
type Kube = { kubectl: (args: string, input?: string) => string; table: (apiPath: string) => Promise<TableJSON> }

// a kind cluster's kubectl and the API server's Table — what `kubectl get` prints; null without it
function kube(kindName: string): Kube | null {
  let kc: string
  try {
    kc = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  } catch {
    return null
  }
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-cr-drawers-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kc, { mode: 0o600 })
  const pick = (k: string) => (kc.match(new RegExp(`${k}: (\\S+)`)) ?? [])[1] ?? ''
  const server = new URL(pick('server'))
  return {
    kubectl: (args, input) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }).trim(),
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
        r.on('end', () => (r.statusCode === 200 ? resolve(JSON.parse(s)) : reject(new Error(`${apiPath}: ${r.statusCode} ${s.slice(0, 200)}`))))
      }).on('error', reject).end()
    }),
  }
}

// A drawer as read: the summary badges, the "(n)" of section titles, and per section its rows ("label" → value), its
// cards (their words but tables, and their tables), tables, notes, label/annotation tags and every other word left —
// each word on the drawer lands in one of them. Words are the drawer's visible text, one space between elements.
type TableView = { head: string[]; rows: string[][] }
type Card = { text: string; tables: TableView[] }
type Section = { rows: Record<string, string>; cards: Card[]; tables: TableView[]; notes: string[]; tags: string[]; rest: string }
type View = { badges: Record<string, string>; counts: Record<string, number>; sections: Record<string, Section> }

async function readDrawer(page: Page): Promise<View> {
  return page.locator(DRAWER).last().evaluate((root) => {
    // text nodes side by side (React splits "{a}-{b}" in three) read as one word run; elements apart by one space
    const words = (el: Element, skip: (e: Element) => boolean = () => false) => {
      const out: string[] = []
      let prev: Node | null = null
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const p = n.parentElement
        if (!p || !p.checkVisibility() || skip(p)) continue
        if (prev && n.previousSibling === prev) out[out.length - 1] += n.textContent ?? ''
        else out.push(n.textContent ?? '')
        prev = n
      }
      return out.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ')
    }
    const has = (el: Element, ...names: string[]) => names.every((n) => el.classList.contains(n))
    const tableOf = (tb: Element): TableView => ({
      head: [...tb.querySelectorAll('thead th')].map((th) => words(th)),
      rows: [...tb.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => words(td))),
    })
    const view: View = { badges: {}, counts: {}, sections: {} }
    for (const b of root.querySelectorAll('span.rounded-full.border')) {
      const m = has(b, 'py-0.5') ? /^([^:]+): (.*)$/.exec((b as HTMLElement).innerText.replace(/\s+/g, ' ').trim()) : null
      if (m) view.badges[m[1]] = m[2]
    }
    for (const sec of root.querySelectorAll('div.rounded-lg.border')) {
      const title = sec.firstElementChild?.firstElementChild
      if (!title || title.tagName !== 'P') continue
      const m = /^(.*) \((\d+)\)$/.exec(words(title))
      const name = m ? m[1] : words(title)
      if (m) view.counts[name] = Number(m[2])
      const inside = (els: Element[]) => (el: Element) => els.some((x) => x !== el && x.contains(el))
      const grids = [...sec.querySelectorAll('div.grid')].filter((g) => g.children.length === 2 && [...g.children].every((c) => c.tagName === 'SPAN') && has(g.children[0], 'text-slate-400'))
      const inGrid = inside(grids)
      const allCards = [...sec.querySelectorAll('div')].filter((d) => has(d, 'rounded-sm', 'border') && !inGrid(d))
      const cards = allCards.filter((d) => !inside(allCards)(d))
      const inCard = inside(cards)
      const tables = [...sec.querySelectorAll('table')].filter((t) => !inGrid(t) && !inCard(t))
      const notes = [...sec.querySelectorAll('p')].filter((p) => p !== title && !inGrid(p) && !inCard(p))
      const tags = [...sec.querySelectorAll('span.rounded-full.border')].filter((s) => has(s, 'py-1') && !inGrid(s) && !inCard(s))
      const taken = [title, ...grids, ...cards, ...tables, ...notes, ...tags]
      view.sections[name] = {
        rows: Object.fromEntries(grids.map((g) => [words(g.children[0]), words(g.children[1])])),
        cards: cards.map((c) => {
          const inner = [...c.querySelectorAll('table')]
          return { text: words(c, (e) => inner.some((t) => t.contains(e))), tables: inner.map(tableOf) }
        }),
        tables: tables.map(tableOf),
        notes: notes.map((p) => words(p)),
        tags: tags.map((s) => `${words(s.children[0])}: ${words(s.children[2])}`),
        rest: words(sec, (e) => taken.some((x) => x.contains(e))),
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
  return /^(\d+[ydhms])+$/.test(s) ? total : NaN
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

// What the drawer must show, in Kubeast's words: an empty value is "-", a time before 1980 (a CRD's default) none
const dash = (v: unknown) => (v === undefined || v === null || v === '' ? '-' : String(v))
const at = (t?: string) => (t && new Date(t).getUTCFullYear() >= 1980 ? `@${t}` : '-')
const NONE = say('common.none', 'None')
const section = (s: Partial<Section> = {}): Section => ({ rows: {}, cards: [], tables: [], notes: [], tags: [], rest: '', ...s })
const conditionsTable = (conds: Obj[]): TableView => ({
  head: ['Type', 'Status', 'Reason', 'Message', 'Last Transition'],
  rows: conds.map((c) => [dash(c.type), dash(c.status), dash(c.reason), dash(c.message), at(c.lastTransitionTime)]),
})
const conditionsSection = (conds: Obj[]) => (conds.length ? section({ tables: [conditionsTable(conds)] }) : section({ rest: NONE }))
// newest first, as kubectl's printEvent dates them
const eventsSection = (events: Obj[]) => (events.length
  ? section({ tables: [{ head: ['Type', 'Reason', 'Message', 'Last Seen', 'Count'], rows: events.slice(0, 50).map((e) => [dash(e.type), dash(e.reason), dash(e.message), at(e.lastTimestamp ?? e.firstTimestamp), String(e.count ?? 1)]) }] })
  : section({ rest: NONE }))
// a map in the order the server writes it (Go: by key)
const byKey = (m: Record<string, unknown> = {}) => Object.keys(m).sort().map((k) => [k, m[k]] as const)
const tags = (m?: Record<string, string>) => byKey(m).map(([k, v]) => `${k}: ${v}`)
const tagsSection = (m?: Record<string, string>) => (Object.keys(m ?? {}).length ? section({ tags: tags(m) }) : section({ rest: NONE }))
const sorted = (v: unknown): unknown => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(byKey(v as Record<string, unknown>).map(([k, x]) => [k, sorted(x)])) : v)

// A custom resource's spec or status value as the drawer writes it: scalars as written, a time as a time, a list of
// words as chips, a short list of objects and a small object as their lines, anything bigger or deeper folded to a
// "(n keys)" header and the first lines of its JSON
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
function folded(label: string, data: object): string {
  const json = JSON.stringify(data, null, 2)
  const lines = json.split('\n')
  const preview = lines.length > 3 ? `${lines.slice(0, 3).join('\n')}\n  ...` : json
  return [label, `(${Object.keys(data).length} keys)`, '▶', 'expand', preview.replace(/\s+/g, ' ').trim()].join(' ')
}
function shown(v: unknown, depth = 0): string {
  if (v === null || v === undefined) return '-'
  if (typeof v === 'boolean' || typeof v === 'number') return String(v)
  if (typeof v === 'string') {
    if (!RFC3339.test(v) || new Date(v).getUTCFullYear() < 1980) return v
    if (depth > 0) throw new Error(`a time inside a ${depth}-deep value cannot be compared: ${v}`)
    return `@${v}`
  }
  if (Array.isArray(v)) {
    if (!v.length) return '[]'
    if (v.every((x) => typeof x === 'string' || typeof x === 'number')) return v.map(String).join(' ')
    if (v.length > 5) return folded(`Array[${v.length}]`, v)
    return v.map((x) => shown(x, depth + 1)).join(' ')
  }
  const entries = Object.entries(v as Record<string, unknown>)
  if (!entries.length) return '{}'
  if (entries.length > 6 || depth >= 2) return folded('Object', v as object)
  return entries.map(([k, x]) => [`${k}:`, shown(x, depth + 1)].filter(Boolean).join(' ')).join(' ')
}
// a printer column's cell as the list and the drawer write it (pages/custom-resources/printerCells.ts); a date column,
// which the API server gives as an age, is the time it counts from
function cellText(column: { name: string; type: string; jsonPath?: string }, value: unknown, o: Obj): string {
  if (value === undefined || value === null || value === '') return '-'
  if (column.type === 'date') return at(String((column.jsonPath ?? '').split('.').filter(Boolean).reduce((x: Obj, k) => x?.[k], o) ?? ''))
  if (typeof value === 'boolean') return value ? say('common.yes', 'Yes') : say('common.no', 'No')
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}
// a list's first page under its pager (usePagination: shown above ten rows)
const pager = (n: number) => (n > 10 ? `1-10 / ${n} ${say('detail.Prev', 'Prev')} ${say('detail.Next', 'Next')}` : '')

type CR = { o: Obj; crd: Obj; cells: unknown[]; columns: { name: string; type: string; format?: string }[]; events: Obj[]; peers: Obj[] }
// what a custom resource keeps beside apiVersion, kind, metadata, spec and status (a PolicyReport's results, scope,
// summary), each field a row as the spec's are — kubectl describe prints them all
const OTHER_FIELDS = say('crInstanceInfo.otherFields', 'Other Fields')
function otherFieldsWant(o: Obj): Record<string, Section> {
  const rest = sorted(Object.fromEntries(Object.entries(o).filter(([k]) => !['apiVersion', 'kind', 'metadata', 'spec', 'status'].includes(k)))) as Record<string, unknown>
  return Object.keys(rest).length ? { [OTHER_FIELDS]: section({ rows: Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, shown(v)])) }) } : {}
}
// a custom resource's drawer: its row of the instances list (the API server's Table at the version it is read at, the
// name column — format "name" — and Age left out, a CRD column also called Name kept), spec, status, the other fields,
// conditions, metadata, events and the other instances of its CRD
function customResourceWant(c: CR): View {
  const { o, crd } = c
  const m = o.metadata
  const version = o.apiVersion.split('/')[1]
  const printer = (crd.spec.versions.find((v: Obj) => v.name === version)?.additionalPrinterColumns ?? []) as { name: string; type: string; jsonPath: string }[]
  const cells = c.columns.map((col, i) => ({ col, value: c.cells[i] })).filter(({ col }) => col.format !== 'name' && !(col.name === 'Age' && col.type === 'date'))
  const spec = sorted(o.spec ?? {}) as Record<string, unknown>
  const status = sorted(o.status ?? {}) as Record<string, unknown>
  const statusFields = Object.keys(status).filter((k) => k !== 'conditions')
  const conds = (o.status?.conditions ?? []) as Obj[]
  const managed = (m.managedFields ?? []) as Obj[]
  const peers = c.peers.filter((p) => !(p.metadata.name === m.name && (p.metadata.namespace ?? '') === (m.namespace ?? '')))
  const t = (key: string, en: string) => say(`crInstanceInfo.${key}`, en)
  return {
    badges: {},
    counts: { 'Managed Fields': managed.length, 'Peer Instances': peers.length },
    sections: {
      [t('basicInfo', 'Basic Info')]: section({
        rows: {
          Kind: o.kind, Name: m.name, ...(m.namespace ? { Namespace: m.namespace } : {}), 'API Version': o.apiVersion, CRD: crd.metadata.name,
          Created: at(m.creationTimestamp), UID: m.uid, 'Resource Version': m.resourceVersion,
        },
      }),
      ...(cells.length ? {
        [t('printerColumns', 'Additional Info')]: section({
          rows: Object.fromEntries(cells.map(({ col, value }) => [col.name, cellText({ ...col, jsonPath: printer.find((p) => p.name === col.name)?.jsonPath }, value, o)])),
        }),
      } : {}),
      ...(Object.keys(spec).length ? { [t('spec', 'Spec')]: section({ rows: Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, shown(v)])) }) } : {}),
      ...(statusFields.length ? { [t('status', 'Status')]: section({ rows: Object.fromEntries(statusFields.map((k) => [k, shown(status[k])])) }) } : {}),
      ...otherFieldsWant(o),
      ...(conds.length ? { [t('conditions', 'Conditions')]: section({ tables: [conditionsTable(conds)] }) } : {}),
      ...((m.ownerReferences ?? []).length ? {
        [t('ownerReferences', 'Owner References')]: section({ cards: m.ownerReferences.map((r: Obj) => ({ text: `Kind: ${r.kind} Name: ${r.name}`, tables: [] })) }),
      } : {}),
      ...((m.finalizers ?? []).length ? { [t('finalizers', 'Finalizers')]: section({ rest: m.finalizers.join(' ') }) } : {}),
      ...(managed.length ? {
        'Managed Fields': section({
          tables: [{ head: ['Manager', 'Operation', 'Subresource', 'Time'], rows: managed.map((f) => [dash(f.manager), dash(f.operation), dash(f.subresource), at(f.time)]) }],
        }),
      } : {}),
      [t('events', 'Events')]: eventsSection(c.events),
      'Peer Instances': peers.length
        ? section({
          tables: [{ head: ['Namespace', 'Name', 'Age'], rows: peers.slice(0, 10).map((p) => [dash(p.metadata.namespace), p.metadata.name, at(p.metadata.creationTimestamp)]) }],
          rest: pager(peers.length),
        })
        : section({ notes: [`No other instance of ${o.kind} in the cluster.`] }),
      ...(Object.keys(m.labels ?? {}).length ? { Labels: section({ tags: tags(m.labels) }) } : {}),
      ...(Object.keys(m.annotations ?? {}).length ? { Annotations: section({ tags: tags(m.annotations) }) } : {}),
    },
  }
}

type VPA = { o: Obj; cells: Record<string, unknown>; events: Obj[]; target: Obj | null }
// a container policy's fields of VPA 1.6 and 1.7, in the drawer's column order
const VPA17_POLICY_FIELDS = ['oomBumpUpRatio', 'oomMinBumpUp', 'memoryAggregationIntervalSeconds', 'memoryAggregationIntervalCount', 'startupBoost']
// a startupBoost as the drawer writes it: per resource (by name) its fields in the API's order, the rest after by name
function boostText(boost: Obj): string {
  const order = ['type', 'factor', 'quantity', 'durationSeconds']
  const rank = (k: string) => (order.includes(k) ? order.indexOf(k) : order.length)
  const parts = Object.keys(boost ?? {}).sort().map((r) => `${r} (${Object.keys(boost[r]).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map((k) => `${k}: ${boost[r][k]}`).join(', ')})`)
  return parts.join('; ') || '-'
}
// a VPA's drawer: kubectl's columns as badges, its target and how that workload stands, its policies, recommendations,
// conditions, events and metadata
function vpaWant(c: VPA): View {
  const { o, cells, target } = c
  const m = o.metadata
  const spec = o.spec ?? {}
  const st = o.status ?? {}
  const resources = (r?: Record<string, string>) => (Object.keys(r ?? {}).length ? byKey(r).map(([k, v]) => `${k}: ${v}`).join(', ') : '-')
  const policies = (spec.resourcePolicy?.containerPolicies ?? []) as Obj[]
  const recs = (st.recommendation?.containerRecommendations ?? []) as Obj[]
  const targetStatus = target && (target.kind === 'DaemonSet'
    ? [target.status?.desiredNumberScheduled ?? 0, target.status?.numberReady ?? 0, target.status?.numberAvailable ?? 0]
    : [target.spec?.replicas ?? 0, target.status?.readyReplicas ?? 0, target.status?.availableReplicas ?? 0])
  return {
    badges: { Mode: dash(cells.Mode), Provided: dash(cells.Provided), CPU: dash(cells.CPU), Memory: dash(cells.Mem) },
    counts: {},
    sections: {
      Summary: section({ rows: { Name: m.name, Namespace: m.namespace, UID: m.uid, Created: at(m.creationTimestamp) } }),
      'Target Reference': section({
        rows: {
          Kind: dash(spec.targetRef?.kind), Name: dash(spec.targetRef?.name),
          ...(targetStatus ? { 'Target Status': `Desired: ${targetStatus[0]} · Ready: ${targetStatus[1]} · Available: ${targetStatus[2]}` } : {}),
        },
      }),
      'Update Policy': section({
        rows: {
          'Update Mode': dash(spec.updatePolicy?.updateMode),
          // VPA 1.7's wide columns as the API server prints them (the object's value on an older CRD), the pod's startupBoost
          'Min Replicas': 'MinReplicas' in cells ? dash(cells.MinReplicas) : dash(spec.updatePolicy?.minReplicas),
          'Evict After OOM Seconds': 'OOMSeconds' in cells ? dash(cells.OOMSeconds) : dash(spec.updatePolicy?.evictAfterOOMSeconds),
          'Startup Boost': boostText(spec.startupBoost),
        },
      }),
      ...(policies.length ? {
        'Container Policies': section({
          tables: [{
            head: ['Container', 'Mode', 'Controlled Resources', 'Controlled Values', 'Min Allowed', 'Max Allowed'],
            rows: policies.map((p) => [dash(p.containerName), dash(p.mode), (p.controlledResources ?? []).join(', ') || '-', dash(p.controlledValues), resources(p.minAllowed), resources(p.maxAllowed)]),
          }, ...(policies.some((p) => VPA17_POLICY_FIELDS.some((f) => p[f] !== undefined)) ? [{
            head: ['Container', 'OOM Bump Up Ratio', 'OOM Min Bump Up', 'Memory Aggregation Interval Seconds', 'Memory Aggregation Interval Count', 'Startup Boost'],
            rows: policies.map((p) => [dash(p.containerName), ...VPA17_POLICY_FIELDS.slice(0, 4).map((f) => dash(p[f])), boostText(p.startupBoost)]),
          }] : [])],
        }),
      } : {}),
      ...(recs.length ? {
        Recommendations: section({
          tables: [{
            head: ['Container', 'Lower Bound', 'Target', 'Upper Bound', 'Uncapped Target'],
            rows: recs.map((r) => [dash(r.containerName), resources(r.lowerBound), resources(r.target), resources(r.upperBound), resources(r.uncappedTarget)]),
          }],
        }),
      } : {}),
      Conditions: conditionsSection(st.conditions ?? []),
      Events: eventsSection(c.events),
      Labels: tagsSection(m.labels),
      Annotations: tagsSection(m.annotations),
    },
  }
}

// the CRD's drawer: its names, subresources by name (kubectl describe's order), versions with their printer columns,
// stored versions, conditions, its instances in every namespace, ten to a page, and the events about it
function crdWant(crd: Obj, instances: Obj[], events: Obj[]): View {
  const names = crd.spec.names
  const versions = crd.spec.versions as Obj[]
  const subresources = [...new Set(versions.flatMap((v) => Object.keys(v.subresources ?? {})))].sort()
  const t = (key: string, en: string) => say(`crdInfo.${key}`, en)
  return {
    badges: {},
    counts: { 'Custom Resources': instances.length },
    sections: {
      [t('basicInfo', 'Basic Info')]: section({
        rows: {
          Kind: 'CustomResourceDefinition', Name: crd.metadata.name, [t('group', 'Group')]: crd.spec.group, [t('scope', 'Scope')]: crd.spec.scope,
          [t('resourceKind', 'Resource Kind')]: names.kind, [t('plural', 'Plural')]: names.plural, [t('singular', 'Singular')]: dash(names.singular),
          [t('listKind', 'List Kind')]: dash(names.listKind),
          ...((names.shortNames ?? []).length ? { [t('shortNames', 'Short Names')]: names.shortNames.join(' ') } : {}),
          ...((names.categories ?? []).length ? { [t('categories', 'Categories')]: names.categories.join(' ') } : {}),
          ...(subresources.length ? { [t('subresources', 'Subresources')]: subresources.join(' ') } : {}),
          Created: at(crd.metadata.creationTimestamp), UID: crd.metadata.uid, 'Resource Version': crd.metadata.resourceVersion,
        },
      }),
      [t('versions', 'Versions')]: section({
        cards: versions.map((v) => {
          const columns = (v.additionalPrinterColumns ?? []) as Obj[]
          return {
            text: [v.name, v.storage && 'Storage', v.served ? 'Served' : 'Not Served', columns.length && 'Additional Printer Columns'].filter(Boolean).join(' '),
            tables: columns.length ? [{ head: ['Name', 'Type', 'JSON Path'], rows: columns.map((col) => [col.name, col.type, col.jsonPath]) }] : [],
          }
        }),
      }),
      [t('storedVersions', 'Stored Versions')]: section({ rest: (crd.status?.storedVersions ?? []).join(' ') }),
      [t('conditions', 'Conditions')]: conditionsSection(crd.status?.conditions ?? []),
      'Custom Resources': instances.length
        ? section({
          tables: [{ head: ['Name', 'Namespace', 'Age'], rows: instances.slice(0, 10).map((i) => [i.metadata.name, dash(i.metadata.namespace), at(i.metadata.creationTimestamp)]) }],
          rest: pager(instances.length),
        })
        : section({ notes: [NONE] }),
      Events: eventsSection(events),
      ...(Object.keys(crd.metadata.labels ?? {}).length ? { Labels: section({ tags: tags(crd.metadata.labels) }) } : {}),
      ...(Object.keys(crd.metadata.annotations ?? {}).length ? { Annotations: section({ tags: tags(crd.metadata.annotations) }) } : {}),
    },
  }
}

// the drawer of a kind Kubeast has no view for: the object's names and times, and every label and annotation whole
function genericWant(o: Obj): View {
  const m = o.metadata
  return {
    badges: {},
    counts: {},
    sections: {
      'Basic Info': section({ rows: { Kind: o.kind, Name: m.name, Namespace: m.namespace, 'API Version': o.apiVersion, Created: at(m.creationTimestamp), UID: m.uid } }),
      ...(Object.keys(m.labels ?? {}).length ? { Labels: section({ tags: tags(m.labels) }) } : {}),
      ...(Object.keys(m.annotations ?? {}).length ? { Annotations: section({ tags: tags(m.annotations) }) } : {}),
    },
  }
}

// a drawer's policy violations: the fail, warn and error results the reports hold about the object — any of the
// resources a result names, else the report's scope — in no particular order; a namespaced object's from its
// namespace's PolicyReports, a cluster-scoped one's from the ClusterPolicyReports
function violationsWant(reports: Obj[], kind: string, name: string): Section {
  const about = (rep: Obj, r: Obj) => ((r.resources ?? []).length ? r.resources : [rep.scope ?? {}]).some((x: Obj) => x.kind === kind && x.name === name)
  const rows = reports.flatMap((rep) => (rep.results ?? []).filter((r: Obj) => ['fail', 'warn', 'error'].includes(r.result) && about(rep, r)).map((r: Obj) => [
    say(`policyReports.result.${r.result}`, r.result), r.rule ? `${r.policy} /${r.rule}` : r.policy, dash(r.severity), dash(r.message),
  ]))
  return rows.length
    ? section({ tables: [{ head: ['result', 'policy', 'severity', 'message'].map((k) => say(`policyReports.table.${k}`, k)), rows: rows.sort() }] })
    : section({ rest: NONE })
}

// the VPAs' target workloads (pause containers, nothing pulled) and a checkpoint with more annotations than a screen
// shows and one longer than a line
const PAUSE = { name: 'app', image: 'registry.k8s.io/pause:3.10', imagePullPolicy: 'IfNotPresent' }
const podTemplate = (app: string) => ({ metadata: { labels: { app } }, spec: { terminationGracePeriodSeconds: 0, containers: [PAUSE] } })
const TARGETS = [
  { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'web', namespace: NS }, spec: { replicas: 2, selector: { matchLabels: { app: 'web' } }, template: podTemplate('web') } },
  { apiVersion: 'apps/v1', kind: 'StatefulSet', metadata: { name: 'db', namespace: NS }, spec: { replicas: 0, serviceName: 'db', selector: { matchLabels: { app: 'db' } }, template: podTemplate('db') } },
  { apiVersion: 'apps/v1', kind: 'DaemonSet', metadata: { name: 'agent', namespace: NS }, spec: { selector: { matchLabels: { app: 'agent' } }, template: podTemplate('agent') } },
]
// num-vpa-b's policies: one container's, the default's ("*") and one that names no container
const POLICIES = [
  { containerName: 'db', mode: 'Auto', controlledResources: ['cpu', 'memory'], controlledValues: 'RequestsOnly', minAllowed: { memory: '64Mi', cpu: '50m' }, maxAllowed: { cpu: '1', memory: '1Gi' } },
  { containerName: '*', mode: 'Off' },
  { controlledValues: 'RequestsAndLimits', maxAllowed: { memory: '512Mi' } },
]
const CHECKPOINT = {
  apiVersion: 'autoscaling.k8s.io/v1', kind: 'VerticalPodAutoscalerCheckpoint',
  metadata: {
    name: 'num-vpacp', namespace: NS, labels: { app: 'num' },
    annotations: Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`numbers.kubeast.io/note-${String(i + 1).padStart(2, '0')}`, i === 21 ? `a long note: ${'x'.repeat(240)}` : `note ${i + 1}`])),
  },
  spec: { vpaObjectName: 'num-vpa-a', containerName: 'app' },
  status: { version: 'v3', totalSamplesCount: 5 },
}
// more Widgets, so the CRD's instances and a Widget's peers run past one page
const MORE_WIDGETS = Array.from({ length: 9 }, (_, i) => ({ apiVersion: 'numbers.kubeast.io/v1', kind: 'Widget', metadata: { name: `num-w${i + 4}`, namespace: NS }, spec: { size: 'small', replicas: i } }))
// a Widget of a third group (test2 has its own qa.example.com one) with columns of its own, both subresources and
// fields beside spec and status, so Advanced Search and a link must name the group to open it with its CRD
const ALT_CRD_NAME = 'widgets.alt.kubeast.io'
const ALT_CRD = {
  apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name: ALT_CRD_NAME },
  spec: {
    group: 'alt.kubeast.io', scope: 'Namespaced', names: { kind: 'Widget', plural: 'widgets', singular: 'widget', listKind: 'WidgetList' },
    versions: [{
      name: 'v1', served: true, storage: true,
      subresources: { status: {}, scale: { specReplicasPath: '.spec.replicas', statusReplicasPath: '.status.replicas' } },
      additionalPrinterColumns: [
        { name: 'Color', type: 'string', jsonPath: '.spec.color' },
        { name: 'Replicas', type: 'integer', jsonPath: '.spec.replicas' },
        { name: 'Owner', type: 'string', jsonPath: '.owner' },
        { name: 'Ready', type: 'boolean', jsonPath: '.status.ready', priority: 1 },
      ],
      schema: {
        openAPIV3Schema: {
          type: 'object',
          properties: {
            spec: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
            status: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
            owner: { type: 'string' },
            results: { type: 'array', items: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true } },
            summary: { type: 'object', properties: { pass: { type: 'integer' }, fail: { type: 'integer' } } },
          },
        },
      },
    }],
  },
}
const ALT_WIDGET = {
  apiVersion: 'alt.kubeast.io/v1', kind: 'Widget', metadata: { name: 'num-alt-1', namespace: NS, labels: { app: 'alt' } },
  spec: { color: 'teal', replicas: 3 }, owner: 'team-alt',
  results: [{ policy: 'alt-size', result: 'pass' }, { policy: 'alt-color', result: 'fail', message: 'teal is not allowed' }], summary: { pass: 1, fail: 1 },
}
// events about the two CRDs — cluster-scoped objects, so the events are in default (number-check-rbac-drawers.spec.ts)
// [CRD, reason, type, count, last seen and first seen, seconds ago]
const CRD_EVENTS: [string, string, string, number, number, number][] = [
  ['widgets.numbers.kubeast.io', 'NumbersEstablished', 'Normal', 1, 200, 200],
  [ALT_CRD_NAME, 'AltEstablished', 'Normal', 1, 400, 400],
  [ALT_CRD_NAME, 'AltNamesConflict', 'Warning', 2, 30, 500],
]
const crdEventName = (crdName: string, reason: string) => `${crdName}.${reason.toLowerCase()}`

// events about the objects as a controller records them: two about a Widget, one about a ConfigMap of its name (the
// Widget's drawer leaves it out), one about a VPA seen three times, a Warning about a policy.
// [apiVersion, kind, name, reason, type, count, last seen and first seen, seconds ago]
const EVENTS: [string, string, string, string, string, number, number, number][] = [
  ['numbers.kubeast.io/v1', 'Widget', 'num-w1', 'NumbersSynced', 'Normal', 1, 300, 300],
  ['numbers.kubeast.io/v1', 'Widget', 'num-w1', 'NumbersReady', 'Warning', 2, 60, 600],
  ['v1', 'ConfigMap', 'num-w1', 'NumbersElsewhere', 'Normal', 1, 30, 30],
  ['autoscaling.k8s.io/v1', 'VerticalPodAutoscaler', 'num-vpa-a', 'NumbersRecommended', 'Normal', 3, 120, 900],
  ['numbers.kubeast.io/v1', 'BackendTLSPolicy', 'num-gp-2', 'NumbersRejected', 'Warning', 1, 45, 45],
]
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString().replace(/\.\d+Z$/, 'Z')
const POLR_FIXTURE = fs.readFileSync(path.join(__dirname, 'number-check.polr-fixture.yaml'), 'utf8').replace(/\be2e-numbers\b/g, NS)

type Way = { name: string; open: (page: Page) => Promise<void> }
// a list page's row by its name cell (and its namespace cell when the list spans namespaces)
async function clickRow(page: Page, url: string, name: string, ns?: string) {
  await page.goto(url)
  const exact = (v: string) => ({ hasText: new RegExp(`^\\s*${v}\\s*$`) })
  let row = page.locator('main tbody tr').filter({ has: page.locator('td', exact(name)) })
  if (ns) row = row.filter({ has: page.locator('td', exact(ns)) })
  await row.first().locator('td', exact(name)).click({ timeout: 20_000 })
}
const link = (cluster: string, detail: string, api?: string): Way => ({
  name: 'link',
  open: (page) => page.goto(`/?cluster=${cluster}&detail=${encodeURIComponent(detail)}${api ? `&detailApi=${encodeURIComponent(api)}` : ''}`).then(() => undefined),
})

// the drawer opened one way, read until it equals what the cluster has (20 s), else its difference kept and the next
// step run; only: one section of it, its tables' rows in no particular order
async function compare(page: Page, way: Way, what: string, want: () => View | Promise<View>, only?: string) {
  await test.step(`${what} · ${way.name}`, async () => {
    await way.open(page)
    await page.locator(DRAWER).last().waitFor({ timeout: 20_000 })
    const read = async () => {
      const view = await readDrawer(page)
      const one = only ? view.sections[only] : undefined
      return only ? one && { ...one, tables: one.tables.map((t) => ({ ...t, rows: [...t.rows].sort() })) } : view
    }
    let expected = await want()
    const target = only ? (expected as View).sections[only] : expected
    const shown = async () => settle(await read(), target)
    try {
      await expect.poll(shown, { timeout: 20_000 }).toEqual(target)
    } catch {
      expected = await want()
      expect.soft(await shown(), `${what} opened by ${way.name}`).toEqual(only ? (expected as View).sections[only] : expected)
    }
  })
}

test.describe('number check — VPA, CRD, custom resource and fallback drawers', () => {
  test('each drawer shows the numbers the cluster has, opened from its list and by link', async ({ page }) => {
    test.setTimeout(900_000)
    const t2 = kube('test2')
    const clusters = await (await page.request.get('/api/v1/clusters')).json()
    const registered = (id: string) => (Array.isArray(clusters) ? clusters : clusters.items ?? []).some((x: Obj) => x.id === id)
    let vpaServed = false
    try {
      vpaServed = !!t2 && /^verticalpodautoscalers\./m.test(t2.kubectl('api-resources --api-group=autoscaling.k8s.io -o name'))
    } catch {
      vpaServed = false
    }
    test.skip(!t2 || !registered('test2') || !vpaServed, 'needs the kind cluster test2, registered as test2, serving the VPA CRD')
    const k = t2!
    const cleanup = () => {
      k.kubectl(`delete namespace ${NS} --wait=true --timeout=180s --ignore-not-found`)
      k.kubectl(`delete crd/widgets.numbers.kubeast.io crd/backendtlspolicies.numbers.kubeast.io crd/${ALT_CRD_NAME} --ignore-not-found --wait=true`)
      k.kubectl(`delete events -n default ${CRD_EVENTS.map(([crdName, reason]) => crdEventName(crdName, reason)).join(' ')} --ignore-not-found`)
    }
    cleanup()
    try {
      // the objects, their statuses, the VPAs' targets and the events
      k.kubectl('apply --server-side --field-manager=e2e-cr-drawers -f -', CR_CRD)
      k.kubectl('apply --server-side --field-manager=e2e-cr-drawers -f -', GWPOL_CRD)
      k.kubectl('apply --server-side --field-manager=e2e-cr-drawers -f -', JSON.stringify(ALT_CRD))
      k.kubectl(`wait --for=condition=Established crd/widgets.numbers.kubeast.io crd/backendtlspolicies.numbers.kubeast.io crd/${ALT_CRD_NAME} --timeout=60s`)
      k.kubectl('apply --server-side --field-manager=e2e-cr-drawers -f -', vpaFixture(NS))
      writeVpaStatus(k.kubectl, NS)
      k.kubectl(`patch verticalpodautoscaler num-vpa-b -n ${NS} --type=merge -p=${arg({ spec: { resourcePolicy: { containerPolicies: POLICIES } } })}`)
      k.kubectl('apply --server-side --field-manager=e2e-cr-drawers -f -', crInstances(NS))
      writeWidgetStatus(k.kubectl, NS)
      k.kubectl('apply --server-side --field-manager=e2e-cr-drawers -f -', JSON.stringify({ apiVersion: 'v1', kind: 'List', items: [...numbersPolicies(NS), ...MORE_WIDGETS, ...TARGETS, CHECKPOINT, ALT_WIDGET] }))
      writeNumbersPolicyStatus(k.kubectl, NS)
      k.kubectl(`patch widgets.alt.kubeast.io num-alt-1 -n ${NS} --subresource=status --type=merge -p=${arg({ status: { replicas: 3, ready: true } })}`)
      for (const w of ['deployment/web', 'daemonset/agent']) k.kubectl(`rollout status ${w} -n ${NS} --timeout=120s`)
      const uidOf = (apiVersion: string, kind: string, name: string) => {
        const group = apiVersion.includes('/') ? apiVersion.split('/')[0] : ''
        try {
          return JSON.parse(k.kubectl(`get ${kind.toLowerCase()}${group ? `.${group}` : ''} ${name} -n ${NS} -o json`)).metadata.uid
        } catch {
          return undefined
        }
      }
      const events = EVENTS.map(([apiVersion, kind, name, reason, type, count, last, first]) => ({
        apiVersion: 'v1', kind: 'Event',
        metadata: { name: `${name}.${reason.toLowerCase()}`, namespace: NS },
        involvedObject: { apiVersion, kind, name, namespace: NS, uid: uidOf(apiVersion, kind, name) },
        reason, message: `${reason} by the number check`, type, count, firstTimestamp: ago(first), lastTimestamp: ago(last),
        source: { component: 'e2e-cr-drawers' },
      }))
      const crdEvents = CRD_EVENTS.map(([crdName, reason, type, count, last, first]) => ({
        apiVersion: 'v1', kind: 'Event',
        metadata: { name: crdEventName(crdName, reason), namespace: 'default' },
        involvedObject: { apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', name: crdName, uid: JSON.parse(k.kubectl(`get crd ${crdName} -o json`)).metadata.uid },
        reason, message: `${reason} by the number check`, type, count, firstTimestamp: ago(first), lastTimestamp: ago(last),
        source: { component: 'e2e-cr-drawers' },
      }))
      k.kubectl('create -f -', JSON.stringify({ apiVersion: 'v1', kind: 'List', items: [...events, ...crdEvents] }))

      // what the cluster has: the object (managed fields too), kubectl's columns of it, the events kubectl describe
      // lists about it (its name, kind and uid, newest first; a cluster-scoped object's in every namespace)
      const get = (resource: string, name: string, ns = NS) => JSON.parse(k.kubectl(`get ${resource} ${name}${ns ? ` -n ${ns}` : ''} --show-managed-fields -o json`))
      const eventsAbout = (o: Obj) => (JSON.parse(k.kubectl(`get events ${o.metadata.namespace ? `-n ${o.metadata.namespace}` : '-A'} --field-selector involvedObject.name=${o.metadata.name},involvedObject.kind=${o.kind} -o json`)).items as Obj[])
        .filter((e) => e.involvedObject.uid === o.metadata.uid)
        .sort((a, b) => Date.parse(b.lastTimestamp ?? b.firstTimestamp) - Date.parse(a.lastTimestamp ?? a.firstTimestamp))
      const customResource = async (crdName: string, name: string): Promise<CR> => {
        const crd = JSON.parse(k.kubectl(`get crd ${crdName} -o json`))
        const o = get(crdName, name)
        const [group, version, plural] = [crd.spec.group, o.apiVersion.split('/')[1], crd.spec.names.plural]
        const t = await k.table(`/apis/${group}/${version}/namespaces/${NS}/${plural}/${name}`)
        return { o, crd, cells: t.rows[0]?.cells ?? [], columns: t.columnDefinitions, events: eventsAbout(o), peers: JSON.parse(k.kubectl(`get ${crdName} -A -o json`)).items }
      }
      const crdView = (crdName: string) => {
        const crd = JSON.parse(k.kubectl(`get crd ${crdName} -o json`))
        return crdWant(crd, JSON.parse(k.kubectl(`get ${crdName} -A -o json`)).items, eventsAbout(crd))
      }
      // Advanced Search with the given types (name.group where two groups serve the name), in the spec's namespace,
      // every loaded object matching; then the object's name in the results
      const searchFor = (cluster: string, types: string[], name: string) => async (p: Page) => {
        // the server keeps a cluster's API resources for a minute: wait until it lists the kinds the spec just made
        await expect.poll(async () => {
          const lists = await (await p.request.get(`/api/v1/cluster/api-resources?cluster=${cluster}`)).json() as { groupVersion: string; resources: { name: string }[] }[]
          // a type is <plural>[.<group>]
          return types.every((t) => {
            const [plural, ...g] = t.split('.')
            return lists.some((l) => (g.length === 0 || l.groupVersion.startsWith(`${g.join('.')}/`)) && l.resources.some((r) => r.name === plural))
          })
        }, { timeout: 75_000, message: `the API resources of ${cluster} list ${types.join(', ')}` }).toBe(true)
        await p.addInitScript((t) => localStorage.setItem('advanced-search-resources', JSON.stringify(t)), types)
        await p.goto(`/cluster/search?cluster=${cluster}`)
        await p.getByTestId('advanced-search-namespace').click()
        await p.getByRole('button', { name: NS, exact: true }).click()
        await p.locator('.monaco-editor').first().click()
        await p.keyboard.type('true')
        await p.locator('table tbody tr').getByRole('button', { name, exact: true }).click({ timeout: 20_000 })
      }
      const vpa = async (name: string): Promise<VPA> => {
        const o = get('verticalpodautoscalers.autoscaling.k8s.io', name)
        const t = await k.table(`/apis/autoscaling.k8s.io/v1/namespaces/${NS}/verticalpodautoscalers/${name}`)
        const cells = Object.fromEntries(t.columnDefinitions.map((c, i) => [c.name, t.rows[0]?.cells[i]]))
        let target: Obj | null = null
        try {
          target = get(`${o.spec.targetRef.kind.toLowerCase()}.apps`, o.spec.targetRef.name)
        } catch {
          target = null
        }
        return { o, cells, events: eventsAbout(o), target }
      }

      await page.context().addInitScript(() => localStorage.setItem('kubeast.listPageSize', '100'))

      for (const name of ['num-w1', 'num-w2', 'num-w3']) {
        for (const way of [
          { name: 'list', open: (p: Page) => clickRow(p, '/custom-resources/instances?cluster=test2', name, NS) },
          link('test2', `Widget/${NS}/${name}`, 'numbers.kubeast.io/v1/widgets'),
        ]) await compare(page, way, `Widget/${name}`, async () => customResourceWant(await customResource('widgets.numbers.kubeast.io', name)))
      }
      // one Kind of two groups, each opened from Advanced Search (the object's apiVersion goes with it) and by the link
      // that leaves (detailApi=<group>/<version>) — each with its own CRD's columns; the number check's Widget also
      // from the Timeline (the event names its object's apiVersion)
      const WIDGET_TYPES = ['widgets.numbers.kubeast.io', 'widgets.alt.kubeast.io']
      for (const [crdName, name] of [['widgets.numbers.kubeast.io', 'num-w1'], [ALT_CRD_NAME, 'num-alt-1']]) {
        const apiVersion = `${crdName.slice('widgets.'.length)}/v1`
        for (const way of [
          { name: 'Advanced Search', open: searchFor('test2', WIDGET_TYPES, name) },
          link('test2', `Widget/${NS}/${name}`, apiVersion),
        ]) await compare(page, way, `Widget.${crdName.slice('widgets.'.length)}/${name}`, async () => customResourceWant(await customResource(crdName, name)))
      }
      await compare(page, {
        name: 'Timeline',
        open: async (p: Page) => {
          await p.goto('/timeline?cluster=test2')
          await p.getByTestId('timeline-namespace').click()
          await p.locator('.absolute.top-full button', { hasText: new RegExp(`^\\s*${NS}\\s*$`) }).click()
          await p.getByRole('button', { name: 'Widget/num-w1', exact: true }).first().click({ timeout: 20_000 })
        },
      }, 'Widget.numbers.kubeast.io/num-w1', async () => customResourceWant(await customResource('widgets.numbers.kubeast.io', 'num-w1')))
      for (const name of ['num-gp-1', 'num-gp-2']) {
        for (const way of [
          { name: 'Gateway → Policies', open: (p: Page) => clickRow(p, '/gateway/policies?cluster=test2', name, NS) },
          link('test2', `BackendTLSPolicy/${NS}/${name}`, 'numbers.kubeast.io/v1/backendtlspolicies'),
        ]) await compare(page, way, `BackendTLSPolicy.numbers.kubeast.io/${name}`, async () => customResourceWant(await customResource('backendtlspolicies.numbers.kubeast.io', name)))
      }
      // VPA 1.7's fields on a VPA that sets them, where the CRD has them (an older CRD refuses them)
      const vpaWide = `num-vpa-wide-${Date.now().toString(36)}`
      const wide = vpaPrintsWideColumns(k.kubectl)
      if (wide) k.kubectl('apply --server-side --field-manager=e2e-cr-drawers -f -', JSON.stringify(vpa17(NS, vpaWide)))
      else test.info().annotations.push({ type: 'skip', description: `VPA 1.7 fields: ${VPA17_MISSING}` })
      for (const name of ['num-vpa-a', 'num-vpa-b', 'num-vpa-c', ...(wide ? [vpaWide] : [])]) {
        for (const way of [
          { name: 'list', open: (p: Page) => clickRow(p, `/workloads/vpas?cluster=test2&namespace=${NS}`, name) },
          link('test2', `VerticalPodAutoscaler/${NS}/${name}`),
        ]) await compare(page, way, `VerticalPodAutoscaler/${name}`, async () => vpaWant(await vpa(name)))
      }
      for (const crdName of ['widgets.numbers.kubeast.io', ALT_CRD_NAME]) {
        for (const way of [
          { name: 'list', open: (p: Page) => clickRow(p, '/custom-resources/groups?cluster=test2', crdName) },
          link('test2', `CustomResourceDefinition/${crdName}`),
        ]) await compare(page, way, `CustomResourceDefinition/${crdName}`, () => crdView(crdName))
      }
      // the checkpoint's kind has no drawer of its own: from Advanced Search (its apiVersion goes with it) and by that
      // link it is its CRD's custom resource; a link naming only the Kind opens the drawer of a kind Kubeast has no view for
      for (const way of [
        { name: 'Advanced Search', open: searchFor('test2', ['verticalpodautoscalercheckpoints'], 'num-vpacp') },
        link('test2', `VerticalPodAutoscalerCheckpoint/${NS}/num-vpacp`, 'autoscaling.k8s.io/v1'),
      ]) {
        await compare(page, way, 'VerticalPodAutoscalerCheckpoint/num-vpacp',
          async () => customResourceWant(await customResource('verticalpodautoscalercheckpoints.autoscaling.k8s.io', 'num-vpacp')))
      }
      await compare(page, { ...link('test2', `VerticalPodAutoscalerCheckpoint/${NS}/num-vpacp`), name: 'link without apiVersion' },
        'VerticalPodAutoscalerCheckpoint/num-vpacp', () => genericWant(get('verticalpodautoscalercheckpoints.autoscaling.k8s.io', 'num-vpacp')))

      // policy violations on default, from Policy Reports and by link: a pod's, two ConfigMaps' (num-cm-b only the second
      // resource one result names, so by link), one without any (None), a Service's and the namespace's — a cluster-scoped
      // object, from a ClusterPolicyReport made for this run
      const b = kube('kubeast-b')
      const polr = !!b && registered('default') && b.kubectl('api-resources --api-group=wgpolicyk8s.io -o name').includes('policyreports')
      if (!polr) test.info().annotations.push({ type: 'skip', description: 'policy violations: needs the second cluster (default) serving PolicyReports' })
      if (polr) {
        const bk = b!
        const run = Date.now().toString(36)
        const cpolr = `num-cpolr-${run}`
        const nsPolicy = `num-ns-owner-${run}`
        try {
          bk.kubectl('apply --server-side --field-manager=e2e-cr-drawers -f -', POLR_FIXTURE)
          const configMap = (name: string) => ({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, namespace: NS }, data: { k: 'v' } })
          bk.kubectl('apply --server-side --field-manager=e2e-cr-drawers -f -', JSON.stringify({
            apiVersion: 'v1', kind: 'List', items: [
              {
                apiVersion: 'v1', kind: 'Pod', metadata: { name: 'num-p1', namespace: NS, labels: { 'app.kubernetes.io/name': 'num-p1' } },
                spec: { terminationGracePeriodSeconds: 0, containers: [{ name: 'app', image: 'nginx:1.31-alpine', imagePullPolicy: 'IfNotPresent' }] },
              },
              configMap('num-cm-a'), configMap('num-cm-b'), configMap('num-cm-clean'),
              { apiVersion: 'v1', kind: 'Service', metadata: { name: 'num-svc-polr', namespace: NS }, spec: { ports: [{ port: 80 }] } },
              {
                apiVersion: 'wgpolicyk8s.io/v1alpha2', kind: 'ClusterPolicyReport', metadata: { name: cpolr },
                scope: { apiVersion: 'v1', kind: 'Namespace', name: NS },
                summary: { pass: 1, fail: 1, warn: 1, error: 0, skip: 0 },
                results: [
                  { policy: nsPolicy, rule: 'need-owner', result: 'fail', source: 'kyverno', severity: 'high', message: `${NS} has no owner label` },
                  { policy: nsPolicy, rule: 'need-cost', result: 'warn', source: 'kyverno', message: `${NS} has no cost centre` },
                  { policy: nsPolicy, rule: 'need-quota', result: 'pass', source: 'kyverno' },
                ],
              },
            ],
          }))
          // Policy Reports' results (one namespace, or every one with the search) and the row about the object
          const fromPolicyReports = (rowText: string, opts: { namespace?: string; search?: string }) => ({
            name: 'Policy Reports',
            open: async (p: Page) => {
              await p.goto('/security/policyreports?cluster=default')
              if (opts.namespace) {
                await p.getByTestId('policy-reports-namespace').click()
                await p.getByTestId(`policy-reports-namespace-opt-${opts.namespace}`).click()
              }
              await p.getByTestId('policy-reports-tab-results').click()
              if (opts.search) await p.getByTestId('policy-reports-search').fill(opts.search)
              // the server keeps a read for a minute: the refresh reads the reports now
              await p.getByRole('button', { name: 'Refresh', exact: true }).click()
              await p.getByTestId('policy-report-row').filter({ hasText: rowText }).first().click({ timeout: 20_000 })
            },
          })
          const targets: { kind: string; name: string; namespaced: boolean; reports?: Way }[] = [
            { kind: 'Pod', name: 'num-p1', namespaced: true, reports: fromPolicyReports('num-p1', { namespace: NS }) },
            { kind: 'ConfigMap', name: 'num-cm-a', namespaced: true, reports: fromPolicyReports('num-cm-a', { namespace: NS }) },
            { kind: 'ConfigMap', name: 'num-cm-b', namespaced: true },
            { kind: 'ConfigMap', name: 'num-cm-clean', namespaced: true },
            { kind: 'Service', name: 'num-svc-polr', namespaced: true, reports: fromPolicyReports('num-svc-polr', { namespace: NS }) },
            { kind: 'Namespace', name: NS, namespaced: false, reports: fromPolicyReports(nsPolicy, { search: nsPolicy }) },
          ]
          for (const t of targets) {
            // the drawer's read too is kept a minute: read it now, as the page's refresh does
            await page.request.get(t.namespaced
              ? `/api/v1/cluster/namespaces/${NS}/policyreports/resource?cluster=default&kind=${t.kind}&name=${t.name}&force_refresh=true`
              : `/api/v1/cluster/policyreports/resource?cluster=default&kind=${t.kind}&name=${t.name}&force_refresh=true`)
            for (const way of [...(t.reports ? [t.reports] : []), link('default', t.namespaced ? `${t.kind}/${NS}/${t.name}` : `${t.kind}/${t.name}`)]) {
              await compare(page, way, `${t.kind}/${t.name} · policy violations`, () => ({
                badges: {}, counts: {}, sections: {
                  'Policy violations': violationsWant(JSON.parse(bk.kubectl(t.namespaced ? `get policyreports -n ${NS} -o json` : 'get clusterpolicyreports -o json')).items, t.kind, t.name),
                },
              }), 'Policy violations')
            }
          }
          // the report's own fields beside spec and status (results, scope, summary) on its custom resource drawer,
          // from Advanced Search and by link (the rest of the drawer is the Widget steps')
          for (const way of [
            { name: 'Advanced Search', open: searchFor('default', ['policyreports'], 'num-polr-pod') },
            link('default', `PolicyReport/${NS}/num-polr-pod`, 'wgpolicyk8s.io/v1alpha2/policyreports'),
          ]) {
            await compare(page, way, 'PolicyReport/num-polr-pod · other fields', () => ({
              badges: {}, counts: {}, sections: otherFieldsWant(JSON.parse(bk.kubectl(`get policyreports.wgpolicyk8s.io num-polr-pod -n ${NS} -o json`))),
            }), OTHER_FIELDS)
          }
        } finally {
          bk.kubectl(`delete clusterpolicyreport ${cpolr} --ignore-not-found`)
          bk.kubectl(`delete namespace ${NS} --wait=true --timeout=180s --ignore-not-found`)
        }
      }
    } finally {
      cleanup()
    }
  })
})
