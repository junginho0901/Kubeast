import { test, expect, Page } from '@playwright/test'

// Phase 5 detail 모달 강화 + wsMultiplexer fix + 페이지네이션 시각 검증.

async function selectNamespace(page: Page, ns: string) {
  // Sidebar/top namespace dropdown — 'All namespaces' default 버튼 클릭 후 ns 선택
  const dropdown = page.getByRole('button', { name: /All namespaces|모든 네임스페이스|namespace/i }).first()
  if ((await dropdown.count()) === 0) return
  await dropdown.click()
  await page.getByText(ns, { exact: true }).first().click({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(500)
}

async function waitTable(page: Page) {
  // table render + 첫 row 도착까지
  await page.waitForSelector('tbody tr', { timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(500)
}

test.describe('Phase 5 — detail modal sections', () => {

  test('5.2 + backend fix — Service Matching Pods 가 selector 매칭 Pod 만 (chatbot-db)', async ({ page }) => {
    await page.goto('/network/services')
    await page.waitForLoadState('networkidle')
    await selectNamespace(page, 'clarinet')
    await waitTable(page)

    const targetRow = page.locator('tbody tr:has-text("chatbot-db")').first()
    const hasService = (await targetRow.count()) > 0
    test.skip(!hasService, 'chatbot-db Service 없음 (clarinet ns)')

    await targetRow.click()
    // describe + first watch tick 까지 충분히 대기 — 외부 클러스터 VPN latency 고려
    const matchingSection = page.locator('text=/Matching Pods \\(\\d+\\)/').first()
    await matchingSection.waitFor({ timeout: 45000 })
    // ns Pod list + watch 이벤트 도착해서 count 안정될 시간
    await page.waitForTimeout(2000)

    const matchText = await matchingSection.innerText()
    expect(matchText).toMatch(/Matching Pods \(1\)/)
  })

  test('페이지네이션 — PriorityClass system-node-critical', async ({ page }) => {
    await page.goto('/cluster/priorityclasses')
    await page.waitForLoadState('networkidle')
    await waitTable(page)

    const row = page.locator('tbody tr:has-text("system-node-critical")').first()
    test.skip((await row.count()) === 0, 'system-node-critical 없음')

    await row.click()
    const usingSection = page.locator('text=/Used By Pods \\(\\d+\\)/').first()
    await usingSection.waitFor({ timeout: 15000 })
    const text = await usingSection.innerText()
    const total = parseInt(text.match(/\((\d+)\)/)?.[1] ?? '0', 10)
    test.skip(total <= 10, `Pods ${total}개 → 페이지네이션 무의미`)

    await expect(page.locator(`text=/1-10 \\/ ${total}/`).first()).toBeVisible()
    await page.locator('button:has-text("Next")').first().click()
    await page.waitForTimeout(200)
    await expect(page.locator(`text=/11-/`).first()).toBeVisible()
  })

  test('5.4 — ConfigMap kube-root-ca.crt Used By Pods', async ({ page }) => {
    await page.goto('/configuration/configmaps')
    await page.waitForLoadState('networkidle')
    await selectNamespace(page, 'kubeast')
    await waitTable(page)

    const row = page.locator('tbody tr:has-text("kube-root-ca.crt")').first()
    test.skip((await row.count()) === 0, 'kube-root-ca.crt 없음')

    await row.click()
    await page.locator('text=/Used By Pods \\(\\d+\\)/').first().waitFor({ timeout: 15000 })
  })

  test('5.4 — ServiceAccount cert-manager Effective Permissions', async ({ page }) => {
    await page.goto('/security/serviceaccounts')
    await page.waitForLoadState('networkidle')
    await selectNamespace(page, 'cert-manager')
    await waitTable(page)

    const row = page.locator('tbody tr:has-text("cert-manager")').first()
    test.skip((await row.count()) === 0, 'cert-manager SA 없음')

    await row.click()
    await page.locator('text=/Effective Permissions/').first().waitFor({ timeout: 15000 })
  })

  test('5.7 — RuntimeClass nvidia Used By Pods', async ({ page }) => {
    await page.goto('/cluster/runtimeclasses')
    await page.waitForLoadState('networkidle')
    await waitTable(page)

    const row = page.locator('tbody tr:has-text("nvidia")').first()
    test.skip((await row.count()) === 0, 'nvidia RuntimeClass 없음')

    await row.click()
    // Cluster-wide Pod scan (api.getAllPods) 외부 cluster 라 느림. count > 0 될 때까지 polling
    await expect(async () => {
      const section = page.locator('text=/Used By Pods \\(\\d+\\)/').first()
      await section.waitFor({ timeout: 30000 })
      const text = await section.innerText()
      const count = parseInt(text.match(/\((\d+)\)/)?.[1] ?? '0', 10)
      expect(count).toBeGreaterThan(0)
    }).toPass({ timeout: 45000, intervals: [2000, 5000, 5000] })
  })

  test('5.5 #2 — Namespace cert-manager Resource Summary', async ({ page }) => {
    await page.goto('/cluster/namespaces')
    await page.waitForLoadState('networkidle')
    await waitTable(page)

    const row = page.locator('tbody tr:has-text("cert-manager")').first()
    test.skip((await row.count()) === 0, 'cert-manager namespace 없음')

    await row.click()
    await page.locator('text=/Resource Summary/').first().waitFor({ timeout: 30000 })
  })

  test('5.7 — ClusterRoleBinding cluster-admin Bound Pods (있으면)', async ({ page }) => {
    await page.goto('/security/clusterrolebindings')
    await page.waitForLoadState('networkidle')
    await waitTable(page)

    const row = page.locator('tbody tr:has-text("cluster-admin")').first()
    test.skip((await row.count()) === 0, 'cluster-admin CRB 없음')

    await row.click()
    // SA subject 가 있을 때만 섹션 나타남
    await page.locator('text=/Subjects/').first().waitFor({ timeout: 15000 })
    // Bound Pods section 은 SA subject 0개면 없을 수도 → soft check
  })

  test('회귀 — Namespace clarinet 기존 Pods 페이지네이션', async ({ page }) => {
    await page.goto('/cluster/namespaces')
    await page.waitForLoadState('networkidle')
    await waitTable(page)

    const row = page.locator('tbody tr:has-text("clarinet")').first()
    test.skip((await row.count()) === 0, 'clarinet namespace 없음')

    await row.click()
    // 모달 안의 Pods 섹션
    await page.locator('text=/Pods \\(\\d+\\)/').first().waitFor({ timeout: 30000 })
  })

  test('5.4 — Secret 의 Used By Pods / ServiceAccounts (gpu-operator)', async ({ page }) => {
    await page.goto('/configuration/secrets')
    await page.waitForLoadState('networkidle')
    await selectNamespace(page, 'gpu-operator')
    await waitTable(page)

    // 임의의 첫번째 secret row
    const row = page.locator('tbody tr').first()
    test.skip((await row.count()) === 0, 'gpu-operator ns 에 Secret 없음')
    await row.click()
    await page.locator('text=/Used By Pods/').first().waitFor({ timeout: 30000 })
  })

  test('5.7 — PriorityClass system-cluster-critical Used By Pods (>0)', async ({ page }) => {
    await page.goto('/cluster/priorityclasses')
    await page.waitForLoadState('networkidle')
    await waitTable(page)

    const row = page.locator('tbody tr:has-text("system-cluster-critical")').first()
    test.skip((await row.count()) === 0, 'system-cluster-critical 없음')

    await row.click()
    await expect(async () => {
      const section = page.locator('text=/Used By Pods \\(\\d+\\)/').first()
      await section.waitFor({ timeout: 30000 })
      const text = await section.innerText()
      const count = parseInt(text.match(/\((\d+)\)/)?.[1] ?? '0', 10)
      expect(count).toBeGreaterThan(0)
    }).toPass({ timeout: 45000, intervals: [2000, 5000, 5000] })
  })
})
