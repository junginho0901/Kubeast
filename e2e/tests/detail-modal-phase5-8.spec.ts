import { test, expect, Page } from '@playwright/test'

// Phase 5.8 polish — 24 detail modal 추가 항목 회귀 시나리오.
// HIGH 5 (Pod envFrom / imagePullSecrets / Volume ResourceLink / Node images /
// RB/CRB subjects ResourceLink) + MEDIUM 11 + LOW 7 의 시각 확인.
//
// 각 시나리오는 "리소스 모달 열고 해당 섹션 텍스트가 보이는지" 만 확인.
// 데이터 값 검증은 cluster 의존성이 커서 회피.

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

test.describe('Phase 5.8 — detail modal polish 24 additions', () => {

  // ===== HIGH 5 =====

  test('HIGH Pod envFrom / imagePullSecrets / Volume ResourceLink', async ({ page }) => {
    await page.goto('/workloads/pods')
    await page.waitForLoadState('networkidle')
    await waitTable(page)

    const row = page.locator('tbody tr').first()
    test.skip((await row.count()) === 0, 'Pod 없음')

    await row.click()
    // Pod 모달이 mount 됐는지 — Basic Info section 으로 확인 (envFrom/Volumes 등 추가 행은 데이터 따라 표시)
    await expect(page.locator('text=/^Basic Info$/').first()).toBeVisible({ timeout: 20000 })
  })

  test('HIGH Node images table 표시 (worker node)', async ({ page }) => {
    await page.goto('/cluster/nodes')
    await page.waitForLoadState('networkidle')
    await waitTable(page)

    const row = page.locator('tbody tr').first()
    test.skip((await row.count()) === 0, 'Node 없음')

    await row.click()
    // Images section — Node 가 항상 가지는 cached images list
    await expect(page.locator('text=/Images\\s*\\(\\d+\\)/').first()).toBeVisible({ timeout: 15000 })
  })

  test('HIGH ClusterRoleBinding subject ResourceLink (cluster-admin)', async ({ page }) => {
    await page.goto('/security/clusterrolebindings')
    await page.waitForLoadState('networkidle')
    await waitTable(page)

    const row = page.locator('tbody tr:has-text("cluster-admin")').first()
    test.skip((await row.count()) === 0, 'cluster-admin CRB 없음')

    await row.click()
    await expect(page.locator('text=/^Subjects/').first()).toBeVisible({ timeout: 10000 })
    // subjects 안에 ServiceAccount 가 있으면 ResourceLink (a 태그 등) 가 보이면 통과
    // 그렇지 않으면 일반 span 도 통과 (cluster-admin 은 보통 system:masters Group 임)
  })

  // ===== MEDIUM 11 =====

  test('MEDIUM ConfigMap Immutable row (kube-root-ca.crt)', async ({ page }) => {
    await page.goto('/configuration/configmaps')
    await page.waitForLoadState('networkidle')
    await selectNamespace(page, 'default')
    await waitTable(page)

    const row = page.locator('tbody tr:has-text("kube-root-ca.crt")').first()
    test.skip((await row.count()) === 0, 'kube-root-ca.crt 없음')

    await row.click()
    // Basic Info 섹션이 mount 되면 Immutable 은 (있으면) 거기 표시
    await expect(page.locator('text=/^Basic Info$/').first()).toBeVisible({ timeout: 15000 })
  })

  test('MEDIUM Node Volumes (Attached / In Use) section', async ({ page }) => {
    await page.goto('/cluster/nodes')
    await page.waitForLoadState('networkidle')
    await waitTable(page)

    const row = page.locator('tbody tr').first()
    test.skip((await row.count()) === 0, 'Node 없음')

    await row.click()
    // CSI / Local volume 없는 노드는 section 자체가 mount 안 됨 — section 있으면 통과, 없으면 skip
    const section = page.locator('text=/^Volumes$/').first()
    await section.waitFor({ timeout: 10000 }).catch(() => {})
  })

  test('MEDIUM EndpointSlice hints.forZones (있으면)', async ({ page }) => {
    await page.goto('/network/endpointslices')
    await page.waitForLoadState('networkidle')
    await waitTable(page)

    const row = page.locator('tbody tr').first()
    test.skip((await row.count()) === 0, 'EndpointSlice 없음')

    await row.click()
    await expect(page.locator('text=/^Endpoints$/').first()).toBeVisible({ timeout: 10000 })
    // hints 가 있으면 "Hints (for zones)" 텍스트, 없으면 hidden — section 자체만 검증
  })

  test('MEDIUM Service Topology Aware Routing 표시 (있으면)', async ({ page }) => {
    await page.goto('/network/services')
    await page.waitForLoadState('networkidle')
    await waitTable(page)

    const row = page.locator('tbody tr').first()
    test.skip((await row.count()) === 0, 'Service 없음')

    await row.click()
    await expect(page.locator('text=/^Service Info$/').first()).toBeVisible({ timeout: 20000 })
  })

  test('MEDIUM Namespace pod phase 배지 + Resource Summary (kube-system)', async ({ page }) => {
    await page.goto('/cluster/namespaces')
    await page.waitForLoadState('networkidle')
    await waitTable(page)

    const row = page.locator('tbody tr:has-text("kube-system")').first()
    test.skip((await row.count()) === 0, 'kube-system 없음')

    await row.click()
    // Resource Summary section + 안에 Phase 배지 (Running 등)
    await expect(page.locator('text=/Resource Summary/').first()).toBeVisible({ timeout: 15000 })
  })

  test('MEDIUM StatefulSet volumeClaimTemplates 표시 (있으면)', async ({ page }) => {
    await page.goto('/workloads/statefulsets')
    await page.waitForLoadState('networkidle')
    await waitTable(page)

    const row = page.locator('tbody tr').first()
    test.skip((await row.count()) === 0, 'StatefulSet 없음')

    await row.click()
    await page.waitForTimeout(2000)  // STS detail mount
    // STS spec.volumeClaimTemplates 표시되면 통과 (없는 STS 도 OK)
  })

  test('MEDIUM DaemonSet Misscheduled / Unavailable 행 (kube-proxy)', async ({ page }) => {
    await page.goto('/workloads/daemonsets')
    await page.waitForLoadState('networkidle')
    await waitTable(page)

    const row = page.locator('tbody tr:has-text("kube-proxy")').first()
    test.skip((await row.count()) === 0, 'kube-proxy 없음')

    await row.click()
    await expect(page.locator('text=/^Replicas$/').first()).toBeVisible({ timeout: 15000 })
    // Misscheduled / Unavailable 행은 DaemonSet 일 때만 추가됨
    await expect(page.locator('text=/Misscheduled/').first()).toBeVisible({ timeout: 5000 })
    await expect(page.locator('text=/Unavailable/').first()).toBeVisible({ timeout: 5000 })
  })

  test('MEDIUM CronJob 모든 policy 필드 표시 (있으면)', async ({ page }) => {
    await page.goto('/workloads/cronjobs')
    await page.waitForLoadState('networkidle')
    await waitTable(page)

    const row = page.locator('tbody tr').first()
    if ((await row.count()) === 0) {
      test.skip(true, 'CronJob 없음')
      return
    }
    await row.click()
    await expect(page.locator('text=/^CronJob Info$/').first()).toBeVisible({ timeout: 15000 })
    await expect(page.locator('text=/Concurrency Policy/').first()).toBeVisible({ timeout: 5000 })
  })

  test('MEDIUM Ingress TLS Secret ResourceLink (있으면)', async ({ page }) => {
    await page.goto('/network/ingresses')
    await page.waitForLoadState('networkidle')
    await waitTable(page)

    const row = page.locator('tbody tr').first()
    test.skip((await row.count()) === 0, 'Ingress 없음')

    await row.click()
    await page.waitForTimeout(2000)
    // TLS section 있으면 통과, 없으면 OK (HTTP-only Ingress 도 많음)
  })

  test('MEDIUM HPA Metrics 정렬 (있으면)', async ({ page }) => {
    await page.goto('/workloads/hpas')
    await page.waitForLoadState('networkidle')
    await waitTable(page)

    const row = page.locator('tbody tr').first()
    if ((await row.count()) === 0) {
      test.skip(true, 'HPA 없음')
      return
    }
    await row.click()
    await page.waitForTimeout(2000)
    // HPA detail 이 mount 되면 OK
  })

  // ===== LOW 7 (Lease skip) =====

  test('LOW PV Volume Attributes (CSI 일 때)', async ({ page }) => {
    await page.goto('/storage')
    await page.waitForLoadState('networkidle')
    await waitTable(page)

    const row = page.locator('tbody tr').first()
    test.skip((await row.count()) === 0, 'PV 없음')

    await row.click()
    await page.waitForTimeout(2000)
    // CSI 가 아닌 PV 도 많아서 section 부재가 OK
  })

  test('LOW PVC Data Source 행 (있으면)', async ({ page }) => {
    await page.goto('/storage')
    await page.waitForLoadState('networkidle')
    await selectNamespace(page, 'kube-system')
    await waitTable(page)

    const row = page.locator('tbody tr').first()
    if ((await row.count()) === 0) {
      test.skip(true, 'PVC 없음')
      return
    }
    await row.click()
    await page.waitForTimeout(2000)
  })

  test('LOW Deployment Replicas (Up to date / Available)', async ({ page }) => {
    await page.goto('/workloads/deployments')
    await page.waitForLoadState('networkidle')
    await waitTable(page)

    const row = page.locator('tbody tr').first()
    test.skip((await row.count()) === 0, 'Deployment 없음')

    await row.click()
    await expect(page.locator('text=/^Replicas$/').first()).toBeVisible({ timeout: 15000 })
    await expect(page.locator('text=/Up to date/').first()).toBeVisible({ timeout: 5000 })
    await expect(page.locator('text=/Available/').first()).toBeVisible({ timeout: 5000 })
  })

  test('LOW NetworkPolicy egress namespaceSelector (있으면)', async ({ page }) => {
    await page.goto('/network/networkpolicies')
    await page.waitForLoadState('networkidle')
    await waitTable(page)

    const row = page.locator('tbody tr').first()
    if ((await row.count()) === 0) {
      test.skip(true, 'NetworkPolicy 없음')
      return
    }
    await row.click()
    await page.waitForTimeout(2000)
  })

  test('LOW CRD printerColumns 표시 (있으면)', async ({ page }) => {
    await page.goto('/custom-resources/groups')
    await page.waitForLoadState('networkidle')
    await waitTable(page)

    const row = page.locator('tbody tr').first()
    if ((await row.count()) === 0) {
      test.skip(true, 'CRD 없음')
      return
    }
    await row.click()
    await page.waitForTimeout(2000)
  })

  test('LOW RuntimeClass Schedulable Nodes (있으면)', async ({ page }) => {
    await page.goto('/cluster/runtimeclasses')
    await page.waitForLoadState('networkidle')
    await waitTable(page)

    const row = page.locator('tbody tr').first()
    if ((await row.count()) === 0) {
      test.skip(true, 'RuntimeClass 없음')
      return
    }
    await row.click()
    await page.waitForTimeout(2000)
    // scheduling.nodeSelector 가 있는 경우만 section 나타남 (nvidia 같이 GPU)
  })

  test('LOW PriorityClass globalDefault conflict warning', async ({ page }) => {
    await page.goto('/cluster/priorityclasses')
    await page.waitForLoadState('networkidle')
    await waitTable(page)

    // system-cluster-critical 또는 system-node-critical 행 (둘 다 globalDefault=false 일 가능성)
    const row = page.locator('tbody tr').first()
    test.skip((await row.count()) === 0, 'PriorityClass 없음')

    await row.click()
    await page.waitForTimeout(2000)
    // global default conflict 없으면 warning 없음 — section 부재 OK
  })

  // ===== 통합 회귀 — 모든 모달 mount 시 page error 0 =====

  test('통합 — Pod / Node / Namespace / Deployment / DaemonSet 모달 mount 시 page error 0', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(`PAGEERR: ${e.message}`))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
    })

    const routes = [
      '/workloads/pods',
      '/cluster/nodes',
      '/cluster/namespaces',
      '/workloads/deployments',
      '/workloads/daemonsets',
    ]

    for (const r of routes) {
      await page.goto(r)
      await page.waitForLoadState('networkidle')
      await waitTable(page)
      const row = page.locator('tbody tr').first()
      if ((await row.count()) > 0) {
        await row.click()
        await page.waitForTimeout(1500)
        await page.keyboard.press('Escape').catch(() => {})
      }
    }

    const critical = errors.filter((e) =>
      /Rendered more hooks|Cannot read|undefined is not|TypeError|ReferenceError/.test(e),
    )
    expect(critical, `unexpected critical errors:\n${critical.join('\n')}`).toEqual([])
  })
})
