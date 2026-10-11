import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'

// Cluster → Resource Graph (React Flow + ELK layout) on the dev cluster itself:
// the graph renders with its minimap and controls, namespace grouping keeps every
// resource inside a group container, and a node click opens the resource drawer.
// A Read user gets the graph without the kinds Kubernetes refuses them, also right
// after an admin's answer was cached.
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'
const NODES = '.react-flow__node'

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const READER_PW = 'E2e-graph-read1!'
const NS = 'kubeast'

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-resource-graph-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

// A throwaway Member with the Read role on `self`; the caller deletes it.
async function createReader(request: APIRequestContext, admin: string, email: string): Promise<string> {
  const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
  const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
  const res = await request.post('/api/v1/auth/admin/users', {
    headers: bearer(admin),
    data: { name: 'E2E graph reader', email, password: READER_PW, role_id: member.id },
  })
  expect(res.status(), `create ${email}`).toBe(201)
  const id = (await res.json()).id
  const granted = await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/self`, { headers: bearer(admin), data: { role: 'Read' } })
  expect(granted.ok(), 'grant Read on self').toBeTruthy()
  return id
}

type Graph = { nodes: { kind: string; name: string }[]; forbidden_kinds?: string[] }
const secretNames = (g: Graph) => g.nodes.filter((n) => n.kind === 'Secret').map((n) => n.name).sort()

async function box(l: Locator) {
  const b = await l.boundingBox()
  if (!b) throw new Error('element has no box')
  return b
}

// The graph draws only the picked namespaces (?namespace= picks them, the old topology
// links use it); both of these always exist on the dev cluster.
async function openGraph(page: Page) {
  await page.goto('/cluster/resource-graph?cluster=self&namespace=kube-system,kubeast')
  await expect(page.getByRole('button', { name: 'kube-system, kubeast' })).toBeVisible({ timeout: 15000 })
  await expect(page.locator(NODES).first()).toBeVisible({ timeout: 30000 })
}

test.describe('resource graph', () => {
  test('renders nodes with the minimap and controls', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await openGraph(page)

    expect(await page.locator(NODES).count()).toBeGreaterThan(0)
    await expect(page.locator('.react-flow__minimap')).toBeVisible()
    await expect(page.locator('.react-flow__controls')).toBeVisible()
    expect(errors).toEqual([])
  })

  test('grouping by namespace keeps every resource inside a group container', async ({ page }) => {
    await openGraph(page)

    await page.getByRole('button', { name: 'Namespace', exact: true }).click()
    const groups = page.locator(`${NODES}[data-id^="group-"]`)
    await expect(groups.first()).toBeVisible({ timeout: 30000 })

    const groupBoxes = await Promise.all((await groups.all()).map(box))
    const members = await page.locator(`${NODES}:not([data-id^="group-"])`).all()
    expect(members.length).toBeGreaterThan(0)
    for (const m of members) {
      const b = await box(m)
      const cx = b.x + b.width / 2
      const cy = b.y + b.height / 2
      const inside = groupBoxes.some((g) => cx >= g.x && cx <= g.x + g.width && cy >= g.y && cy <= g.y + g.height)
      expect(inside, `${await m.getAttribute('data-id')} sits inside a group`).toBe(true)
    }
  })

  test('clicking a resource opens its detail drawer', async ({ page }) => {
    await openGraph(page)
    const node = page.locator(`${NODES} [title]`).first()
    await expect(node).toBeVisible({ timeout: 30000 })
    const name = await node.getAttribute('title')
    expect(name).toBeTruthy()

    await node.click()
    const drawer = page.locator(DRAWER).last()
    await expect(drawer).toBeVisible({ timeout: 15000 })
    await expect(drawer.getByText(name!, { exact: true }).first()).toBeVisible()
  })
})

test.describe('resource graph for a Read user', () => {
  test('leaves out what Kubernetes refuses, also right after an admin', async ({ request }) => {
    const kubectl = kubectlFor('kubeast')
    const admin = await login(request, EMAIL, PASSWORD)
    const email = `e2e-graph-read-${Date.now().toString(36)}@kubeast.local`
    let userId = ''
    try {
      userId = await createReader(request, admin, email)
      const reader = await login(request, email, READER_PW)
      const graph = async (token: string): Promise<Graph> => {
        const res = await request.get(`/api/v1/resource-graph?namespaces=${NS}&cluster=self`, { headers: bearer(token) })
        expect(res.status()).toBe(200)
        return res.json()
      }

      // The admin lists every Secret; that answer is now cached for 30 s.
      const asAdmin = await graph(admin)
      const listed = kubectl(`-n ${NS} get secrets -o jsonpath='{.items[*].metadata.name}'`).split(/\s+/).filter(Boolean)
      expect(secretNames(asAdmin)).toEqual(expect.arrayContaining(listed))

      // The reader may not list Secrets: the graph says so and keeps only the names its Pod specs carry.
      const asReader = await graph(reader)
      expect(asReader.forbidden_kinds).toContain('Secret')
      const pods = JSON.parse(kubectl(`-n ${NS} get pods -o json`)) as { items: { spec: any }[] }
      const referenced = new Set<string>()
      for (const { spec } of pods.items) {
        for (const v of spec.volumes ?? []) if (v.secret) referenced.add(v.secret.secretName)
        for (const c of [...(spec.initContainers ?? []), ...spec.containers]) {
          for (const e of c.envFrom ?? []) if (e.secretRef) referenced.add(e.secretRef.name)
          for (const e of c.env ?? []) if (e.valueFrom?.secretKeyRef) referenced.add(e.valueFrom.secretKeyRef.name)
        }
      }
      expect(secretNames(asReader).filter((s) => !referenced.has(s))).toEqual([])
      expect(secretNames(asReader).length).toBeLessThan(secretNames(asAdmin).length)
    } finally {
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })

  test('draws the graph and names the kinds left out', async ({ browser, request }) => {
    const admin = await login(request, EMAIL, PASSWORD)
    const email = `e2e-graph-read-ui-${Date.now().toString(36)}@kubeast.local`
    let userId = ''
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } })
    try {
      userId = await createReader(request, admin, email)
      const reader = await login(request, email, READER_PW)
      const res = await request.get(`/api/v1/resource-graph?namespaces=${NS}&cluster=self`, { headers: bearer(reader) })
      const expected = ((await res.json()) as Graph).nodes.length

      const page = await ctx.newPage()
      await page.goto('/login')
      await page.locator('input[autocomplete="email"]').first().fill(email)
      await page.locator('input[type="password"]').first().fill(READER_PW)
      await page.locator('button[type="submit"]').first().click()
      await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), { timeout: 20000 })
      await page.goto(`/cluster/resource-graph?cluster=self&namespace=${NS}`)

      await expect(page.getByTestId('resource-graph-forbidden')).toHaveText(/^RoleBinding, Secret[:\s]|RoleBinding, Secret in this cluster/, { timeout: 30000 })
      await expect(page.getByText(new RegExp(`^(${expected} nodes|리소스 ${expected}개)$`))).toHaveCount(1)
      await expect(page.locator(NODES).first()).toBeVisible({ timeout: 30000 })
    } finally {
      await ctx.close()
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })
})
