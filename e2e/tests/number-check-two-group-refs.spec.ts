import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Locator, type Page } from '@playwright/test'

// One Kind of two groups with one name, where a screen picked by Kind and name: on default, a StatefulSet of apps/v1
// and one of a group of this run's own (as OpenKruise's Advanced StatefulSet is Kind StatefulSet of apps.kruise.io),
// both named web-<run>, each controlling its pause pods, and a hand-written PolicyReport about both and their pods. The
// Optimization window's "Apply without restart" on one row must resize that group's pods only — kubectl reads every
// pod's requests after — and each StatefulSet's drawer lists the policy violations of its own pods. On test2, an
// HTTPRoute and a GRPCRoute whose parentRefs and backendRefs name a Widget of two groups (group and Kind, no version)
// beside a Gateway and a Service: each Widget link opens that group's object at the version its CRD prefers (the
// address's detailApi, the drawer's Basic Info and spec as kubectl reads them), the Gateway and Service links as before.

const RUN = Date.now().toString(36)
const LABEL = 'kubeast.io/e2e=two-group-refs'
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'
// the screen's words as the English catalog has them
const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/en.json'), 'utf8'))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const say = (key: string, fallback: string): string => key.split('.').reduce((o: any, k) => o?.[k], EN) ?? fallback
const BASIC = say('crInstanceInfo.basicInfo', 'Basic Info')
const SPEC = say('crInstanceInfo.spec', 'Spec')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any

function kubectlFor(kindName: string): ((args: string, input?: string) => string) | null {
  let kc: string
  try {
    kc = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  } catch {
    return null
  }
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-two-group-refs-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kc, { mode: 0o600 })
  return (args, input) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim()
}

async function registered(page: Page, id: string): Promise<boolean> {
  const clusters = await (await page.request.get('/api/v1/clusters')).json()
  return (Array.isArray(clusters) ? clusters : clusters.items ?? []).some((x: Obj) => x.id === id)
}

const crd = (group: string, kind: string, plural: string, versions: { name: string; storage: boolean }[]) => ({
  apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name: `${plural}.${group}`, labels: { 'kubeast.io/e2e': 'two-group-refs' } },
  spec: {
    group, scope: 'Namespaced', names: { kind, plural, singular: kind.toLowerCase(), listKind: `${kind}List` },
    versions: versions.map((v) => ({
      name: v.name, served: true, storage: v.storage,
      subresources: { status: {}, scale: { specReplicasPath: '.spec.replicas', statusReplicasPath: '.status.replicas' } },
      schema: { openAPIV3Schema: { type: 'object', properties: { spec: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true }, status: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true } } } },
    })),
  },
})

// the server keeps a cluster's API resources for a minute: wait until it lists the kinds this run made
async function waitForKinds(page: Page, cluster: string, kinds: { groupVersion: string; plural: string }[]) {
  await expect.poll(async () => {
    const lists = await (await page.request.get(`/api/v1/cluster/api-resources?cluster=${cluster}`)).json() as { groupVersion: string; resources: { name: string }[] }[]
    return kinds.every((k) => lists.some((l) => l.groupVersion === k.groupVersion && l.resources.some((r) => r.name === k.plural)))
  }, { timeout: 75_000, message: `the API resources of ${cluster} list ${kinds.map((k) => `${k.plural}.${k.groupVersion}`).join(', ')}` }).toBe(true)
}

// A drawer as the steps read it: the address and, of a custom resource's drawer, its Basic Info rows and spec color
type View = { detail: string | null; detailApi: string | null; basic: Record<string, string>; color: string | null }

async function readView(page: Page): Promise<View> {
  const url = new URL(page.url())
  const sections = await page.locator(DRAWER).last().evaluate((root, titles) => {
    const words = (el: Element) => (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim()
    const out: Record<string, Record<string, string>> = {}
    for (const sec of root.querySelectorAll('div.rounded-lg.border')) {
      const title = sec.firstElementChild?.firstElementChild
      if (!title || title.tagName !== 'P' || !titles.includes(words(title))) continue
      const rows: Record<string, string> = {}
      for (const g of sec.querySelectorAll('div.grid')) {
        if (g.children.length === 2 && [...g.children].every((c) => c.tagName === 'SPAN') && g.children[0].classList.contains('text-slate-400')) {
          rows[words(g.children[0])] = words(g.children[1])
        }
      }
      out[words(title)] = rows
    }
    return out
  }, [BASIC, SPEC])
  const basic = sections[BASIC] ?? {}
  return {
    detail: url.searchParams.get('detail'),
    detailApi: url.searchParams.get('detailApi'),
    basic: Object.fromEntries(['Kind', 'Name', 'Namespace', 'API Version', 'CRD'].filter((k) => k in basic).map((k) => [k, basic[k]])),
    color: sections[SPEC]?.color ?? null,
  }
}

// what the drawer of a custom resource must show, from kubectl (which reads the version discovery prefers)
function wantOf(o: Obj, plural: string): View {
  const [group] = o.apiVersion.split('/')
  return {
    detail: `${o.kind}/${o.metadata.namespace}/${o.metadata.name}`,
    detailApi: o.apiVersion,
    basic: { Kind: o.kind, Name: o.metadata.name, Namespace: o.metadata.namespace, 'API Version': o.apiVersion, CRD: `${plural}.${group}` },
    color: o.spec.color,
  }
}

// a built-in kind's drawer: the address names it, without an apiVersion, as before
const builtIn = (detail: string): View => ({ detail, detailApi: null, basic: {}, color: null })

const quantity = {
  mem: (b: number) => (b % 2 ** 30 === 0 ? `${b / 2 ** 30}Gi` : b % 2 ** 20 === 0 ? `${b / 2 ** 20}Mi` : String(b)),
  cpu: (m: number) => (m % 1000 === 0 ? String(m / 1000) : `${m}m`),
}

test.describe('number check — one Kind of two groups where a screen picked by Kind and name', () => {
  test('an Optimization row resizes its own group\'s pods and a StatefulSet\'s drawer lists its own pods\' violations', async ({ page }) => {
    test.setTimeout(900_000)
    const k = kubectlFor('kubeast-b')
    test.skip(!k || !(await registered(page, 'default')), 'needs the second kind cluster (kubeast-b), registered as default')
    const kc = k!
    const features = await (await page.request.get('/api/v1/cluster/features?cluster=default')).json()
    const resize = !!features.inPlaceResize?.enabled && !!features.inPlaceResize?.serverSupports
    const polr = kc('api-resources --api-group=wgpolicyk8s.io -o name').includes('policyreports')
    test.skip(!resize && !polr, 'default has neither in-place resize (features.inPlaceResize, 1.35+) nor a PolicyReport CRD')
    const NS = `e2e-tgref-${RUN}`
    const GROUP = `tg${RUN}.kubeast.io`
    const OTHER = `${GROUP}/v1beta1`
    const STS = `web-${RUN}`
    const BUILTIN_POD = `${STS}-0`
    const OTHER_PODS = [`${STS}-x-0`, `${STS}-x-1`]
    const PODS = [BUILTIN_POD, ...OTHER_PODS]
    const REQUESTS = { cpu: '50m', memory: '200Mi' }
    const cleanup = () => {
      kc(`delete namespace -l ${LABEL} --wait=false --ignore-not-found`)
      kc(`delete crd -l ${LABEL} --ignore-not-found --wait=true --timeout=180s`)
    }
    cleanup()
    try {
      kc('apply --server-side --field-manager=e2e-two-group-refs -f -', JSON.stringify(crd(GROUP, 'StatefulSet', 'statefulsets', [{ name: 'v1beta1', storage: true }])))
      kc(`wait --for=condition=Established crd/statefulsets.${GROUP} --timeout=60s`)
      kc(`create namespace ${NS}`)
      kc(`label namespace ${NS} ${LABEL}`)
      const container = { name: 'app', image: 'registry.k8s.io/pause:3.10', imagePullPolicy: 'IfNotPresent', resources: { requests: REQUESTS } }
      kc('apply --server-side --field-manager=e2e-two-group-refs -f -', JSON.stringify({
        apiVersion: 'v1', kind: 'List', items: [
          {
            apiVersion: 'apps/v1', kind: 'StatefulSet', metadata: { name: STS, namespace: NS },
            spec: {
              replicas: 1, serviceName: STS, selector: { matchLabels: { app: STS } },
              template: { metadata: { labels: { app: STS } }, spec: { terminationGracePeriodSeconds: 0, containers: [container] } },
            },
          },
          { apiVersion: OTHER, kind: 'StatefulSet', metadata: { name: STS, namespace: NS }, spec: { replicas: 2 } },
        ],
      }))
      const other = JSON.parse(kc(`get statefulsets.${GROUP} ${STS} -n ${NS} -o json`))
      const result =(resource: Obj, message: string) => ({ policy: 'tg-refs', rule: 'check', result: 'fail', source: 'kyverno', message: `${message} ${RUN}`, resources: [resource] })
      kc('apply --server-side --field-manager=e2e-two-group-refs -f -', JSON.stringify({
        apiVersion: 'v1', kind: 'List', items: [
          ...OTHER_PODS.map((name) => ({
            apiVersion: 'v1', kind: 'Pod',
            metadata: { name, namespace: NS, labels: { app: `${STS}-x` }, ownerReferences: [{ apiVersion: OTHER, kind: 'StatefulSet', name: STS, uid: other.metadata.uid, controller: true }] },
            spec: { terminationGracePeriodSeconds: 0, containers: [container] },
          })),
          ...(polr ? [{
            apiVersion: 'wgpolicyk8s.io/v1alpha2', kind: 'PolicyReport', metadata: { name: `tg-polr-${RUN}`, namespace: NS },
            summary: { pass: 0, fail: 5, warn: 0, error: 0, skip: 0 },
            results: [
              result({ apiVersion: 'apps/v1', kind: 'StatefulSet', name: STS, namespace: NS }, 'the apps/v1 statefulset fails'),
              result({ apiVersion: OTHER, kind: 'StatefulSet', name: STS, namespace: NS }, `the ${GROUP} statefulset fails`),
              ...PODS.map((name) => result({ apiVersion: 'v1', kind: 'Pod', name, namespace: NS }, `pod ${name} fails`)),
            ],
          }] : []),
        ],
      }))
      await expect.poll(() => kc(`get pod -n ${NS} -o jsonpath={.items[*].metadata.name}`).split(' ').sort(), { timeout: 60_000 }).toEqual([...PODS].sort())
      kc(`wait --for=condition=Ready ${PODS.map((p) => `pod/${p}`).join(' ')} -n ${NS} --timeout=120s`)
      const requestsOf = () => Object.fromEntries(PODS.map((p) => [p, JSON.parse(kc(`get pod ${p} -n ${NS} -o jsonpath={.spec.containers[0].resources.requests}`))]))
      expect(requestsOf(), 'the pods start with the same requests').toEqual(Object.fromEntries(PODS.map((p) => [p, REQUESTS])))

      // each StatefulSet's drawer: the violations of the StatefulSet and of its own pods (this run's results)
      if (polr) {
        // the drawer by link (the other group's with its apiVersion, as the screens' links open it): its rows' messages of
        // this run
        const violations = async (query: string) => {
          await page.goto(`/?cluster=default&detail=${query}`)
          const shown = page.locator(DRAWER).last().getByTestId('policy-violation-row').filter({ hasText: RUN })
          return async () => (await shown.locator('td:last-child').allInnerTexts()).map((t) => t.trim()).sort()
        }
        for (const [what, query, want] of [
          ['the apps/v1 StatefulSet', encodeURIComponent(`StatefulSet/${NS}/${STS}`), ['the apps/v1 statefulset fails', `pod ${BUILTIN_POD} fails`]],
          [`the ${GROUP} StatefulSet`, `${encodeURIComponent(`StatefulSet/${NS}/${STS}`)}&detailApi=${encodeURIComponent(OTHER)}`, [`the ${GROUP} statefulset fails`, ...OTHER_PODS.map((p) => `pod ${p} fails`)]],
        ] as const) {
          await test.step(`Policy violations · ${what}`, async () => {
            const messages = await violations(query)
            const wantRows = want.map((m) => `${m} ${RUN}`).sort()
            await expect.poll(messages, { timeout: 30_000 }).toEqual(wantRows).catch(() => undefined)
            expect.soft(await messages(), `${what}: its own rows`).toEqual(wantRows)
          })
        }
      } else {
        test.info().annotations.push({ type: 'skip', description: 'Policy violations: default serves no PolicyReport' })
      }

      if (resize) {
        // the server's rows for the two StatefulSets, once the cluster's usage gives each a recommendation
        type Row = { kind: string; name: string; api_version?: string; pods: number; cpu_recommend_m?: number; mem_recommend_bytes?: number }
        const rowsOf = async () => ((await (await page.request.get(`/api/v1/cluster/optimization?namespace=${NS}&cluster=default`)).json()).rows ?? []) as Row[]
        let rows: Row[] = []
        await expect.poll(async () => {
          rows = (await rowsOf()).filter((r) => r.kind === 'StatefulSet' && r.name === STS)
          return rows.length === 2 && rows.every((r) => r.cpu_recommend_m != null && r.mem_recommend_bytes != null)
        }, { timeout: 300_000, intervals: [10_000], message: 'both StatefulSets\' Optimization rows carry a recommendation' }).toBe(true)
        const recommended = (pods: number) => {
          const r = rows.find((x) => x.pods === pods)!
          return { cpu: quantity.cpu(r.cpu_recommend_m!), memory: quantity.mem(r.mem_recommend_bytes!) }
        }

        // the Optimization window: the two rows read the same (StatefulSet/web-<run>, container app) but for their pods
        // (2 of the other group, 1 of apps/v1); Apply on one row, then kubectl reads every pod's requests
        const optimization = async () => {
          await page.goto('/?cluster=default')
          await page.locator('button').filter({ hasText: /Optimization suggestions|최적화 제안/ }).first().click()
          await page.locator('button[title="Select namespace"], button[title="Namespace 선택"]').first().click()
          await page.getByRole('button', { name: NS, exact: true }).click()
          await page.getByTestId('optimization-table').waitFor({ timeout: 30_000 })
          return page.getByTestId('optimization-row').filter({ hasText: `StatefulSet/${STS}` })
        }
        const rowOfPods = (all: Locator, pods: number) => all.filter({ has: page.locator('td:nth-child(3)', { hasText: new RegExp(`^${pods}$`) }) })
        // Apply on the row of that many pods; the resize result's "<resized>/<total>" total (null without the button)
        const apply = async (pods: number): Promise<number | null> => {
          const row = rowOfPods(await optimization(), pods)
          await expect(row, `a row of ${pods} pods`).toHaveCount(1, { timeout: 30_000 })
          const button = row.getByTestId('optimization-resize')
          // the button comes once the cluster's features have loaded; a row whose requests are its recommendation has none
          if (!(await button.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false))) return null
          await button.click()
          const dialog = page.getByRole('dialog')
          await dialog.getByRole('button', { name: say('dashboard.optimization.resize.confirm', 'Apply'), exact: true }).click()
          const text = (await row.getByTestId('optimization-resize-result').innerText({ timeout: 60_000 })).trim()
          const m = /(\d+)\/(\d+)/.exec(text)
          return m ? Number(m[2]) : null
        }

        await test.step(`Optimization · Apply on the ${GROUP} StatefulSet's row`, async () => {
          const total = await apply(2)
          expect.soft(total, 'the resize names the row\'s 2 pods').toBe(2)
          const want = { [BUILTIN_POD]: REQUESTS, ...Object.fromEntries(OTHER_PODS.map((p) => [p, recommended(2)])) }
          await expect.poll(requestsOf, { timeout: 30_000 }).toEqual(want).catch(() => undefined)
          expect.soft(requestsOf(), 'the other group\'s pods take the recommendation, the apps/v1 pod keeps its requests').toEqual(want)
        })
        await test.step('Optimization · Apply on the apps/v1 StatefulSet\'s row', async () => {
          const total = await apply(1)
          expect.soft(total, 'the resize names the row\'s 1 pod').toBe(1)
          const want = { [BUILTIN_POD]: recommended(1), ...Object.fromEntries(OTHER_PODS.map((p) => [p, recommended(2)])) }
          await expect.poll(requestsOf, { timeout: 30_000 }).toEqual(want).catch(() => undefined)
          expect.soft(requestsOf(), 'the apps/v1 pod takes the recommendation too').toEqual(want)
        })
      } else {
        test.info().annotations.push({ type: 'skip', description: 'Optimization: in-place resize is off (features.inPlaceResize) or default is older than 1.35' })
      }
    } finally {
      cleanup()
    }
  })

  test('a Route\'s parentRef and backendRef links open the group\'s object; Gateway and Service links as before', async ({ page }) => {
    test.setTimeout(600_000)
    const k = kubectlFor('test2')
    test.skip(!k || !(await registered(page, 'test2')), 'needs the kind cluster test2, registered')
    const kc = k!
    test.skip(!kc('api-resources --api-group=gateway.networking.k8s.io -o name').includes('grpcroutes'), 'test2 serves no Gateway API routes')
    const NS = `e2e-tgroute-${RUN}`
    const GROUPS = [`ra${RUN}.kubeast.io`, `rb${RUN}.kubeast.io`] as const
    const COLOR: Record<string, string> = { [GROUPS[0]]: 'amber', [GROUPS[1]]: 'blue' }
    const SECTION: Record<string, string> = { [GROUPS[0]]: 'ra', [GROUPS[1]]: 'rb' }
    const WIDGET = `rw-${RUN}`
    const SVC = `rs-${RUN}`
    const GW = `rg-${RUN}`
    const cleanup = () => {
      kc(`delete namespace -l ${LABEL} --wait=false --ignore-not-found`)
      kc(`delete crd -l ${LABEL} --ignore-not-found --wait=true --timeout=180s`)
    }
    cleanup()
    try {
      // the second group serves v1alpha1 (its storage version) and v1: discovery and kubectl prefer v1
      kc('apply --server-side --field-manager=e2e-two-group-refs -f -', JSON.stringify({
        apiVersion: 'v1', kind: 'List', items: [
          crd(GROUPS[0], 'Widget', 'widgets', [{ name: 'v1', storage: true }]),
          crd(GROUPS[1], 'Widget', 'widgets', [{ name: 'v1alpha1', storage: true }, { name: 'v1', storage: false }]),
        ],
      }))
      kc(`wait --for=condition=Established ${GROUPS.map((g) => `crd/widgets.${g}`).join(' ')} --timeout=60s`)
      kc(`create namespace ${NS}`)
      kc(`label namespace ${NS} ${LABEL}`)
      const refs = {
        parentRefs: [{ name: GW }, ...GROUPS.map((g) => ({ group: g, kind: 'Widget', name: WIDGET, sectionName: SECTION[g] }))],
        backendRefs: [{ name: SVC, port: 80 }, ...GROUPS.map((g) => ({ group: g, kind: 'Widget', name: WIDGET }))],
      }
      kc('apply --server-side --field-manager=e2e-two-group-refs -f -', JSON.stringify({
        apiVersion: 'v1', kind: 'List', items: [
          ...GROUPS.map((g) => ({ apiVersion: `${g}/v1`, kind: 'Widget', metadata: { name: WIDGET, namespace: NS }, spec: { color: COLOR[g] } })),
          { apiVersion: 'v1', kind: 'Service', metadata: { name: SVC, namespace: NS }, spec: { ports: [{ port: 80 }] } },
          {
            apiVersion: 'gateway.networking.k8s.io/v1', kind: 'Gateway', metadata: { name: GW, namespace: NS },
            spec: { gatewayClassName: `e2e-tgroute-${RUN}`, listeners: [{ name: 'http', port: 80, protocol: 'HTTP' }] },
          },
          { apiVersion: 'gateway.networking.k8s.io/v1', kind: 'HTTPRoute', metadata: { name: `rr-${RUN}`, namespace: NS }, spec: { parentRefs: refs.parentRefs, rules: [{ backendRefs: refs.backendRefs }] } },
          { apiVersion: 'gateway.networking.k8s.io/v1', kind: 'GRPCRoute', metadata: { name: `gr-${RUN}`, namespace: NS }, spec: { parentRefs: refs.parentRefs, rules: [{ backendRefs: refs.backendRefs }] } },
        ],
      }))
      const widget = (g: string) => JSON.parse(kc(`get widgets.${g} ${WIDGET} -n ${NS} -o json`))
      expect(GROUPS.map((g) => widget(g).apiVersion), 'kubectl reads each group at its preferred version').toEqual(GROUPS.map((g) => `${g}/v1`))
      await waitForKinds(page, 'test2', GROUPS.map((g) => ({ groupVersion: `${g}/v1`, plural: 'widgets' })))

      // a Widget link taken off the page (a link that blinks while its version is looked up) is counted
      await page.addInitScript((name) => {
        const w = window as unknown as { refLinkRemovals: number }
        w.refLinkRemovals = 0
        new MutationObserver((records) => {
          for (const r of records) {
            for (const n of r.removedNodes) {
              if (n instanceof HTMLElement && [...(n.matches('button') ? [n] : n.querySelectorAll('button'))].some((b) => b.textContent === name)) w.refLinkRemovals++
            }
          }
        }).observe(document, { childList: true, subtree: true })
      }, WIDGET)
      const removals = () => page.evaluate(() => (window as unknown as { refLinkRemovals: number }).refLinkRemovals)

      for (const route of [{ kind: 'HTTPRoute', name: `rr-${RUN}` }, { kind: 'GRPCRoute', name: `gr-${RUN}` }]) {
        // the route's drawer by link, with its links drawn; the CRD list a Widget link looks its version up in has come
        // (none comes on a screen that does not ask — then after 10 s, as it is) and no Widget link left the page meanwhile
        const openRoute = async () => {
          const crds = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/cluster/crds', { timeout: 10_000 }).catch(() => null)
          await page.goto(`/?cluster=test2&detail=${encodeURIComponent(`${route.kind}/${NS}/${route.name}`)}`)
          const drawer = page.locator(DRAWER).last()
          await drawer.getByRole('button', { name: SVC, exact: true }).waitFor({ timeout: 30_000 })
          await page.evaluate(() => { (window as unknown as { refLinkRemovals: number }).refLinkRemovals = 0 })
          await crds
          // two frames: the links drawn again with the list's answer
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
          expect.soft(await removals(), `${route.kind}: the Widget links stay in place while their version is looked up`).toBe(0)
          return drawer
        }
        // the drawer a link opens, read until it equals the object's (20 s), else its difference kept
        const follow = async (what: string, link: (drawer: Locator) => Locator, want: () => View) => {
          await test.step(`${route.kind} · ${what}`, async () => {
            try {
              await link(await openRoute()).click({ timeout: 30_000 })
              await expect.poll(() => new URL(page.url()).searchParams.get('detail'), { timeout: 20_000 }).not.toBe(`${route.kind}/${NS}/${route.name}`)
              await expect.poll(() => readView(page), { timeout: 20_000 }).toEqual(want()).catch(() => undefined)
              expect.soft(await readView(page), what).toEqual(want())
            } catch (e) {
              expect.soft(String(e), `${what}: the link opened a drawer`).toBe('')
            }
          })
        }
        const backendRow = (drawer: Locator, group: string) => drawer.locator('table').filter({ has: page.locator('th', { hasText: /^Weight$/ }) })
          .locator('tbody tr').filter({ has: page.locator('td:nth-child(4)', { hasText: new RegExp(`^${group.replace(/\./g, '\\.')}$`) }) })
        const parentLink = (drawer: Locator, section: string) => route.kind === 'HTTPRoute'
          ? drawer.locator('div.rounded-sm.border').filter({ hasText: `section=${section}` }).getByRole('button', { name: WIDGET, exact: true })
          : drawer.locator('table').filter({ has: page.locator('th', { hasText: /^Section$/ }) }).locator('tbody tr')
            .filter({ has: page.locator('td:nth-child(5)', { hasText: new RegExp(`^${section}$`) }) }).getByRole('button', { name: WIDGET, exact: true })

        for (const g of GROUPS) {
          await follow(`parentRef Widget.${g}`, (d) => parentLink(d, SECTION[g]), () => wantOf(widget(g), 'widgets'))
          await follow(`backendRef Widget.${g}`, (d) => backendRow(d, g).getByRole('button', { name: WIDGET, exact: true }), () => wantOf(widget(g), 'widgets'))
        }
        await follow('parentRef Gateway', (d) => d.getByRole('button', { name: GW, exact: true }), () => builtIn(`Gateway/${NS}/${GW}`))
        await follow('backendRef Service', (d) => d.getByRole('button', { name: SVC, exact: true }), () => builtIn(`Service/${NS}/${SVC}`))
      }
    } finally {
      cleanup()
    }
  })
})
