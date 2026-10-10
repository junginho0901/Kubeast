import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// The agreed terms in the Korean UI: Kubernetes kinds, screen names, field names, condition values and
// identifiers stay English; what Kubeast itself writes (summary states, column and card names, notices)
// is in the UI language.

const KO = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../frontend/src/i18n/locales/ko.json'), 'utf8'))
const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''

async function bearer(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post('/api/v1/auth/login', { data: { email: EMAIL, password: PASSWORD } })
  expect(res.ok(), 'admin login — set E2E_USER_EMAIL / E2E_USER_PASSWORD').toBeTruthy()
  return { Authorization: `Bearer ${(await res.json()).access_token as string}` }
}

const lookup = (key: string): unknown =>
  key.split('.').reduce<unknown>((o, p) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[p] : undefined), KO)

// the AdminRoles key for a permission or category (pages/AdminRoles.tsx)
const i18nKey = (s: string) => s.toLowerCase().replace(/\*/g, 'all').replace(/[^a-z0-9]+/g, '_')

async function openIn(page: Page, lang: 'ko' | 'en', route: string) {
  await page.evaluate((l) => localStorage.setItem('i18nextLng', l), lang)
  await page.goto(route)
  await expect(page.locator('main h1').first()).toBeVisible({ timeout: 20000 })
  await page.waitForTimeout(1500)
}

// Text the screen itself writes: headings, subtitles, notices, buttons. Table bodies, code and inputs hold
// data, which is the same in both languages on purpose.
async function screenText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = []
    const root = document.querySelector('main') ?? document.body
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const el = walker.currentNode.parentElement
      const text = walker.currentNode.textContent?.trim()
      if (!text || !el || el.closest('tbody, code, pre, input, textarea, svg, .font-mono')) continue
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      out.push(text)
    }
    return out
  })
}

const KINDS = new Set(`Pod Pods Deployment Deployments StatefulSet DaemonSet ReplicaSet Job CronJob HPA PDB Service Services
  Endpoint Endpoints EndpointSlice EndpointSlices Ingress IngressClass NetworkPolicy Gateway HTTPRoute ConfigMap Secret Namespace
  Namespaces Node Nodes PV PVC StorageClass ServiceAccount Role ClusterRole RoleBinding ClusterRoleBinding Lease CRD Helm Release
  YAML JSON CSV API AI GPU CPU RBAC Kubeast Prometheus Argo CD OIDC SSO`.split(/\s+/))

// An English sentence: three or more words, no Hangul, not made of names, paths or numbers.
function englishSentence(line: string): boolean {
  if (/[가-힣]/.test(line)) return false
  const words = line.match(/[A-Za-z]+/g) ?? []
  if (words.length < 3) return false
  if (/\d{2,}|[/:=@]|\.(com|io|local)|kube|-[a-z0-9]{4,}/.test(line)) return false
  if (words.every((w) => KINDS.has(w))) return false
  return [...line].filter((c) => /[A-Za-z]/.test(c)).length / line.length > 0.6
}

test.describe('language and terms', () => {
  test('every permission in the server catalog has its Korean description', async ({ request }) => {
    const res = await request.get('/api/v1/auth/permissions', { headers: await bearer(request) })
    expect(res.ok()).toBeTruthy()
    const catalog = (await res.json()) as Array<{ category: string; permissions: Array<{ key: string }> }>
    const missing: string[] = []
    for (const cat of catalog) {
      if (lookup(`adminRoles.catalog.category.${i18nKey(cat.category)}`) === undefined) missing.push(`category ${cat.category}`)
      for (const p of cat.permissions) {
        if (lookup(`adminRoles.catalog.permission.${i18nKey(p.key)}`) === undefined) missing.push(p.key)
      }
    }
    expect(catalog.length).toBeGreaterThan(3)
    expect(missing).toEqual([])
  })

  test('no English sentence the screen writes stays English in the Korean UI', async ({ page }) => {
    test.setTimeout(180_000)
    await page.goto('/')
    const routes = ['/account', '/cluster/search', '/admin/users', '/admin/audit', '/admin/clusters', '/admin/ai-usage', '/workloads/deployments?cluster=self']
    const left: string[] = []
    const seen: Record<string, number> = {}
    for (const route of routes) {
      await openIn(page, 'en', route)
      const en = await screenText(page)
      await openIn(page, 'ko', route)
      const ko = await screenText(page)
      seen[route] = ko.length
      // the screen did change language (an empty or untranslated scan would pass by itself)
      expect(ko.filter((l) => /[가-힣]/.test(l)).length, `${route}: Korean text on screen`).toBeGreaterThan(3)
      expect(en.filter((l) => englishSentence(l)).length, `${route}: English sentences in the English UI`).toBeGreaterThan(0)
      const enSet = new Set(en)
      for (const line of ko) if (enSet.has(line) && englishSentence(line)) left.push(`${route}: ${line}`)
    }
    await test.info().attach('lines per screen', { body: JSON.stringify(seen, null, 2), contentType: 'application/json' })
    expect([...new Set(left)]).toEqual([])
  })

  test.describe('in Korean', () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => {
        try { localStorage.setItem('i18nextLng', 'ko') } catch { /* private mode */ }
      })
    })

    test('dashboard cards are the kind names, singular', async ({ page }) => {
      await page.goto('/?cluster=self')
      for (const name of ['Namespace', 'Pod', 'Service', 'Deployment', 'PVC', 'Node']) {
        await expect(page.getByText(name, { exact: true }).first()).toBeVisible({ timeout: 20000 })
      }
      await expect(page.getByText('PVCs', { exact: true })).toHaveCount(0)
      await expect(page.getByText('서비스', { exact: true })).toHaveCount(0)
    })

    test('audit log: area, action and result in Korean, values as display names', async ({ page }) => {
      await page.goto('/admin/audit')
      const head = page.locator('thead')
      await expect(head.getByText('영역', { exact: true })).toBeVisible({ timeout: 20000 })
      await expect(head.getByText('동작', { exact: true })).toBeVisible()
      await expect(head.getByText('Service', { exact: true })).toHaveCount(0)
      const firstRow = page.locator('tbody tr').first()
      await expect(firstRow).toBeVisible({ timeout: 20000 })
      await expect(firstRow).toContainText(/성공|실패/)
      await expect(firstRow).not.toContainText(/\bsuccess\b|\bfailure\b/)
      await expect(firstRow.locator('td').nth(2)).toHaveText(/^(인증|Kubernetes|Helm|AI|관리|-)$/)
    })

    test('user management: role names as stored, Korean column and button', async ({ page }) => {
      await page.goto('/admin/users')
      await expect(page.locator('thead').getByText('역할', { exact: true })).toBeVisible({ timeout: 20000 })
      await expect(page.getByRole('button', { name: '비밀번호 초기화' }).first()).toBeVisible()
      await expect(page.getByText(/^(ADMIN|MEMBER|PENDING)$/)).toHaveCount(0)
      await expect(page.locator('tbody').getByText(/^(Admin|Member)$/).first()).toBeVisible()
    })

    test('clusters: mode and health as display names', async ({ page }) => {
      await page.goto('/admin/clusters')
      const self = page.locator('tbody tr').filter({ hasText: 'self' }).first()
      await expect(self).toBeVisible({ timeout: 20000 })
      await expect(self).toContainText('이 클러스터')
      await expect(self).not.toContainText(/\bhealthy\b|in_cluster/)
    })

    test('workload lists: one set of summary states in Korean, the server value in the tooltip', async ({ page }) => {
      await page.goto('/workloads/deployments?cluster=self')
      const badges = page.locator('tbody .badge')
      await expect(badges.first()).toBeVisible({ timeout: 20000 })
      const texts = await badges.allTextContents()
      expect(texts.filter((t) => !['정상', '진행 중', '저하', '유휴', '사용 불가', '실패'].includes(t.trim()))).toEqual([])
      await expect(badges.first()).toHaveAttribute('title', /^(Available|Progressing|Failed|Healthy|Degraded|Unavailable)/)
    })

    test('Helm release: History is "이력", Helm output names stay English', async ({ page, request }) => {
      const res = await request.get('/api/v1/helm/releases?cluster=self', { headers: await bearer(request) })
      const releases = res.ok() ? (((await res.json()) as { items?: Array<{ name: string; namespace: string }> }).items ?? []) : []
      test.skip(releases.length === 0, 'no Helm release on the self cluster')
      const r = releases[0]
      await page.goto(`/helm/releases/${r.namespace}/${r.name}?cluster=self`)
      for (const tab of ['개요', 'Values', 'Manifest', 'Notes', '이력']) {
        await expect(page.getByRole('button', { name: tab, exact: true }).first()).toBeVisible({ timeout: 20000 })
      }
      await expect(page.getByRole('button', { name: 'History', exact: true })).toHaveCount(0)
    })

    test('Advanced Search: the same Beta label in the sidebar and the title, kind chips as written', async ({ page }) => {
      await page.goto('/cluster/search')
      await expect(page.locator('main h1')).toContainText('Advanced Search')
      await expect(page.locator('main h1')).toContainText('베타')
      await expect(page.getByTestId('sidebar-nav').locator('a[href="/cluster/search"]')).toContainText('베타')
      await expect(page.getByText(/^(ALL|POD|SERVICE|DEPLOYMENT)$/)).toHaveCount(0)
    })
  })
})
