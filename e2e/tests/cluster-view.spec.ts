import { test, expect } from '@playwright/test'

// ClusterView 회귀 baseline — Phase 3.1 분할 (2,564줄 → 6+ sub-file) 의 안전망.
// 각 sub-PR (Context Menu / Delete / Summary / Logs / RBAC) 마다 이 spec 가
// 자동 cover. 데이터 변화 (pod 갱신) 에 robust 하게 mask + maxDiffPixels 여유.

test.describe('ClusterView', () => {
  test('initial render — header + search input visible', async ({ page }) => {
    await page.goto('/cluster-view')
    await page.waitForLoadState('networkidle')

    // 페이지 title
    await expect(
      page.getByRole('heading', { name: /클러스터 뷰|Cluster view/i }),
    ).toBeVisible()

    // 검색 input + 네임스페이스 드롭다운
    await expect(page.getByPlaceholder(/Search pod name|Pod 이름/i)).toBeVisible()
    await expect(page.getByRole('button', { name: /All namespaces|모든 Namespace/i })).toBeVisible()
    await expect(page).toHaveTitle(/^Cluster View · Kubeast$/)
  })

  test('initial render — full page screenshot', async ({ page }) => {
    await page.goto('/cluster-view')
    await page.waitForLoadState('networkidle')

    // pod 카드 / 노드 카드 영역 mask: pod restart count / age / 사용량 같은
    // 동적 데이터로 매번 픽셀 변화가 있음. 헤더 + 레이아웃만 비교.
    await expect(page).toHaveScreenshot('cluster-view-initial.png', {
      fullPage: true,
      animations: 'disabled',
      maxDiffPixels: 800,
      mask: [
        // 노드 카드 안의 pod 그리드 (가장 변동 큼)
        page.locator('[class*="grid"]').filter({ hasText: /running|pending|completed/i }),
      ],
    })
  })

  test('search input — typing filters pod cards', async ({ page }) => {
    await page.goto('/cluster-view')
    await page.waitForLoadState('networkidle')

    const search = page.getByPlaceholder(/Search pod name|Pod 이름/i)
    await search.fill('exec-test-pod')

    // 검색 결과로 좁혀지면 X (clear) 버튼 노출 (input 옆 X 아이콘)
    // X 버튼 클릭 → 검색어 비워짐
    const clearButton = page.locator('button').filter({ has: page.locator('svg.lucide-x') }).first()
    await expect(clearButton).toBeVisible({ timeout: 3000 })

    await clearButton.click()
    await expect(search).toHaveValue('')
  })

  test('namespace dropdown — opens and closes', async ({ page }) => {
    await page.goto('/cluster-view')
    await page.waitForLoadState('networkidle')

    // (the open list has an "All namespaces" option too: the trigger is the first)
    const dropdown = page.getByRole('button', { name: /All namespaces|모든 Namespace/i }).first()
    await dropdown.click()

    // 드롭다운 열리면 'default' option 노출 (admin 계정 / kubeast 클러스터) — kube-system appears only in the list
    await expect(page.getByText('default', { exact: true }).first()).toBeVisible({ timeout: 3000 })
    const option = page.locator('button').filter({ hasText: /^kube-system$/ })
    await expect(option).toHaveCount(1)

    // 다시 클릭으로 닫기
    await dropdown.click()
    await expect(option).toHaveCount(0)
  })
})
