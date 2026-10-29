import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// Resource Graph pod groups (group_pods): the healthy pods of an owner with more than 10 pods and the same lines
// are one box whose lines stand for every pod, a failing pod stays a box of its own, a StatefulSet's per-pod PVCs
// and PVs are grouped with its pods — all against kubectl. A group opens every pod of its owner, a search finds a
// pod inside a group, a group expands to its pods and Expand all draws every pod.

const NS = 'e2e-rg-groups'
const NODES = '.react-flow__node'
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'
const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-rg-groups-'))
  const kcPath = path.join(dir, 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return {
    run: (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(),
    apply: (yaml: string) => {
      const file = path.join(dir, 'fixtures.yaml')
      fs.writeFileSync(file, yaml)
      execSync(`kubectl --kubeconfig ${kcPath} apply -f ${file}`, { stdio: 'pipe' })
    },
  }
}
const k = kubectlFor('kubeast')

const FIXTURES = `
apiVersion: v1
kind: Namespace
metadata: { name: ${NS} }
---
apiVersion: v1
kind: ConfigMap
metadata: { name: web-config, namespace: ${NS} }
data: { greeting: hello }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: web, namespace: ${NS} }
spec:
  replicas: 12
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
        - name: app
          image: registry.k8s.io/pause:3.10
          volumeMounts: [{ name: cfg, mountPath: /cfg }]
      volumes: [{ name: cfg, configMap: { name: web-config } }]
---
apiVersion: v1
kind: Service
metadata: { name: web, namespace: ${NS} }
spec:
  selector: { app: web }
  ports: [{ port: 80, targetPort: 8080 }]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: web-only, namespace: ${NS} }
spec:
  podSelector: { matchLabels: { app: web } }
  policyTypes: [Ingress]
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: db, namespace: ${NS} }
spec:
  replicas: 12
  serviceName: db
  podManagementPolicy: Parallel
  selector: { matchLabels: { app: db } }
  template:
    metadata: { labels: { app: db } }
    spec:
      initContainers:
        - name: check
          image: docker.io/library/busybox:1.37
          command: ["sh", "-c", "test \\"$HOSTNAME\\" != db-3"]
      containers:
        - name: app
          image: registry.k8s.io/pause:3.10
          volumeMounts: [{ name: data, mountPath: /data }]
  volumeClaimTemplates:
    - metadata: { name: data }
      spec:
        accessModes: [ReadWriteOnce]
        resources: { requests: { storage: 10Mi } }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: small, namespace: ${NS} }
spec:
  replicas: 3
  selector: { matchLabels: { app: small } }
  template:
    metadata: { labels: { app: small } }
    spec:
      containers: [{ name: app, image: registry.k8s.io/pause:3.10 }]
`

type Pod = {
  metadata: { name: string; ownerReferences?: { kind: string; name: string }[] }
  spec: { nodeName?: string }
  status: { phase: string; containerStatuses?: { ready: boolean }[] }
}
type GraphNode = { id: string; kind: string; name: string; status: string; group?: boolean; count?: number; members?: string[]; ownerKind?: string; ownerName?: string; nodeName?: string }
type Graph = { nodes: GraphNode[]; edges: { source: string; target: string; type: string; count?: number }[] }

const pods = (): Pod[] => JSON.parse(k.run(`-n ${NS} get pods -o json`)).items
const healthy = (p: Pod) => p.status.phase === 'Running' && (p.status.containerStatuses ?? []).length > 0 && p.status.containerStatuses!.every((c) => c.ready)
const podsOf = (kind: string, prefix: string, keep: (p: Pod) => boolean = () => true) =>
  pods().filter((p) => p.metadata.ownerReferences?.[0]?.kind === kind && p.metadata.ownerReferences[0].name.startsWith(prefix) && keep(p)).map((p) => p.metadata.name).sort()

const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })
async function graph(request: APIRequestContext, query = ''): Promise<Graph> {
  const login = await request.post('/api/v1/auth/login', { data: { email: EMAIL, password: PASSWORD } })
  expect(login.ok()).toBeTruthy()
  const res = await request.get(`/api/v1/resource-graph?namespaces=${NS}&cluster=self&group_pods=1${query}`, { headers: bearer((await login.json()).access_token) })
  expect(res.ok(), `resource graph ${res.status()}`).toBeTruthy()
  return res.json()
}

test.describe('Resource Graph — pod groups', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000)
    k.apply(FIXTURES)
    k.run(`-n ${NS} rollout status deployment/web --timeout=180s`)
    k.run(`-n ${NS} rollout status deployment/small --timeout=180s`)
    // the StatefulSet's pods but db-3 run once their PVCs are bound; db-3 fails its init container
    const deadline = Date.now() + 240_000
    while (podsOf('StatefulSet', 'db', healthy).length < 11 || !pods().some((p) => p.metadata.name === 'db-3' && p.spec.nodeName)) {
      if (Date.now() > deadline) throw new Error(`StatefulSet db not ready: ${podsOf('StatefulSet', 'db', healthy).length}/11`)
      execSync('sleep 2')
    }
  })
  test.afterAll(async () => {
    test.setTimeout(180_000)
    // waited for, so the PVs it leaves are gone before the specs after it count the graph
    try { k.run(`delete namespace ${NS} --wait=true --timeout=150s`) } catch { /* left for the next run's apply */ }
  })

  test('an owner\'s healthy pods with the same lines are one group, each line standing for every pod, and a failing pod stays apart', async ({ request }) => {
    const g = await graph(request)
    const web = g.nodes.find((n) => n.group && n.kind === 'Pod' && n.ownerKind === 'ReplicaSet')!
    const db = g.nodes.find((n) => n.group && n.kind === 'Pod' && n.ownerName === 'db')!
    expect([...web.members!].sort()).toEqual(podsOf('ReplicaSet', 'web-', healthy))
    expect(web.count).toBe(12)
    expect([...db.members!].sort()).toEqual(podsOf('StatefulSet', 'db', healthy))
    expect(db.members).not.toContain('db-3')
    // apart: db-3 and the 3 pods of an owner with no more than 10
    expect(g.nodes.filter((n) => n.kind === 'Pod' && !n.group).map((n) => n.name).sort()).toEqual(['db-3', ...podsOf('ReplicaSet', 'small-')].sort())

    // an end by its kind ("group" for this group, the kind for another group)
    const end = (other: string, id: string) => (other === id ? 'group' : other.replace(/^group:/, '').split('/')[0])
    const linesOf = (id: string) => Object.fromEntries(g.edges.filter((e) => e.source === id || e.target === id).map((e) => [`${end(e.source, id)} ${e.type} ${end(e.target, id)}`, e.count]))
    expect(linesOf(web.id)).toEqual({ 'ReplicaSet owns group': 12, 'Service selects group': 12, 'NetworkPolicy network_policy group': 12, 'group mounts ConfigMap': 12 })

    // the StatefulSet's PVCs and PVs of the grouped pods are groups too; db-3's are apart
    const claims = g.nodes.find((n) => n.group && n.kind === 'PersistentVolumeClaim')!
    const volumes = g.nodes.find((n) => n.group && n.kind === 'PersistentVolume')!
    expect([...claims.members!].sort()).toEqual(db.members!.map((m) => `data-${m}`).sort())
    const pvcs = JSON.parse(k.run(`-n ${NS} get pvc -o json`)).items as { metadata: { name: string }; spec: { volumeName: string } }[]
    expect([...volumes.members!].sort()).toEqual(pvcs.filter((c) => c.metadata.name !== 'data-db-3').map((c) => c.spec.volumeName).sort())
    expect(g.nodes.some((n) => !n.group && n.name === 'data-db-3')).toBe(true)
    expect(linesOf(db.id)['group mounts PersistentVolumeClaim']).toBe(11)

    // asked with the node grouping, a group carries its node
    const byNode = await graph(request, '&group_by=node')
    const node = pods().find((p) => p.metadata.name === web.members![0])!.spec.nodeName
    expect(byNode.nodes.find((n) => n.group && n.ownerKind === 'ReplicaSet')?.nodeName).toBe(node)
  })

  test('the graph draws the groups with their counts and the header counts every pod', async ({ page }) => {
    await page.goto(`/cluster/resource-graph?cluster=self&namespace=${NS}`)
    const groups = page.getByTestId('graph-group')
    await expect(groups).toHaveCount(4, { timeout: 30_000 })
    const counts = (await groups.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-count'))))).sort((a, b) => a - b)
    expect(counts).toEqual([11, 11, 11, 12])
    const header = page.getByTestId('graph-pod-count')
    await expect(header).toHaveAttribute('data-pods', String(pods().length))
    await expect(header).toHaveAttribute('data-groups', '2')
    await expect(header).toHaveAttribute('data-apart', '4')
    await expect(page.getByTestId('legend-group')).toHaveText(/Pod group/)
  })

  test('a group opens every pod of its owner, problems first, counted by colour, and a row opens the pod', async ({ page }) => {
    await page.goto(`/cluster/resource-graph?cluster=self&namespace=${NS}`)
    await page.getByTestId('graph-group').filter({ hasText: 'StatefulSet' }).click()
    const list = page.getByTestId('pod-group-list')
    const rows = list.getByTestId('pod-group-row')
    await expect(rows).toHaveCount(12)
    const names = await rows.evaluateAll((els) => els.map((e) => e.querySelector('td')!.textContent!.trim()))
    expect(names[0]).toBe('db-3')
    expect([...names].sort()).toEqual(podsOf('StatefulSet', 'db'))
    const chips = list.getByTestId('pod-group-chips')
    await expect(chips.locator('[data-health="all"]')).toHaveText(/12$/)
    await expect(chips.locator('[data-health="ok"]')).toHaveText(/11$/)
    await expect(chips.locator('[data-health="error"]')).toHaveText(/1$/)
    await chips.locator('[data-health="error"]').click()
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('db-3')
    await rows.first().click()
    await expect(list).toBeHidden()
    await expect(page.locator(DRAWER)).toContainText('db-3')
  })

  test('a search finds a pod inside a group, a group expands to its pods, and Expand all draws every pod', async ({ page }) => {
    await page.goto(`/cluster/resource-graph?cluster=self&namespace=${NS}`)
    const groups = page.getByTestId('graph-group')
    await expect(groups).toHaveCount(4, { timeout: 30_000 })
    const web = podsOf('ReplicaSet', 'web-', healthy)
    await page.getByPlaceholder('Search resources...').fill(web[5])
    await expect(groups.filter({ hasText: 'ReplicaSet' })).toContainText('1 match')
    await page.getByPlaceholder('Search resources...').fill('')

    await groups.filter({ hasText: 'ReplicaSet' }).click()
    await page.getByTestId('pod-group-expand').click()
    await expect(groups).toHaveCount(3)
    for (const name of web) await expect(page.locator(NODES, { hasText: name })).toHaveCount(1)

    await page.getByTestId('pod-grouping').getByRole('button', { name: 'Expand all' }).click()
    await expect(groups).toHaveCount(0)
    await expect(page.getByTestId('graph-pod-count')).toHaveAttribute('data-pods', String(pods().length))
    await expect(page.locator(NODES, { hasText: 'db-0' })).toHaveCount(2) // the pod and its PVC data-db-0
    await page.getByTestId('pod-grouping').getByRole('button', { name: 'Group pods' }).click()
    await expect(groups).toHaveCount(4)
  })
})
