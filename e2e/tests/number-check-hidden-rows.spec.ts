import { execSync } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// No row of a drawer list is out of reach: on self, lists longer than the caps the drawers had (50 rows, 20 nodes) are
// read page by page and every row compared with the cluster — a Role's RoleBindings and events, a ClusterRole's
// ClusterRoleBindings and the RoleBindings of every namespace that reference it, a webhook configuration's resources,
// the pods using a claim (from the claim and from its volume), a ServiceAccount's bindings and the storage topology's
// lines (kubectl get … -A, the API server's Table, the events kubectl describe lists). A RuntimeClass's schedulable
// nodes are read from a node list stood in for the one kind node; a namespace-scoped grant (stood in /auth/me) is told
// the RoleBindings elsewhere are not known; and the floating chat gets the ClusterRole's two binding lists whole.

const NS = 'e2e-hidden-rows'
const NS_B = 'e2e-hidden-rows-b'
const CLUSTER = 'self'
const KIND_CLUSTER = 'kubeast'
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'
const LABELS = { 'kubeast.io/e2e': 'hidden-rows' }
const RBAC = 'rbac.authorization.k8s.io'
// past the old caps of 50 and the pages of 10
const N = 55
// hr-crole's RoleBindings in NS and NS_B, one page and a bit
const GRANTS = [10, 5]
// claims bound beside hr-claim, so the cluster has more than 50 topology lines
const TOPOLOGY = 50
// nodes stood in for hr-rc's selector, past the old 20
const NODES = 24

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any
type Kubectl = (args: string, input?: string) => string
type Table = Record<string, Record<string, string>>

// self's kubectl and the API server's Table of a list (what `kubectl get` prints), through the kind cluster's
// kubeconfig; null without the kind cluster
function selfCluster(): { k: Kubectl; table: (apiPath: string) => Promise<Table> } | null {
  let kc: string
  try {
    kc = execSync(`kind get kubeconfig --name ${KIND_CLUSTER}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  } catch {
    return null
  }
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-hidden-rows-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kc, { mode: 0o600 })
  const k: Kubectl = (args, input) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim()
  const pick = (key: string) => (kc.match(new RegExp(`${key}: (\\S+)`)) ?? [])[1] ?? ''
  const server = new URL(pick('server'))
  const table = (apiPath: string) => new Promise<Table>((resolve, reject) => {
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
  return { k, table }
}

const pad = (i: number) => String(i).padStart(2, '0')
const range = (n: number) => Array.from({ length: n }, (_, i) => i)
const meta = (name: string, namespace?: string) => ({ name, ...(namespace ? { namespace } : {}), labels: LABELS })

// the objects, cluster-scoped ones named hr-*; the pods (no scheduler takes them, so they stay Pending and take nothing)
// apart, after the claim
function fixture(): { objects: Obj[]; pods: Obj[] } {
  const rb = (name: string, namespace: string, roleKind: string, role: string, subjects: Obj[]) =>
    ({ apiVersion: `${RBAC}/v1`, kind: 'RoleBinding', metadata: meta(name, namespace), roleRef: { apiGroup: RBAC, kind: roleKind, name: role }, subjects })
  const pv = (name: string, claimNs: string, claim: string) => ({
    apiVersion: 'v1', kind: 'PersistentVolume', metadata: meta(name),
    spec: { capacity: { storage: '1Mi' }, accessModes: ['ReadWriteOnce'], persistentVolumeReclaimPolicy: 'Retain', storageClassName: '', hostPath: { path: `/tmp/${name}` }, claimRef: { namespace: claimNs, name: claim } },
  })
  const pvc = (name: string, namespace: string, volume: string) => ({
    apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: meta(name, namespace),
    spec: { accessModes: ['ReadWriteOnce'], storageClassName: '', volumeName: volume, resources: { requests: { storage: '1Mi' } } },
  })
  const objects = [
    { apiVersion: 'v1', kind: 'Namespace', metadata: meta(NS) },
    { apiVersion: 'v1', kind: 'Namespace', metadata: meta(NS_B) },
    { apiVersion: 'v1', kind: 'ServiceAccount', metadata: meta('hr-sa', NS) },
    { apiVersion: `${RBAC}/v1`, kind: 'Role', metadata: meta('hr-role', NS), rules: [{ apiGroups: [''], resources: ['pods'], verbs: ['get'] }] },
    ...range(N).map((i) => rb(`hr-rb-${pad(i)}`, NS, 'Role', 'hr-role', [{ kind: 'User', apiGroup: RBAC, name: `hr-user-${pad(i)}` }, { kind: 'ServiceAccount', name: 'hr-sa', namespace: NS }])),
    { apiVersion: `${RBAC}/v1`, kind: 'ClusterRole', metadata: meta('hr-crole'), rules: [{ apiGroups: [''], resources: ['configmaps'], verbs: ['get'] }] },
    ...range(N).map((i) => ({
      apiVersion: `${RBAC}/v1`, kind: 'ClusterRoleBinding', metadata: meta(`hr-crb-${pad(i)}`),
      roleRef: { apiGroup: RBAC, kind: 'ClusterRole', name: 'hr-crole' }, subjects: [{ kind: 'Group', apiGroup: RBAC, name: `hr-group-${pad(i)}` }],
    })),
    ...[NS, NS_B].flatMap((ns, j) => range(GRANTS[j]).map((i) => rb(`hr-grant-${pad(i)}`, ns, 'ClusterRole', 'hr-crole', [{ kind: 'User', apiGroup: RBAC, name: `hr-grantee-${pad(i)}` }]))),
    // a Role of the ClusterRole's name: not a reference to the ClusterRole
    rb('hr-grant-role', NS, 'Role', 'hr-crole', [{ kind: 'User', apiGroup: RBAC, name: 'hr-other' }]),
    {
      apiVersion: 'admissionregistration.k8s.io/v1', kind: 'ValidatingWebhookConfiguration', metadata: meta('hr-vwc'),
      webhooks: [{
        name: 'r.hr.kubeast.io', admissionReviewVersions: ['v1'], sideEffects: 'None', failurePolicy: 'Ignore', timeoutSeconds: 1,
        clientConfig: { url: 'https://hr.invalid/' },
        // a group no API serves
        rules: [{ apiGroups: ['hr.kubeast.io'], apiVersions: ['v1'], operations: ['CREATE'], resources: range(N).map((i) => `r${pad(i)}`), scope: '*' }],
      }],
    },
    pv('hr-pv', NS, 'hr-claim'), pvc('hr-claim', NS, 'hr-pv'),
    ...range(TOPOLOGY).flatMap((i) => [pv(`hr-tpv-${pad(i)}`, NS_B, `hr-tpvc-${pad(i)}`), pvc(`hr-tpvc-${pad(i)}`, NS_B, `hr-tpv-${pad(i)}`)]),
    { apiVersion: 'node.k8s.io/v1', kind: 'RuntimeClass', metadata: meta('hr-rc'), handler: 'runc', scheduling: { nodeSelector: { 'hr.kubeast.io/pool': 'hr' } } },
  ]
  const pods = range(N).map((i) => ({
    apiVersion: 'v1', kind: 'Pod', metadata: meta(`hr-pod-${pad(i)}`, NS),
    spec: {
      schedulerName: 'e2e-none',
      containers: [{ name: 'app', image: 'registry.k8s.io/pause:3.10', volumeMounts: [{ name: 'data', mountPath: '/data' }] }],
      volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'hr-claim' } }],
    },
  }))
  return { objects, pods }
}
const CLUSTER_OBJECTS = ['clusterrole/hr-crole', 'validatingwebhookconfiguration/hr-vwc', 'runtimeclass/hr-rc']
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString().replace(/\.\d+Z$/, 'Z')

// A list of a drawer section as read page by page: the section's title, its notes, and per page its rows (table cells,
// or one cell per chip, link or card header) and the pager's range ("11-20 / 55", none on one page)
type Read = 'table' | 'links' | 'cards' | { chipsAfter: string }
type Walked = { title: string; notes: string[]; pages: { items: string[][]; pager: string | null }[] }

async function readSection(page: Page, title: string, what: Read) {
  return page.locator(DRAWER).last().evaluate((root, { title, what }) => {
    const txt = (el: Element) => (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim()
    const sec = [...root.querySelectorAll('div.rounded-lg.border')].find((s) => {
      const t = s.firstElementChild?.firstElementChild
      return !!t && t.tagName === 'P' && (txt(t) === title || txt(t).startsWith(`${title} (`))
    })
    if (!sec) return null
    const titleEl = sec.firstElementChild!.firstElementChild!
    let items: string[][] = []
    if (what === 'table') {
      const tb = sec.querySelector('table')
      items = tb ? [...tb.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map(txt)) : []
    } else if (what === 'links') {
      items = [...(sec.querySelector('div.flex-wrap')?.children ?? [])].map((c) => [txt(c)])
    } else if (what === 'cards') {
      items = [...sec.querySelectorAll('div.rounded-sm.border.p-2')].map((c) => [c.firstElementChild ? txt(c.firstElementChild) : txt(c)])
    } else {
      const label = [...sec.querySelectorAll('p')].find((p) => txt(p) === what.chipsAfter)
      items = [...(label?.nextElementSibling?.children ?? [])].map((c) => [txt(c)])
    }
    const pager = [...sec.querySelectorAll('span')].find((s) => /^\d+-\d+ \/ \d+$/.test(txt(s)))
    const next = pager ? [...(pager.parentElement?.querySelectorAll('button') ?? [])].find((b) => txt(b) === 'Next') as HTMLButtonElement | undefined : undefined
    return {
      title: txt(titleEl),
      // text of its own: a label, a notice ("Showing first …"), not a card's or a cell's
      notes: [...sec.querySelectorAll('p')].filter((p) => p !== titleEl && !p.closest('table') && !p.closest('div.rounded-sm.border')).map(txt),
      items,
      pager: pager ? txt(pager) : null,
      next: !!next && !next.disabled,
    }
  }, { title, what })
}

async function clickNext(page: Page, title: string) {
  await page.locator(DRAWER).last().evaluate((root, title) => {
    const txt = (el: Element) => (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim()
    const sec = [...root.querySelectorAll('div.rounded-lg.border')].find((s) => {
      const t = s.firstElementChild?.firstElementChild
      return !!t && t.tagName === 'P' && (txt(t) === title || txt(t).startsWith(`${title} (`))
    })
    const pager = sec && [...sec.querySelectorAll('span')].find((s) => /^\d+-\d+ \/ \d+$/.test(txt(s)))
    const next = pager && [...(pager.parentElement?.querySelectorAll('button') ?? [])].find((b) => txt(b) === 'Next')
    ;(next as HTMLButtonElement | undefined)?.click()
  }, title)
}

// every page of the section, Next until it is off (a list without a pager is one page)
async function walk(page: Page, title: string, what: Read): Promise<Walked | null> {
  const first = await readSection(page, title, what)
  if (!first) return null
  const pages = [{ items: first.items, pager: first.pager }]
  let cur = first
  for (let i = 0; i < 20 && cur.next; i++) {
    const before = cur.pager
    await clickNext(page, title)
    await expect.poll(async () => (await readSection(page, title, what))?.pager, { timeout: 10_000 }).not.toBe(before)
    cur = (await readSection(page, title, what))!
    pages.push({ items: cur.items, pager: cur.pager })
  }
  return { title: first.title, notes: first.notes, pages }
}

// what a section must show: the rows in pages of size with each page's range
function pagesOf(title: string, rows: string[][], size: number, notes: string[] = []): Walked {
  const pages: Walked['pages'] = []
  for (let i = 0; i < rows.length; i += size) {
    pages.push({ items: rows.slice(i, i + size), pager: rows.length > size ? `${i + 1}-${Math.min(i + size, rows.length)} / ${rows.length}` : null })
  }
  return { title, notes, pages: pages.length ? pages : [{ items: [], pager: null }] }
}

// A time a cell shows is written in the expected value as "@<RFC 3339>"; a shown age within 15 s or 15 % of it reads
// the same, so the rest compares with toEqual (number-check-rbac-drawers.spec.ts)
function seconds(s: string): number {
  const units: Record<string, number> = { y: 31536000, d: 86400, h: 3600, m: 60, s: 1 }
  let total = 0
  for (const m of s.matchAll(/(\d+)([ydhms])/g)) total += Number(m[1]) * units[m[2]]
  return /\d/.test(s) ? total : NaN
}
function settle(got: unknown, want: unknown): unknown {
  if (typeof want === 'string' && typeof got === 'string' && want.startsWith('@') && !Number.isNaN(Date.parse(want.slice(1)))) {
    const since = (Date.now() - Date.parse(want.slice(1))) / 1000
    return Math.abs(seconds(got) - since) <= Math.max(15, since * 0.15) ? want : got
  }
  if (Array.isArray(got)) return got.map((g, i) => settle(g, Array.isArray(want) ? want[i] : undefined))
  if (got && typeof got === 'object') {
    const w = (want && typeof want === 'object' ? want : {}) as Record<string, unknown>
    return Object.fromEntries(Object.entries(got).map(([key, v]) => [key, settle(v, w[key])]))
  }
  return got
}

const subjectsText = (b: Obj) => ((b.subjects ?? []).length ? b.subjects.map((s: Obj) => `${s.kind || '?'}/${s.name || '-'}`).join(', ') : '-')
// namespace/name in byte order, as the API lists objects of every namespace
const byKey = (a: Obj, b: Obj) => {
  const [x, y] = [`${a.metadata.namespace ?? ''}/${a.metadata.name}`, `${b.metadata.namespace ?? ''}/${b.metadata.name}`]
  return x < y ? -1 : x > y ? 1 : 0
}

async function openDrawer(page: Page, ref: string) {
  await page.goto(`/?cluster=${CLUSTER}&detail=${encodeURIComponent(ref)}`)
  await page.locator(DRAWER).last().waitFor({ timeout: 20_000 })
}

// the section once its title reads as expected (20 s), then every page against the cluster's rows
async function compare(page: Page, want: Walked, what: Read) {
  try {
    await expect.poll(async () => (await readSection(page, want.title.replace(/ \(.*$/, ''), what))?.title, { timeout: 20_000 }).toBe(want.title)
  } catch {
    // compared below with what it shows
  }
  const got = await walk(page, want.title.replace(/ \(.*$/, ''), what)
  expect.soft(settle(got, want), want.title).toEqual(want)
}

test.describe('number check — no drawer row out of reach', () => {
  test('lists past their old caps show every row page by page, as the cluster has them', async ({ page }) => {
    test.setTimeout(900_000)
    const c = selfCluster()
    test.skip(!c, `needs the kind cluster ${KIND_CLUSTER} (self)`)
    const { k, table } = c!
    const cleanup = () => {
      k(`delete namespace ${NS} ${NS_B} --wait=true --timeout=180s --ignore-not-found`)
      k(`delete ${CLUSTER_OBJECTS.join(' ')} --ignore-not-found --wait=true`)
      k('delete clusterrolebindings,persistentvolumes -l kubeast.io/e2e=hidden-rows --ignore-not-found --wait=true --timeout=180s')
    }
    cleanup()
    try {
      const { objects, pods } = fixture()
      k('apply --server-side --field-manager=e2e-hidden-rows -f -', JSON.stringify({ apiVersion: 'v1', kind: 'List', items: objects }))
      k('apply --server-side --field-manager=e2e-hidden-rows -f -', JSON.stringify({ apiVersion: 'v1', kind: 'List', items: pods }))
      k(`wait --for=jsonpath='{.status.phase}'=Bound pvc --all -n ${NS_B} --timeout=180s`)
      k(`wait --for=jsonpath='{.status.phase}'=Bound pvc/hr-claim -n ${NS} --timeout=180s`)
      // 55 events about hr-role, a minute apart, newest first on screen
      const roleUid = JSON.parse(k(`get role hr-role -n ${NS} -o json`)).metadata.uid
      const events = range(N).map((i) => ({
        apiVersion: 'v1', kind: 'Event', metadata: { name: `hr-role.hrseen${pad(i)}`, namespace: NS, labels: LABELS },
        involvedObject: { apiVersion: `${RBAC}/v1`, kind: 'Role', name: 'hr-role', namespace: NS, uid: roleUid },
        reason: `HrSeen${pad(i)}`, message: `seen ${i} by the hidden rows check`, type: i % 4 === 0 ? 'Warning' : 'Normal', count: (i % 3) + 1,
        firstTimestamp: ago((i + 1) * 60 + 30), lastTimestamp: ago((i + 1) * 60), source: { component: 'e2e-hidden-rows' },
      }))
      k('create -f -', JSON.stringify({ apiVersion: 'v1', kind: 'List', items: events }))

      await test.step('Role hr-role: its RoleBindings and its events', async () => {
        const rbs: Obj[] = JSON.parse(k(`get rolebindings -n ${NS} -o json`)).items.filter((b: Obj) => b.roleRef.kind === 'Role' && b.roleRef.name === 'hr-role').sort(byKey)
        const evs: Obj[] = JSON.parse(k(`get events -n ${NS} --field-selector involvedObject.name=hr-role,involvedObject.kind=Role -o json`)).items
          .filter((e: Obj) => e.involvedObject.uid === roleUid)
          .sort((a: Obj, b: Obj) => Date.parse(b.lastTimestamp) - Date.parse(a.lastTimestamp))
        expect(rbs, 'kubectl lists the RoleBindings of hr-role').toHaveLength(N)
        await openDrawer(page, `Role/${NS}/hr-role`)
        await compare(page, pagesOf(`Referenced By RoleBindings (${rbs.length})`, rbs.map((b) => [b.metadata.name, subjectsText(b)]), 10), 'table')
        await compare(page, pagesOf('Events', evs.map((e) => [e.type, e.reason, e.message, `@${e.lastTimestamp}`, String(e.count)]), 10), 'table')
      })

      // the ClusterRole's ClusterRoleBindings and the RoleBindings of every namespace, as kubectl lists them
      const crbs: Obj[] = JSON.parse(k('get clusterrolebindings -o json')).items.filter((b: Obj) => b.roleRef.kind === 'ClusterRole' && b.roleRef.name === 'hr-crole').sort(byKey)
      const grants: Obj[] = JSON.parse(k('get rolebindings -A -o json')).items.filter((b: Obj) => b.roleRef.kind === 'ClusterRole' && b.roleRef.name === 'hr-crole').sort(byKey)
      await test.step('ClusterRole hr-crole: its ClusterRoleBindings and the RoleBindings of every namespace', async () => {
        expect(crbs.length, 'kubectl lists the ClusterRoleBindings of hr-crole').toBe(N)
        expect(grants.length, 'kubectl lists the RoleBindings of hr-crole, not the one of a Role named so').toBe(GRANTS[0] + GRANTS[1])
        await openDrawer(page, 'ClusterRole/hr-crole')
        await compare(page, pagesOf(`Referenced By ClusterRoleBindings (${crbs.length})`, crbs.map((b) => [b.metadata.name, subjectsText(b)]), 10), 'table')
        await compare(page, pagesOf(`Referenced By RoleBindings (${grants.length})`, grants.map((b) => [b.metadata.namespace, b.metadata.name, subjectsText(b)]), 10), 'table')
      })

      await test.step('ValidatingWebhookConfiguration hr-vwc: every resource its rules reach', async () => {
        const o = JSON.parse(k('get validatingwebhookconfiguration hr-vwc -o json'))
        const resources = new Set<string>()
        const ops = new Set<string>()
        for (const wh of o.webhooks) for (const r of wh.rules ?? []) {
          for (const g of (r.apiGroups ?? []).length ? r.apiGroups : ['']) for (const res of r.resources ?? []) resources.add(`${g || '""'}/${res}`)
          for (const op of r.operations ?? []) ops.add(op)
        }
        const affected = [...resources].sort()
        await openDrawer(page, 'ValidatingWebhookConfiguration/hr-vwc')
        await compare(page, pagesOf(`Affected Resources (${affected.length} kinds, ${ops.size} ops)`, affected.map((r) => [r]), 50, ['Resource Types (apiGroup/resource)', 'Operations']), { chipsAfter: 'Resource Types (apiGroup/resource)' })
      })

      await test.step('PersistentVolumeClaim hr-claim and PersistentVolume hr-pv: every pod using the claim', async () => {
        const podTable = await table(`/api/v1/namespaces/${NS}/pods`)
        // kubectl's getPodsForPVC: the pods naming the claim (kubectl describe pvc lists them by name)
        const users: Obj[] = JSON.parse(k(`get pods -n ${NS} -o json`)).items
          .filter((p: Obj) => (p.spec.volumes ?? []).some((v: Obj) => v.persistentVolumeClaim?.claimName === 'hr-claim')).sort(byKey)
        expect(users, 'kubectl lists the pods using hr-claim').toHaveLength(N)
        const rows = users.map((p) => {
          const r = podTable[p.metadata.name] ?? {}
          return [p.metadata.name, r.Status || '-', r.Ready || '-', (r.Restarts ?? '').replace(/\s*\(.*\)$/, '') || '-', p.spec.nodeName || '-',
            (p.spec.volumes ?? []).filter((v: Obj) => v.persistentVolumeClaim?.claimName === 'hr-claim').map((v: Obj) => v.name).join(', '), `@${p.metadata.creationTimestamp}`]
        })
        for (const ref of [`PersistentVolumeClaim/${NS}/hr-claim`, 'PersistentVolume/hr-pv']) {
          await openDrawer(page, ref)
          await compare(page, pagesOf(`Used By Pods (${users.length})`, rows, 10), 'table')
        }
      })

      await test.step('ServiceAccount hr-sa: every binding of it', async () => {
        const bindsSa = (b: Obj) => (b.subjects ?? []).some((s: Obj) => s.kind === 'ServiceAccount' && s.name === 'hr-sa' && (s.namespace || b.metadata.namespace) === NS)
        const rbs: Obj[] = JSON.parse(k(`get rolebindings -n ${NS} -o json`)).items.filter(bindsSa).sort(byKey)
        const crbsOfSa: Obj[] = JSON.parse(k('get clusterrolebindings -o json')).items.filter(bindsSa).sort(byKey)
        const all = [...rbs, ...crbsOfSa]
        expect(all, 'kubectl lists the bindings of hr-sa').toHaveLength(N)
        await openDrawer(page, `ServiceAccount/${NS}/hr-sa`)
        await compare(page, pagesOf(`Effective Permissions (${all.length} bindings)`, all.map((b) => [`via ${b.metadata.name} → ${b.roleRef.name}`]), 5), 'cards')
      })

      await test.step('Storage analysis: every line of the topology', async () => {
        const pvcs: Obj[] = JSON.parse(k('get pvc -A -o json')).items
        const pvs: Obj[] = JSON.parse(k('get pv -o json')).items
        const lines = pvcs.filter((p) => p.spec.volumeName).map((p) => `pvc-${p.metadata.namespace}-${p.metadata.name} → pv-${p.spec.volumeName} · bound to`).sort()
        expect(lines.length, 'the cluster has more than 50 bound claims').toBeGreaterThan(50)
        const want = { summary: `Nodes: ${pvs.length + pvcs.length} · Edges: ${lines.length}`, lines, notes: [] as string[] }
        await page.goto(`/?cluster=${CLUSTER}`)
        await page.locator('button').filter({ hasText: /Storage analysis/ }).first().click()
        // the window's own tab (the innermost box holding its title)
        const storageWindow = page.locator('div.rounded-lg', { has: page.locator('h2', { hasText: /^Storage analysis$/ }) }).last()
        await storageWindow.locator('button', { hasText: /^Topology$/ }).click()
        const shown = () => page.evaluate(() => {
          const txt = (el: Element) => (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim()
          const modal = [...document.querySelectorAll('h2')].find((h) => txt(h) === 'Storage analysis')?.closest('div.rounded-lg')
          if (!modal) return null
          const ps = [...modal.querySelectorAll('p')].map(txt)
          return {
            summary: ps.find((t) => t.startsWith('Nodes: ')) ?? null,
            lines: [...modal.querySelectorAll('div.divide-y p.text-xs')].map(txt).filter((t) => t.includes(' → ')).sort(),
            notes: ps.filter((t) => /edges/i.test(t) && !t.startsWith('Nodes: ')),
          }
        })
        try {
          await expect.poll(shown, { timeout: 30_000 }).toEqual(want)
        } catch {
          expect.soft(await shown(), 'storage topology').toEqual(want)
        }
      })

      await test.step('RuntimeClass hr-rc: every node its selector matches (the node list stood in)', async () => {
        const o = JSON.parse(k('get runtimeclass hr-rc -o json'))
        const selector: Record<string, string> = o.scheduling.nodeSelector
        let stood: Obj[] = []
        await page.route(/\/api\/v1\/cluster\/nodes(\?|$)/, async (route) => {
          const real = await (await route.fetch()).json() as Obj[]
          stood = [...real, ...range(NODES).map((i) => ({ ...real[0], name: `hr-node-${pad(i)}`, labels: { ...(real[0]?.labels ?? {}), ...selector } }))]
          return route.fulfill({ json: stood })
        })
        try {
          await openDrawer(page, 'RuntimeClass/hr-rc')
          await expect.poll(() => stood.length, { timeout: 20_000 }).toBeGreaterThan(NODES)
          const matching = stood.filter((n) => Object.entries(selector).every(([key, v]) => n.labels?.[key] === v)).map((n) => [String(n.name)])
          await compare(page, pagesOf(`Nodes Matching scheduling.nodeSelector (${matching.length})`, matching, 20), 'links')
        } finally {
          await page.unroute(/\/api\/v1\/cluster\/nodes(\?|$)/)
        }
      })

      await test.step('ClusterRole hr-crole for a namespace-scoped grant: the RoleBindings elsewhere are not known', async () => {
        const scope = [NS, NS_B]
        await page.route(/\/api\/v1\/auth\/me(\?|$)/, async (route) => {
          const res = await route.fetch()
          const me = await res.json()
          return route.fulfill({ response: res, json: { ...me, cluster_namespaces: { ...(me.cluster_namespaces ?? {}), [CLUSTER]: scope } } })
        })
        try {
          await openDrawer(page, 'ClusterRole/hr-crole')
          const note = `Your access to this cluster covers only the namespaces ${scope.join(', ')}, so only RoleBindings there are listed; how many RoleBindings in other namespaces reference this ClusterRole is not known.`
          const notes = async () => (await readSection(page, 'Referenced By RoleBindings', 'table'))?.notes ?? null
          try {
            await expect.poll(notes, { timeout: 20_000 }).toEqual([note])
          } catch {
            expect.soft(await notes(), 'the note of a namespace-scoped grant').toEqual([note])
          }
        } finally {
          await page.unroute(/\/api\/v1\/auth\/me(\?|$)/)
        }
      })

      await test.step('ClusterRole hr-crole: the floating chat gets both binding lists whole', async () => {
        const sent: { base?: Obj; overlays?: Obj[] }[] = []
        await page.route(/\/api\/v1\/sessions(\?|$)/, (route) =>
          route.request().method() === 'POST'
            ? route.fulfill({ json: { id: 'e2e-hr-ctx-1', title: 'New Chat', created_at: '', updated_at: '', message_count: 0 } })
            : route.fallback())
        await page.route(/\/api\/v1\/sessions\/e2e-hr-ctx-\d+(\?|$)/, (route) =>
          route.fulfill({ json: { id: 'e2e-hr-ctx-1', title: 'New Chat', created_at: '', updated_at: '', messages: [] } }))
        await page.route(/\/api\/v1\/ai\/sessions\/e2e-hr-ctx-\d+\/floating-chat/, (route) => {
          sent.push(route.request().postDataJSON().page_context)
          return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"content":"ok"}\n\ndata: [DONE]\n\n' })
        })
        const ask = async () => {
          if ((await page.getByTestId('floating-chat-panel').count()) === 0) await page.getByTestId('floating-chat-toggle').click()
          const input = page.getByTestId('floating-chat-input')
          await expect(input).toBeVisible()
          const before = sent.length
          await input.fill('what is on this screen?')
          await input.press('Enter')
          await expect.poll(() => sent.length).toBe(before + 1)
          await expect(page.getByTestId('floating-chat-panel').getByRole('button', { name: 'Send' })).toBeVisible()
          const ctx = sent[sent.length - 1]
          const layer = [ctx.base, ...(ctx.overlays ?? [])].find((l) => l?.source === 'ClusterRoleInfo')
          const d = layer?.data ?? {}
          return {
            referenced_by_cluster_role_bindings_count: d.referenced_by_cluster_role_bindings_count,
            referenced_by_cluster_role_bindings: d.referenced_by_cluster_role_bindings,
            referenced_by_role_bindings_count: d.referenced_by_role_bindings_count,
            referenced_by_role_bindings: d.referenced_by_role_bindings,
          }
        }
        const want = {
          referenced_by_cluster_role_bindings_count: crbs.length,
          referenced_by_cluster_role_bindings: crbs.map((b) => ({ name: b.metadata.name, subjects: subjectsText(b) })),
          referenced_by_role_bindings_count: grants.length,
          referenced_by_role_bindings: grants.map((b) => ({ namespace: b.metadata.namespace, name: b.metadata.name, subjects: subjectsText(b) })),
        }
        await page.goto(`/security/clusterroles?cluster=${CLUSTER}&detail=${encodeURIComponent('ClusterRole/hr-crole')}`)
        await page.locator(DRAWER).last().waitFor({ timeout: 20_000 })
        await expect.configure({ soft: true }).poll(ask, { timeout: 30_000 }).toEqual(want)
      })
    } finally {
      cleanup()
    }
  })
})
