import { execSync } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// Every drawer's numbers are the cluster's: for each object of namespace e2e-numbers on `self` (the list check's
// fixture, made here and removed after) and for the node, the drawer's rows, summary badges, "(n)" counts and
// tables hold what the object says, what kubectl prints of it (the API server's Table, kubectl's printEvent rules) or
// what its ResourceQuota counts. A drawer is read until it matches or 20 s pass, then every difference is listed
// (expect.soft), and a number on a drawer that nothing here compares fails too.

const NS = 'e2e-numbers'
const kindName = 'kubeast'
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'

const kc = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-number-drawers-')), 'kubeconfig')
fs.writeFileSync(kcPath, kc, { mode: 0o600 })
const kubectl = (args: string, input?: string) =>
  execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()

const pick = (k: string) => (kc.match(new RegExp(`${k}: (\\S+)`)) ?? [])[1] ?? ''
const server = new URL(pick('server'))
type Table = { columnDefinitions: { name: string }[]; rows: { cells: unknown[]; object: { metadata: { name: string } } }[] }
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
// a Table as rows of column name → cell, by object name
async function tableRows(apiPath: string): Promise<Record<string, string>[]> {
  const t = await apiTable(apiPath)
  return t.rows.map((r) => Object.fromEntries([['_name', r.object.metadata.name], ...t.columnDefinitions.map((c, i) => [c.name, String(r.cells[i] ?? '')])]))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any
const FIXTURE = fs.readFileSync(path.join(__dirname, 'number-check.fixture.yaml'), 'utf8')
const KINDS = 'deploy,sts,ds,rs,job,cronjob,pod,svc,endpointslices.discovery.k8s.io,ing,netpol,pvc,cm,secret,sa,role,rolebinding,hpa,pdb,resourcequota,limitrange'
const NODE = 'kubeast-control-plane'

// Everything in the namespace in one read, and what kubectl prints of the pods, Jobs and the events
type Snap = { by: Record<string, Obj[]>; namespace: Obj; node: Obj; nodePods: Obj[]; podTable: Record<string, string>[]; jobTable: Record<string, string>[]; events: Record<string, string>[] }
async function snapshot(): Promise<Snap> {
  const by: Record<string, Obj[]> = {}
  for (const o of JSON.parse(kubectl(`get ${KINDS} -n ${NS} -o json`)).items) (by[o.kind] ??= []).push(o)
  return {
    by,
    namespace: JSON.parse(kubectl(`get namespace ${NS} -o json`)),
    node: JSON.parse(kubectl(`get node ${NODE} -o json`)),
    nodePods: JSON.parse(kubectl(`get pods -A --field-selector spec.nodeName=${NODE} -o json`)).items,
    podTable: await tableRows(`/api/v1/namespaces/${NS}/pods`),
    jobTable: await tableRows(`/apis/batch/v1/namespaces/${NS}/jobs`),
    events: await tableRows(`/api/v1/namespaces/${NS}/events`),
  }
}
const one = (s: Snap, kind: string, name: string): Obj => (s.by[kind] ?? []).find((o) => o.metadata.name === name)
const pods = (s: Snap): Obj[] => s.by.Pod ?? []
const selects = (sel: Record<string, string> | undefined, labels: Record<string, string> | undefined) =>
  !!sel && Object.entries(sel).every(([k, v]) => labels?.[k] === v)
const matching = (s: Snap, sel: Record<string, string> | undefined) => pods(s).filter((p) => selects(sel, p.metadata.labels))
const terminal = (p: Obj) => p.status.phase === 'Succeeded' || p.status.phase === 'Failed'
const str = (v: unknown, empty = '-') => (v === undefined || v === null || v === '' ? empty : String(v))
const yesNo = (v: unknown) => (v ? 'Yes' : 'No')

// Kubernetes quantities in base units, and the drawers' own forms of them ("207m", "1.23 cores", "188 MiB", "15.6Gi", "0B")
const SUFFIX: Record<string, number> = { n: 1e-9, u: 1e-6, m: 1e-3, '': 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18, Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 }
function qty(v: unknown): number {
  const s = String(v ?? '').trim().replace(/ cores?$/, '').replace(/ (Ki|Mi|Gi|Ti)B$/, '$1').replace(/^(\d+(?:\.\d+)?)B$/, '$1')
  const m = /^(\d+(?:\.\d+)?)([a-zA-Z]*)$/.exec(s)
  return m && m[2] in SUFFIX ? Number(m[1]) * SUFFIX[m[2]] : NaN
}
// a value shown rounded is the cluster's when it is within that rounding: cores to 2 decimals ("1.23 cores"), bytes to
// a whole MiB or 3 figures ("15.6Gi"), a count exactly
const near = (screen: unknown, cluster: unknown, unit: 'cores' | 'bytes' | 'count') => {
  const a = qty(screen)
  const b = qty(cluster)
  const tol = unit === 'cores' ? 0.005 : unit === 'bytes' ? Math.max(2 ** 19, Math.abs(b) * 0.006) : 0
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol
}
const unitOf = (resource: string) => (resource === 'cpu' ? 'cores' : resource === 'pods' ? 'count' : 'bytes')
// an age as kubectl writes it ("4m3s", "24d") in seconds; two reads a few seconds apart are the same within 15 %
function ageSeconds(s: string): number {
  const units: Record<string, number> = { y: 31536000, d: 86400, h: 3600, m: 60, s: 1 }
  let total = 0
  for (const m of s.matchAll(/(\d+)([ydhms])/g)) total += Number(m[1]) * units[m[2]]
  return /\d/.test(s) ? total : NaN
}
const sameAge = (a: string, b: string) => Math.abs(ageSeconds(a) - ageSeconds(b)) <= Math.max(15, ageSeconds(b) * 0.15)
// seconds from a time the API writes to now (or to `to`)
const since = (t: string | undefined, to?: string) => ((to ? Date.parse(to) : Date.now()) - Date.parse(t ?? '')) / 1000

type Drawer = { rows: [string, string][]; pairs: Record<string, string>; phases: Record<string, string>; counts: Record<string, number>; text: string; tables: { head: string[]; rows: string[][]; total: number | null }[] }
async function readDrawer(page: Page): Promise<Drawer> {
  return page.locator(DRAWER).last().evaluate((root) => {
    const rows: [string, string][] = []
    for (const g of root.querySelectorAll('div.grid')) {
      const spans = [...g.children].filter((c) => c.tagName === 'SPAN') as HTMLElement[]
      if (spans.length === 2 && spans[0].className.includes('text-slate-400')) rows.push([spans[0].innerText.trim(), spans[1].innerText.trim()])
    }
    const labelled = (sel: string) => {
      const out: Record<string, string> = {}
      for (const b of root.querySelectorAll(sel)) {
        const m = /^([^:\n]{1,40}): ([^\n]{1,60})$/.exec((b as HTMLElement).innerText.trim())
        if (m) out[m[1]] = m[2]
      }
      return out
    }
    const text = (root as HTMLElement).innerText
    const counts: Record<string, number> = {}
    for (const m of text.matchAll(/([A-Za-z][A-Za-z /]*?) \((\d+)\)/g)) counts[m[1].trim()] = Number(m[2])
    // a paged table's total: its pager "1-10 / 57" in the section around it
    const total = (tb: Element) => {
      let el = tb.parentElement
      for (let i = 0; el && i < 4; i++, el = el.parentElement) {
        const m = /\b\d+-\d+ \/ (\d+)\b/.exec((el as HTMLElement).innerText)
        if (m) return Number(m[1])
      }
      return null
    }
    const tables = [...root.querySelectorAll('table')].map((tb) => ({
      head: [...tb.querySelectorAll('thead th')].map((th) => (th as HTMLElement).innerText.trim()),
      rows: [...tb.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => (td as HTMLElement).innerText.trim())),
      total: total(tb),
    }))
    return { rows, pairs: labelled('span[class*="rounded-full"]'), phases: labelled('span[class*="rounded-sm"][class*="border"]'), counts, text, tables }
  })
}
const table = (d: Drawer, ...head: string[]) => d.tables.filter((t) => head.every((h, i) => t.head[i] === h))

// the same thing in Kubeast's words: an empty value is "-", booleans Yes/No, access modes spelled out
const MODES: Record<string, string> = { rwo: 'readwriteonce', rox: 'readonlymany', rwx: 'readwritemany', rwop: 'readwriteoncepod' }
function sameValue(screen: string, cluster: string): boolean {
  const a = screen.trim().toLowerCase()
  const b = cluster.trim().toLowerCase()
  const empty = new Set(['', '-', '<none>', 'none'])
  if (empty.has(a) && empty.has(b)) return true
  const words = (s: string) => s.split(/[\s,]+/).filter(Boolean).map((m) => MODES[m] ?? m).sort().join(',')
  return a === b || words(a) === words(b)
}

type Want = {
  // label → value, or the values in order for a label the drawer shows more than once
  rows?: Record<string, string | string[]>
  // rows compared only on the drawers that show them (the object's resourceVersion)
  ifShown?: Record<string, string>
  // rows that hold a time span, where shown: label → seconds (an age as "63s" or "… (63s)", a Job's duration)
  spans?: Record<string, number>
  pairs?: Record<string, string>
  counts?: Record<string, number>
  // the rest (tables, titles): each returns the differences it found
  more?: (d: Drawer) => string[]
  // numbers on the drawer not compared, with why
  skip?: Record<string, string>
}
type Target = { kind: string; ref: string; want: (s: Snap) => Want }

// a number on its own or with a unit ("3", "600s", "64Mi", "25%"), not an address or a date
const NUMBER = /^-?\d+(\.\d+)?(%|[a-zA-Z]{1,5})?$/

function differences(d: Drawer, w: Want): string[] {
  const out: string[] = []
  const shown: Record<string, string[]> = {}
  for (const [k, v] of d.rows) (shown[k] ??= []).push(v)
  for (const [label, value] of Object.entries(w.rows ?? {})) {
    const want = Array.isArray(value) ? value : [value]
    const got = (shown[label] ?? []).slice(0, want.length)
    // a row with no value shows "-" (the console's rule), not a blank
    if (got.length < want.length || want.some((v, i) => (v === '-' ? got[i] !== '-' : !sameValue(got[i], v)))) out.push(`row ${label}: drawer ${JSON.stringify(shown[label] ?? null)}, cluster ${JSON.stringify(want)}`)
  }
  for (const [label, value] of Object.entries(w.ifShown ?? {})) {
    if (shown[label] && !sameValue(shown[label][0], value)) out.push(`row ${label}: drawer ${JSON.stringify(shown[label])}, cluster "${value}"`)
  }
  for (const [label, secs] of Object.entries(w.spans ?? {})) {
    const v = shown[label]?.[0]
    if (v === undefined) continue
    // "63s", "… (63s)", or a time alone in the viewer's zone (the browser runs on this machine)
    const span = (/\(([^)]+)\)\s*$/.exec(v)?.[1] ?? v).trim()
    const at = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(span)
    const got = at ? (Date.now() - new Date(`${at[1]}T${at[2]}`).getTime()) / 1000 : ageSeconds(span)
    if (!(Math.abs(got - secs) <= Math.max(15, secs * 0.15))) out.push(`row ${label}: drawer "${v}", cluster ${Math.round(secs)}s`)
  }
  for (const [label, value] of Object.entries(w.pairs ?? {})) {
    if (!sameValue(d.pairs[label] ?? '(none)', value)) out.push(`badge ${label}: drawer ${JSON.stringify(d.pairs[label] ?? null)}, cluster "${value}"`)
  }
  for (const [label, n] of Object.entries(w.counts ?? {})) {
    if (d.counts[label] !== n) out.push(`count ${label}: drawer ${d.counts[label] ?? 'none'}, cluster ${n}`)
  }
  out.push(...(w.more?.(d) ?? []))
  // a number nothing compares
  const covered = (label: string) => label in (w.rows ?? {}) || label in (w.ifShown ?? {}) || label in (w.spans ?? {}) || label in (w.pairs ?? {}) || label in (w.counts ?? {}) || label in (w.skip ?? {})
  for (const [label, values] of Object.entries(shown)) if (values.some((v) => NUMBER.test(v)) && !covered(label)) out.push(`row ${label} = ${values.join(' | ')} is not compared`)
  for (const [label, v] of Object.entries(d.pairs)) if (NUMBER.test(v) && !covered(label)) out.push(`badge ${label} = ${v} is not compared`)
  for (const label of Object.keys(d.counts)) if (!covered(label)) out.push(`count ${label} (${d.counts[label]}) is not compared`)
  return out
}

const replicaRows = (desired: number, current: number, ready: number, upToDate: number, available: number) => ({
  rows: { Desired: String(desired), Current: String(current), Ready: String(ready), 'Up to date': String(upToDate), Available: String(available) },
  pairs: { Desired: String(desired), Ready: String(ready), Updated: String(upToDate), Available: String(available) },
})
const generation = (o: Obj) => ({ Generation: String(o.metadata.generation), 'Observed Generation': String(o.status.observedGeneration ?? 0) })
const n = (v: unknown) => Number(v ?? 0)

// pods that name a ConfigMap or Secret: volumes (also projected), env and envFrom of every container
function podsUsing(s: Snap, kind: 'configMap' | 'secret', name: string) {
  return pods(s).filter((p) => {
    const vols = (p.spec.volumes ?? []).some((v: Obj) => (kind === 'configMap' ? v.configMap?.name : v.secret?.secretName) === name ||
      (v.projected?.sources ?? []).some((src: Obj) => src[kind]?.name === name))
    const env = [...(p.spec.initContainers ?? []), ...(p.spec.containers ?? [])].some((c: Obj) =>
      (c.envFrom ?? []).some((e: Obj) => e[`${kind}Ref`]?.name === name) || (c.env ?? []).some((e: Obj) => e.valueFrom?.[`${kind}KeyRef`]?.name === name))
    return vols || env
  })
}

function eventDifferences(d: Drawer, s: Snap, involved: string): string[] {
  const out: string[] = []
  const kube = s.events.filter((e) => e.Object.endsWith(`/${involved}`))
  const shown = table(d, 'Type', 'Reason', 'Message', 'Last Seen', 'Count')[0]?.rows ?? []
  const key = (reason: string, message: string) => `${reason}|${message.trim()}`
  const want = kube.map((e) => ({ k: key(e.Reason, e.Message), last: e['Last Seen'], count: e.Count })).sort((a, b) => a.k.localeCompare(b.k))
  const got = shown.map((r) => ({ k: key(r[1], r[2]), last: r[3], count: r[4] })).sort((a, b) => a.k.localeCompare(b.k))
  if (got.map((g) => g.k).join('\n') !== want.map((x) => x.k).join('\n')) out.push(`events of ${involved}: drawer ${JSON.stringify(got.map((g) => g.k))}, kubectl ${JSON.stringify(want.map((x) => x.k))}`)
  else got.forEach((g, i) => {
    if (!sameAge(g.last, want[i].last) || g.count !== want[i].count) out.push(`event ${g.k}: drawer last seen ${g.last} count ${g.count}, kubectl ${want[i].last} count ${want[i].count}`)
  })
  return out
}

const TARGETS: Target[] = [
  ...['num-ready', 'num-notready'].map((name): Target => ({
    kind: 'Deployment', ref: `${NS}/${name}`, want: (s) => {
      const o = one(s, 'Deployment', name)
      const r = replicaRows(n(o.spec.replicas), n(o.status.replicas), n(o.status.readyReplicas), n(o.status.updatedReplicas), n(o.status.availableReplicas))
      return {
        rows: {
          ...r.rows, ...generation(o),
          'Max Unavailable': String(o.spec.strategy.rollingUpdate.maxUnavailable), 'Max Surge': String(o.spec.strategy.rollingUpdate.maxSurge),
          Revision: o.metadata.annotations['deployment.kubernetes.io/revision'], 'Progress Deadline': `${o.spec.progressDeadlineSeconds}s`,
          'Revision History Limit': String(o.spec.revisionHistoryLimit),
        },
        pairs: r.pairs,
        counts: { 'Owned ReplicaSets': (s.by.ReplicaSet ?? []).filter((rs) => (rs.metadata.ownerReferences ?? []).some((ref: Obj) => ref.uid === o.metadata.uid)).length },
      }
    },
  })),
  ...['num-db', 'num-db-down'].map((name): Target => ({
    kind: 'StatefulSet', ref: `${NS}/${name}`, want: (s) => {
      const o = one(s, 'StatefulSet', name)
      const r = replicaRows(n(o.spec.replicas), n(o.status.replicas), n(o.status.readyReplicas), n(o.status.updatedReplicas), n(o.status.availableReplicas))
      return {
        rows: {
          ...r.rows, ...generation(o), Partition: String(n(o.spec.updateStrategy.rollingUpdate?.partition)), 'Service Name': o.spec.serviceName,
          'Pod Management Policy': o.spec.podManagementPolicy, 'Revision History Limit': String(o.spec.revisionHistoryLimit),
          'Current Revision': o.status.currentRevision, 'Update Revision': o.status.updateRevision, 'Collision Count': String(n(o.status.collisionCount)),
        },
        pairs: r.pairs,
        counts: { Pods: matching(s, o.spec.selector.matchLabels).length },
      }
    },
  })),
  ...['num-agent', 'num-agent-down'].map((name): Target => ({
    kind: 'DaemonSet', ref: `${NS}/${name}`, want: (s) => {
      const o = one(s, 'DaemonSet', name)
      const st = o.status
      const r = replicaRows(n(st.desiredNumberScheduled), n(st.currentNumberScheduled), n(st.numberReady), n(st.updatedNumberScheduled), n(st.numberAvailable))
      return {
        rows: {
          ...r.rows, ...generation(o), Misscheduled: String(n(st.numberMisscheduled)), Unavailable: String(n(st.numberUnavailable)),
          'Max Unavailable': String(o.spec.updateStrategy.rollingUpdate.maxUnavailable), 'Revision History Limit': String(o.spec.revisionHistoryLimit),
          'Misscheduled Pods': String(n(st.numberMisscheduled)), 'Unavailable Pods': String(n(st.numberUnavailable)),
        },
        pairs: { ...r.pairs, Misscheduled: String(n(st.numberMisscheduled)), Unavailable: String(n(st.numberUnavailable)) },
        counts: { Pods: matching(s, o.spec.selector.matchLabels).length },
      }
    },
  })),
  ...['num-done', 'num-fail'].map((name): Target => ({
    kind: 'Job', ref: `${NS}/${name}`, want: (s) => {
      const o = one(s, 'Job', name)
      const done = (o.status.conditions ?? []).find((c: Obj) => (c.type === 'Complete' || c.type === 'Failed') && c.status === 'True')
      const kube = s.jobTable.find((r) => r._name === name) ?? {}
      return {
        rows: {
          Completions: String(o.spec.completions), Parallelism: String(o.spec.parallelism), Active: String(n(o.status.active)),
          Succeeded: String(n(o.status.succeeded)), Failed: String(n(o.status.failed)), Status: done?.type ?? '-',
          'Backoff Limit': String(o.spec.backoffLimit), 'Completion Mode': o.spec.completionMode, Suspend: yesNo(o.spec.suspend),
          ...(o.status.completionTime ? { Duration: kube.Duration } : {}),
        },
        // a Job not complete (num-fail) runs on, as kubectl's printJob counts it: start to now
        spans: {
          Duration: since(o.status.startTime, o.status.completionTime), 'Start Time': since(o.status.startTime),
          ...(o.status.completionTime ? { 'Completion Time': since(o.status.completionTime) } : {}),
        },
        counts: { Pods: pods(s).filter((p) => p.metadata.labels?.['batch.kubernetes.io/job-name'] === name).length },
      }
    },
  })),
  {
    kind: 'CronJob', ref: `${NS}/num-cron`, want: (s) => {
      const o = one(s, 'CronJob', 'num-cron')
      return {
        rows: {
          Schedule: o.spec.schedule, Suspend: yesNo(o.spec.suspend), 'Concurrency Policy': o.spec.concurrencyPolicy,
          'Successful Jobs History': String(o.spec.successfulJobsHistoryLimit), 'Failed Jobs History': String(o.spec.failedJobsHistoryLimit),
          'Active Jobs': String((o.status.active ?? []).length),
        },
      }
    },
  },
  ...['num-db-0', 'num-crash', 'num-init'].map((name): Target => ({
    kind: 'Pod', ref: `${NS}/${name}`, want: (s) => {
      const o = one(s, 'Pod', name)
      const restarts = (s.podTable.find((r) => r._name === name)?.Restarts ?? '').replace(/\s*\(.*\)$/, '')
      return {
        rows: {
          Phase: o.status.phase, Node: o.spec.nodeName, 'Pod IP': str(o.status.podIP), 'Host IP': str(o.status.hostIP),
          'Service Account': o.spec.serviceAccountName, Restarts: restarts, 'QoS Class': o.status.qosClass, Priority: String(n(o.spec.priority)),
          'Restart Policy': o.spec.restartPolicy,
        },
        pairs: { Phase: o.status.phase, Restarts: restarts, Containers: String(o.spec.containers.length) },
        spans: { 'Start Time': since(o.status.startTime) },
        more: (d) => {
          const out = eventDifferences(d, s, name)
          // pulls in the last hour, as the section's title counts them
          const pulls = s.events.filter((e) => e.Object.endsWith(`/${name}`) && ['Pulling', 'Pulled'].includes(e.Reason)).length
          const title = /Image Pull History \((\d+), last 1h\)/.exec(d.text)
          if (Number(title?.[1] ?? 0) !== pulls) out.push(`Image Pull History: drawer ${title?.[1] ?? 'none'}, kubectl ${pulls} pull events in the last hour`)
          return out
        },
      }
    },
  })),
  {
    kind: 'Namespace', ref: NS, want: (s) => {
      const ns = s.namespace
      const all = pods(s)
      const live = all.filter((p) => !terminal(p))
      const quota = one(s, 'ResourceQuota', 'num-quota')
      const used = quota.status?.used ?? {}
      const phases: Record<string, string> = {}
      for (const p of all) phases[p.status.phase] = String(Number(phases[p.status.phase] ?? 0) + 1)
      return {
        rows: { Status: ns.status.phase },
        pairs: {
          Status: ns.status.phase, Labels: String(Object.keys(ns.metadata.labels ?? {}).length), Annotations: String(Object.keys(ns.metadata.annotations ?? {}).length),
          Quotas: String((s.by.ResourceQuota ?? []).length), LimitRanges: String((s.by.LimitRange ?? []).length), Pods: String(all.length),
        },
        counts: { Pods: all.length },
        more: (d) => {
          const out: string[] = []
          // the Resource Summary sums what the ResourceQuota counts used: the pods not finished, init and sidecar containers in
          const title = /sum across (\d+) pods/.exec(d.text)
          if (Number(title?.[1]) !== live.length) out.push(`Resource Summary: sum across ${title?.[1] ?? 'none'} pods, ${live.length} not finished`)
          const sum = table(d, 'Resource', 'Requests', 'Limits')[0]?.rows ?? []
          const cpu = sum.find((r) => r[0] === 'CPU')
          const mem = sum.find((r) => r[0] === 'Memory')
          for (const [label, screen, cluster, unit] of [['CPU requests', cpu?.[1], used['requests.cpu'], 'cores'], ['CPU limits', cpu?.[2], used['limits.cpu'], 'cores'],
            ['Memory requests', mem?.[1], used['requests.memory'], 'bytes'], ['Memory limits', mem?.[2], used['limits.memory'], 'bytes']] as const) {
            if (!near(screen, cluster, unit)) out.push(`Resource Summary ${label}: drawer ${screen ?? 'none'}, quota used ${cluster ?? 'none'}`)
          }
          const sorted = (o: Record<string, string>) => JSON.stringify(Object.entries(o).sort())
          if (sorted(d.phases) !== sorted(phases)) out.push(`phases: drawer ${JSON.stringify(d.phases)}, cluster ${JSON.stringify(phases)}`)
          // the Resource Quotas section: status.hard and status.used, as kubectl describe quota
          const rq = table(d, 'Resource', 'Used', 'Hard').find((t) => t.head.length === 3)?.rows ?? []
          const wantRq = Object.keys(quota.status?.hard ?? {}).sort().map((k) => [k, str(used[k]), quota.status.hard[k]])
          if (JSON.stringify(rq) !== JSON.stringify(wantRq)) out.push(`Resource Quotas: drawer ${JSON.stringify(rq)}, quota ${JSON.stringify(wantRq)}`)
          return out
        },
      }
    },
  },
  {
    kind: 'Node', ref: NODE, want: (s) => {
      const o = s.node
      const ready = (o.status.conditions ?? []).find((c: Obj) => c.type === 'Ready')?.status === 'True'
      const roles = Object.keys(o.metadata.labels ?? {}).filter((k) => k.startsWith('node-role.kubernetes.io/')).map((k) => k.split('/')[1])
      return {
        rows: { 'Pod CIDR': str(o.spec.podCIDR), Scheduling: o.spec.unschedulable ? 'Disabled' : 'Enabled' },
        pairs: { Ready: yesNo(ready), Taints: String((o.spec.taints ?? []).length), Conditions: String((o.status.conditions ?? []).length), Roles: roles.join(', ') || 'worker' },
        counts: { Images: (o.status.images ?? []).length },
        more: (d) => {
          const out: string[] = []
          const cap = table(d, 'Resource', 'Allocatable', 'Capacity')[0]?.rows ?? []
          for (const k of Object.keys(o.status.capacity)) {
            const row = cap.find((r) => r[0] === k)
            if (!row || !near(row[1], o.status.allocatable[k], unitOf(k)) || !near(row[2], o.status.capacity[k], unitOf(k))) out.push(`${k}: drawer ${JSON.stringify(row ?? null)}, node allocatable ${o.status.allocatable[k]} capacity ${o.status.capacity[k]}`)
          }
          // the pods list is paged: its total is the pods on the node, and the page shows pods that are on it
          const podTable = table(d, 'Name', 'Namespace', 'Ready', 'Status')[0]
          const onNode = s.nodePods.map((p) => `${p.metadata.namespace}/${p.metadata.name}`)
          const strangers = (podTable?.rows ?? []).map((r) => `${r[1]}/${r[0]}`).filter((x) => !onNode.includes(x))
          if (podTable?.total !== onNode.length || strangers.length) out.push(`pods on the node: drawer total ${podTable?.total ?? 'none'} (not on the node: ${strangers.join(', ') || 'none'}), node ${onNode.length}`)
          return out
        },
      }
    },
  },
  ...['num-web', 'num-nodeport'].map((name): Target => ({
    kind: 'Service', ref: `${NS}/${name}`, want: (s) => {
      const o = one(s, 'Service', name)
      const slices = (s.by.EndpointSlice ?? []).filter((e) => e.metadata.labels?.['kubernetes.io/service-name'] === name)
      const eps = slices.flatMap((e) => e.endpoints ?? [])
      const addrs = (ready: boolean) => eps.filter((e: Obj) => (e.conditions?.ready ?? true) === ready).flatMap((e: Obj) => e.addresses).sort().join(', ') || '-'
      const ports = o.spec.ports.map((p: Obj) => `${p.protocol} ${p.port}->${p.targetPort}${p.nodePort ? ` node:${p.nodePort}` : ''}`).join(', ')
      return {
        rows: {
          Type: o.spec.type, 'Cluster IP': o.spec.clusterIP, 'Session Affinity': o.spec.sessionAffinity, 'Internal Traffic Policy': o.spec.internalTrafficPolicy,
          'External Traffic Policy': str(o.spec.externalTrafficPolicy), 'IP Family Policy': o.spec.ipFamilyPolicy, Summary: ports,
        },
        pairs: { Ready: String(eps.filter((e: Obj) => e.conditions?.ready ?? true).length), 'Not Ready': String(eps.filter((e: Obj) => !(e.conditions?.ready ?? true)).length), Slices: String(slices.length) },
        counts: { 'Matching Pods': matching(s, o.spec.selector).length },
        more: (d) => {
          const out: string[] = []
          for (const [label, ready] of [['Ready Addresses', true], ['Not Ready Addresses', false]] as const) {
            const shown = (d.rows.find((r) => r[0] === label)?.[1] ?? '').split(/,\s*/).filter((x) => x && x !== '-').sort().join(', ') || '-'
            if (shown !== addrs(ready)) out.push(`${label}: drawer ${shown}, EndpointSlices ${addrs(ready)}`)
          }
          return out
        },
      }
    },
  })),
  {
    kind: 'Ingress', ref: `${NS}/num-ing`, want: (s) => {
      const o = one(s, 'Ingress', 'num-ing')
      const want = o.spec.rules.flatMap((r: Obj) => r.http.paths.map((p: Obj) => [p.path, p.pathType, `${p.backend.service.name}:${p.backend.service.port.number}`].join(' '))).sort()
      return {
        more: (d) => {
          const got = table(d, 'Path', 'Type', 'Backend').flatMap((t) => t.rows.map((r) => r.join(' '))).sort()
          return JSON.stringify(got) === JSON.stringify(want) ? [] : [`rules: drawer ${JSON.stringify(got)}, cluster ${JSON.stringify(want)}`]
        },
      }
    },
  },
  {
    kind: 'NetworkPolicy', ref: `${NS}/num-np`, want: (s) => {
      const o = one(s, 'NetworkPolicy', 'num-np')
      return { rows: { 'Policy Types': o.spec.policyTypes.join(', ') }, counts: { 'Affected Pods': matching(s, o.spec.podSelector.matchLabels).length } }
    },
  },
  ...['data-num-db-0', 'num-unbound'].map((name): Target => ({
    kind: 'PersistentVolumeClaim', ref: `${NS}/${name}`, want: (s) => {
      const o = one(s, 'PersistentVolumeClaim', name)
      const usedBy = pods(s).filter((p) => (p.spec.volumes ?? []).some((v: Obj) => v.persistentVolumeClaim?.claimName === name)).length
      return {
        rows: {
          Status: o.status.phase, Capacity: str(o.status.capacity?.storage), Requested: o.spec.resources.requests.storage,
          'Access Modes': o.spec.accessModes.join(', '), 'Storage Class': str(o.spec.storageClassName), 'Volume Mode': o.spec.volumeMode,
          'Volume Name': str(o.spec.volumeName), 'Selected Node': str(o.metadata.annotations?.['volume.kubernetes.io/selected-node']),
        },
        ...(o.status.phase === 'Bound' ? { counts: { 'Used By Pods': usedBy } } : {}),
      }
    },
  })),
  {
    kind: 'ConfigMap', ref: `${NS}/num-cm`, want: (s) => {
      const o = one(s, 'ConfigMap', 'num-cm')
      const keys = Object.keys({ ...o.data, ...o.binaryData }).length
      return { rows: { 'Data Keys': String(keys) }, counts: { Data: keys, 'Used By Pods': podsUsing(s, 'configMap', 'num-cm').length } }
    },
  },
  {
    kind: 'Secret', ref: `${NS}/num-secret`, want: (s) => {
      const o = one(s, 'Secret', 'num-secret')
      const keys = Object.keys(o.data ?? {}).length
      const sas = (s.by.ServiceAccount ?? []).filter((sa) => [...(sa.secrets ?? []), ...(sa.imagePullSecrets ?? [])].some((r: Obj) => r.name === 'num-secret')).length
      return { rows: { Type: o.type, 'Data Keys': String(keys) }, counts: { Data: keys, 'Used By Pods': podsUsing(s, 'secret', 'num-secret').length, 'Used By ServiceAccounts': sas } }
    },
  },
  {
    kind: 'ServiceAccount', ref: `${NS}/num-sa`, want: (s) => {
      const o = one(s, 'ServiceAccount', 'num-sa')
      return { rows: { Secrets: String((o.secrets ?? []).length) }, counts: { 'Pods Using This ServiceAccount': pods(s).filter((p) => p.spec.serviceAccountName === 'num-sa').length } }
    },
  },
  {
    kind: 'Role', ref: `${NS}/num-role`, want: (s) => {
      const o = one(s, 'Role', 'num-role')
      const refs = (s.by.RoleBinding ?? []).filter((rb) => rb.roleRef.kind === 'Role' && rb.roleRef.name === 'num-role').length
      return { rows: { 'Rules Count': String(o.rules.length) }, counts: { 'Referenced By RoleBindings': refs } }
    },
  },
  {
    kind: 'RoleBinding', ref: `${NS}/num-rb`, want: (s) => {
      const o = one(s, 'RoleBinding', 'num-rb')
      const sas = o.subjects.filter((x: Obj) => x.kind === 'ServiceAccount' && (x.namespace ?? NS) === NS).map((x: Obj) => x.name)
      return {
        rows: { Kind: ['RoleBinding', o.roleRef.kind], Name: ['num-rb', o.roleRef.name], 'API Group': o.roleRef.apiGroup },
        counts: { Subjects: o.subjects.length, 'Bound Pods via ServiceAccount Subjects': pods(s).filter((p) => sas.includes(p.spec.serviceAccountName ?? 'default')).length },
      }
    },
  },
  {
    kind: 'HorizontalPodAutoscaler', ref: `${NS}/num-hpa`, want: (s) => {
      const o = one(s, 'HorizontalPodAutoscaler', 'num-hpa')
      const v = { min: String(o.spec.minReplicas), max: String(o.spec.maxReplicas), current: String(n(o.status.currentReplicas)), desired: String(n(o.status.desiredReplicas)) }
      return {
        rows: { 'Min Replicas': v.min, 'Max Replicas': v.max, 'Current Replicas': v.current, 'Desired Replicas': v.desired, Kind: o.spec.scaleTargetRef.kind, Name: ['num-hpa', o.spec.scaleTargetRef.name] },
        pairs: { Min: v.min, Max: v.max, Current: v.current, Desired: v.desired },
      }
    },
  },
  {
    kind: 'PodDisruptionBudget', ref: `${NS}/num-pdb`, want: (s) => {
      const o = one(s, 'PodDisruptionBudget', 'num-pdb')
      const st = o.status
      const v = { 'Current Healthy': String(n(st.currentHealthy)), 'Desired Healthy': String(n(st.desiredHealthy)), 'Disruptions Allowed': String(n(st.disruptionsAllowed)), 'Expected Pods': String(n(st.expectedPods)) }
      return {
        rows: { 'Min Available': str(o.spec.minAvailable), 'Max Unavailable': str(o.spec.maxUnavailable), ...v },
        pairs: v,
        counts: { 'Protected Pods': matching(s, o.spec.selector.matchLabels).length },
      }
    },
  },
  {
    kind: 'ResourceQuota', ref: `${NS}/num-quota`, want: (s) => {
      const o = one(s, 'ResourceQuota', 'num-quota')
      const hard = o.status.hard
      const used = o.status.used
      const want = Object.keys(hard).sort().map((k) => [k, used[k], hard[k], `${Math.round((qty(used[k]) / qty(hard[k])) * 100)}%`])
      return {
        pairs: { Resources: String(Object.keys(o.spec.hard).length) },
        more: (d) => {
          const got = table(d, 'Resource', 'Used', 'Hard', 'Usage %')[0]?.rows ?? []
          return JSON.stringify(got) === JSON.stringify(want) ? [] : [`quota: drawer ${JSON.stringify(got)}, cluster ${JSON.stringify(want)}`]
        },
      }
    },
  },
  {
    kind: 'LimitRange', ref: `${NS}/num-limits`, want: (s) => {
      const o = one(s, 'LimitRange', 'num-limits')
      const lim = o.spec.limits[0]
      const want = Object.keys({ ...lim.min, ...lim.max, ...lim.default, ...lim.defaultRequest }).sort().map((k) => [k, str(lim.min?.[k]), str(lim.max?.[k]), str(lim.default?.[k]), str(lim.defaultRequest?.[k])])
      // no min or max, so no pod can be outside them
      return {
        pairs: { 'Limit Types': String(o.spec.limits.length), 'Violating Pods': '0' },
        counts: { 'Violating Pods': 0 },
        more: (d) => {
          const got = (table(d, 'Resource', 'Min', 'Max', 'Default', 'Default Request')[0]?.rows ?? []).slice().sort((a, b) => a[0].localeCompare(b[0]))
          return JSON.stringify(got) === JSON.stringify(want) ? [] : [`limits: drawer ${JSON.stringify(got)}, cluster ${JSON.stringify(want)}`]
        },
      }
    },
  },
]

test.describe('number check — drawers', () => {
  test.beforeAll(async () => {
    test.setTimeout(200_000)
    kubectl('apply -f -', FIXTURE)
    // settled as for the list check, and the quota has counted the pods
    const deadline = Date.now() + 150_000
    for (;;) {
      const s = await snapshot()
      const ready = (k: string, name: string) => n(one(s, k, name)?.status?.readyReplicas)
      const jobsDone = (s.by.Job ?? []).every((j) => (j.status.conditions ?? []).some((c: Obj) => (c.type === 'Complete' || c.type === 'Failed') && c.status === 'True'))
      const crash = one(s, 'Pod', 'num-crash')?.status?.containerStatuses?.[0]?.restartCount ?? 0
      const quota = one(s, 'ResourceQuota', 'num-quota')?.status?.used ?? {}
      if (ready('Deployment', 'num-ready') === 3 && ready('StatefulSet', 'num-db') === 2 && jobsDone && crash >= 1 && quota['limits.cpu']) break
      if (Date.now() > deadline) throw new Error('fixture did not settle')
      await new Promise((r) => setTimeout(r, 2000))
    }
  })

  // the next spec (the list check) applies the same namespace: it must be gone, not terminating
  test.afterAll(() => {
    kubectl(`delete namespace ${NS} --wait=true --timeout=180s --ignore-not-found`)
  })

  test('every drawer shows the numbers the cluster has', async ({ page }) => {
    test.setTimeout(600_000)
    for (const t of TARGETS) await test.step(`${t.kind}/${t.ref}`, async () => {
      // what the drawer must show, and the object's resourceVersion wherever the drawer shows it
      const want = (s: Snap): Want => {
        const o = t.kind === 'Node' ? s.node : t.kind === 'Namespace' ? s.namespace : one(s, t.kind, t.ref.split('/')[1])
        const w = t.want(s)
        return { ...w, ifShown: { 'Resource Version': o?.metadata.resourceVersion ?? '', ...w.ifShown }, spans: { Created: since(o?.metadata.creationTimestamp), ...w.spans } }
      }
      // the cluster read before and after the drawer, so a value that moves (a crashing pod's restarts) matches one of them
      const diff = async () => {
        const before = await snapshot()
        const d = await readDrawer(page)
        const first = differences(d, want(before))
        return first.length ? differences(d, want(await snapshot())) : first
      }
      // a drawer shows the object as it was when it opened (it does not refresh): one that still differs after 20 s is
      // opened again, up to twice, so a value that moved meanwhile (a crashing pod restarting) is read anew
      let same = false
      for (let attempt = 0; attempt < 3 && !same; attempt++) {
        await page.goto(`/?cluster=self&detail=${encodeURIComponent(`${t.kind}/${t.ref}`)}`)
        await page.locator(DRAWER).last().waitFor({ timeout: 20_000 })
        same = await expect.poll(diff, { timeout: 20_000, intervals: [1000] }).toEqual([]).then(() => true, () => false)
      }
      if (!same) expect.soft(await diff(), `${t.kind}/${t.ref}`).toEqual([])
    })
  })
})
