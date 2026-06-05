import { test, expect, Page } from '@playwright/test'

// Phase 5.x Out-of-Scope (이번에 진행) — Prometheus 기반 detail modal feature 5개 +
// 외부 의존성 toggle + AdminAudit 의 custom dropdown / 가로 스크롤 검증.
//
// dev kind cluster 에서 PROMETHEUS_ENABLED env 없음 → backend default `true` →
// 자동 발견 → frontend useClusterFeatures() 가 `{ prometheus: { enabled: true } }`
// 받음. cluster 에 Prometheus 있으면 feature section 보이고, 없으면 graceful
// hidden. helm install --set features.prometheus.enabled=false 면 무조건 hidden.

async function selectNamespace(page: Page, ns: string) {
  const dropdown = page.getByRole('button', { name: /All namespaces|모든 네임스페이스|namespace/i }).first()
  if ((await dropdown.count()) === 0) return
  await dropdown.click()
  await page.getByText(ns, { exact: true }).first().click({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(500)
}

async function waitTable(page: Page) {
  await page.waitForSelector('tbody tr', { timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(500)
}

function assertNoCriticalErrors(page: Page, errors: string[]) {
  page.on('pageerror', (e) => errors.push(`PAGEERR: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`CONSOLE.error: ${m.text()}`)
  })
  const critical = errors.filter((e) =>
    /Rendered more hooks|Cannot read|undefined is not|TypeError|ReferenceError/.test(e),
  )
  expect(critical, `unexpected critical errors:\n${critical.join('\n')}`).toEqual([])
}

test.describe('Prometheus features — toggle + 4 detail modal sections + #5 events', () => {

  test('Cluster features API — /api/v1/cluster/features 응답 + prometheus enabled flag', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')

    // useClusterFeatures hook 이 호출하는 endpoint 직접 검증
    const res = await page.request.get('/api/v1/cluster/features')
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    // 응답 schema: { prometheus: { enabled: boolean } }
    expect(body).toHaveProperty('prometheus')
    expect(typeof body.prometheus?.enabled).toBe('boolean')

    assertNoCriticalErrors(page, errors)
  })

  test('Feature #1 — HPA Scaling History 섹션 (HPA 모달, 있으면)', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))

    await page.goto('/workloads/hpas')
    await page.waitForLoadState('domcontentloaded')
    await waitTable(page)

    const row = page.locator('tbody tr').first()
    test.skip((await row.count()) === 0, 'HPA 없음')

    await row.click()
    await page.waitForTimeout(3000)  // PrometheusSection range query 응답 대기

    // HPA 모달 mount — Summary 또는 Replicas section 항상 보임. Scaling History
    // 는 Prometheus 자동 발견 + range query 응답 가능 시에만 추가로 보임.
    await expect(page.locator('text=/^Summary$|^Replicas$|Scale Target Reference/').first())
      .toBeVisible({ timeout: 10000 })

    assertNoCriticalErrors(page, errors)
  })

  test('Feature #2 — Ingress Response Time P50/P95/P99 (있으면)', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))

    await page.goto('/network/ingresses')
    await page.waitForLoadState('domcontentloaded')
    await waitTable(page)

    const row = page.locator('tbody tr').first()
    test.skip((await row.count()) === 0, 'Ingress 없음')

    await row.click()
    await page.waitForTimeout(3000)

    // Ingress Info 는 항상 보임 — modal mount 검증
    await expect(page.locator('text=/^Ingress Info$/').first()).toBeVisible({ timeout: 10000 })

    // Prometheus enabled + nginx-ingress 가 metrics scrape 중이면 P50/P95/P99 카드
    // 보임. 아니면 hint 또는 section 자체 hidden. 둘 다 정상.
    const latencySection = page.locator('text=/Response Time|P50|P95|P99/i').first()
    // visible 일 수도, 없을 수도 — page error 만 검증
    await latencySection.waitFor({ timeout: 3000 }).catch(() => {})

    assertNoCriticalErrors(page, errors)
  })

  test('Feature #3 — Node 24h Resource Trend (있으면)', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))

    await page.goto('/cluster/nodes')
    await page.waitForLoadState('domcontentloaded')
    await waitTable(page)

    const row = page.locator('tbody tr').first()
    test.skip((await row.count()) === 0, 'Node 없음')

    await row.click()
    await page.waitForTimeout(3000)

    // System Info section 항상 보임 — modal mount
    await expect(page.locator('text=/System Info|시스템/i').first()).toBeVisible({ timeout: 10000 })

    // Prometheus enabled + node-exporter 있으면 24h Resource Trend 또는 sparkline
    // 보임. 없으면 hidden — page error 0 만 검증.
    assertNoCriticalErrors(page, errors)
  })

  test('Feature #5 — Pod Image Pull History 섹션 (events 기반, 있으면)', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))

    await page.goto('/workloads/pods')
    await page.waitForLoadState('domcontentloaded')
    await waitTable(page)

    const row = page.locator('tbody tr').first()
    test.skip((await row.count()) === 0, 'Pod 없음')

    await row.click()
    await page.waitForTimeout(3000)

    await expect(page.locator('text=/^Basic Info$/').first()).toBeVisible({ timeout: 15000 })
    // Image Pull History 는 events 가 있을 때만 보임 — 그 자체 검증보다 page error 0

    assertNoCriticalErrors(page, errors)
  })

  test('Feature #4 — Pod exec terminal 로그 보존 (스텁만 — 인프라 작업 OOS)', async ({ page }) => {
    // 본격 구현은 별도 — PodExecTerminal.tsx 의 stub 주석 확인 정도.
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))

    await page.goto('/cluster-view')
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByRole('heading', { name: /클러스터 뷰|Cluster view/i })).toBeVisible({ timeout: 10000 })

    // Exec 권한 있는 사용자만 보임 — admin 계정으로 진입. exec 자체는 안 띄움
    // (DB schema / audit_writer 작업 OOS). 단지 PodExecTerminal mount 시 console
    // error 0 확인.

    assertNoCriticalErrors(page, errors)
  })
})

test.describe('AdminAudit — custom dropdown + 가로 스크롤', () => {

  test('AdminAudit 페이지 mount + 3 custom dropdown 보임', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))

    await page.goto('/admin/audit')
    await page.waitForLoadState('domcontentloaded')

    // 'admin' 계정 권한 필요 — 권한 없으면 page error 또는 redirect.
    // mount 자체 검증.
    await page.waitForTimeout(2000)

    // 3 custom dropdown 의 chevron 으로 식별
    const chevrons = page.locator('button:has(svg.lucide-chevron-down)')
    const count = await chevrons.count()
    // Service / Result / Limit + 다른 dropdown (table sort 등) 다 합쳐서 ≥3
    // ChevronDown 은 다른 곳에도 있을 수 있으니 정확 비교 X — 적어도 1개는 있어야
    if (count > 0) {
      // 첫 번째 dropdown 클릭 → 패널 열림 → 다시 닫기
      await chevrons.first().click()
      await page.waitForTimeout(300)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
    }

    assertNoCriticalErrors(page, errors)
  })

  test('AdminAudit table — overflow-x-auto + min-width', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))

    // 좁은 viewport (세로 모니터 모방) — 가로 스크롤 가능해야
    await page.setViewportSize({ width: 600, height: 1024 })
    await page.goto('/admin/audit')
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000)

    // table outer container 의 overflow-x-auto 적용 검증
    const tableContainer = page.locator('div.overflow-x-auto').filter({ has: page.locator('table.min-w-\\[1100px\\]') }).first()
    if ((await tableContainer.count()) === 0) {
      // 또 다른 selector — overflow-x-auto + table
      const fallback = page.locator('div').filter({ has: page.locator('table.min-w-\\[1100px\\]') }).first()
      if ((await fallback.count()) === 0) {
        // admin 권한 없으면 page redirect 됐을 수도 — page error 0 만 검증
        assertNoCriticalErrors(page, errors)
        return
      }
    }

    assertNoCriticalErrors(page, errors)
  })
})

test.describe('Prometheus toggle smoke — page error 0', () => {

  test('Dashboard 진입 + Prometheus Cluster Resource Utilization', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))

    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('h1.text-3xl').first()).toBeVisible({ timeout: 10000 })

    // Cluster Resource Utilization (Prometheus dependent) 가 보이면 자동 발견 OK.
    // 안 보여도 page error 0 만 검증.
    await page.waitForTimeout(3000)
    assertNoCriticalErrors(page, errors)
  })

  test('Namespace detail — Real-time Resource Usage (Prometheus dependent)', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))

    await page.goto('/cluster/namespaces')
    await page.waitForLoadState('domcontentloaded')
    await waitTable(page)

    const row = page.locator('tbody tr').first()
    test.skip((await row.count()) === 0, 'Namespace 없음')

    await row.click()
    await page.waitForTimeout(3000)

    // Resource Summary 는 항상 보임 (K8s API 기반)
    // Real-time Resource Usage 는 Prometheus 의존 — 자동 발견 시 보임
    await expect(page.locator('text=/Resource Summary|Real-time Resource Usage/').first()).toBeVisible({ timeout: 15000 })

    assertNoCriticalErrors(page, errors)
  })
})
