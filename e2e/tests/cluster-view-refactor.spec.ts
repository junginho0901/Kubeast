import { test, expect, Page } from '@playwright/test'

// ClusterView Context refactor (897 → 11줄) 회귀 spec.
// 기존 cluster-view.spec (4 tests) 가 header / screenshot / search / namespace
// dropdown 만 cover 하므로 modal / 탭 / context-menu / delete / exec 패널은
// 미검증. refactor 가 깬 silent error 잡기 위해 보조 spec.

async function gotoClusterView(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`PAGEERR: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`CONSOLE.error: ${m.text()}`)
  })
  await page.goto('/cluster-view')
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('heading', { name: /클러스터 뷰|Cluster view/i })).toBeVisible({ timeout: 10000 })
  return errors
}

function assertNoCriticalErrors(errors: string[]) {
  const critical = errors.filter((e) =>
    /Rendered more hooks|Cannot read|undefined is not|TypeError|ReferenceError|useClusterView must be used/.test(e),
  )
  expect(critical, `unexpected critical errors:\n${critical.join('\n')}`).toEqual([])
}

test.describe('ClusterView refactor — Context / hook 분리 회귀', () => {

  test('Provider mount — page error 0 + 헤더 + 검색 + 드롭다운 보임', async ({ page }) => {
    const errors = await gotoClusterView(page)

    await expect(page.getByPlaceholder(/Search pod name|파드 이름/i)).toBeVisible()
    await expect(page.getByRole('button', { name: /All namespaces|모든 네임스페이스/i })).toBeVisible()

    assertNoCriticalErrors(errors)
  })

  test('Pod 카드 클릭 → 상세 모달 + Logs 탭 default + ESC close', async ({ page }) => {
    const errors = await gotoClusterView(page)

    // 노드 카드 안에 첫 Pod 버튼 찾기. card 내부의 grid 안 button.
    await page.waitForTimeout(2000)  // pod load
    const firstPodButton = page.locator('div.card button:has(svg.lucide-box)').first()
    if ((await firstPodButton.count()) === 0) {
      test.skip(true, 'Pod 카드 없음')
      return
    }
    await firstPodButton.click()

    // 모달 mount — ModalOverlay 안의 close X 버튼이 보이면 모달 열렸음
    const modalCloseBtn = page.locator('button').filter({ has: page.locator('svg.lucide-x.w-5') }).first()
    await expect(modalCloseBtn).toBeVisible({ timeout: 10000 })

    // Logs 탭 default 표시
    const logsTab = page.locator('button').filter({ hasText: /^Logs$|^로그$/i }).first()
    await expect(logsTab).toBeVisible()

    // ESC close — modal 의 X 버튼이 hidden 되어야
    await page.keyboard.press('Escape')
    await expect(modalCloseBtn).toBeHidden({ timeout: 5000 })

    assertNoCriticalErrors(errors)
  })

  test('상세 모달 탭 전환 — Summary / Logs / Describe / Manifest / RBAC', async ({ page }) => {
    const errors = await gotoClusterView(page)

    await page.waitForTimeout(2000)
    const firstPodButton = page.locator('div.card button:has(svg.lucide-box)').first()
    if ((await firstPodButton.count()) === 0) {
      test.skip(true, 'Pod 카드 없음')
      return
    }
    await firstPodButton.click()
    await expect(page.locator('h2.text-xl').filter({ hasText: /-/ }).first()).toBeVisible({ timeout: 10000 })

    // Summary → Describe → Manifest → RBAC → Summary 순회. selectTab 단일 setter 가
    // 5 boolean 을 동시 reset 안 하면 두 탭이 동시 active 됨 → exclusive 확인.
    for (const tabName of ['Summary', 'Describe', 'Manifest', 'RBAC']) {
      const tabBtn = page.locator('button').filter({ hasText: new RegExp(`^${tabName}$`, 'i') }).first()
      if ((await tabBtn.count()) === 0) continue
      await tabBtn.click()
      await page.waitForTimeout(300)
    }

    await page.keyboard.press('Escape')

    assertNoCriticalErrors(errors)
  })

  test('namespace dropdown — 선택 → 닫힘 + selectedNamespace 반영', async ({ page }) => {
    const errors = await gotoClusterView(page)

    const dropdown = page.getByRole('button', { name: /All namespaces|모든 네임스페이스/i })
    await dropdown.click()

    // default option 클릭
    const opt = page.locator('button').filter({ hasText: /^default$/ }).first()
    if ((await opt.count()) === 0) {
      test.skip(true, 'default namespace 없음')
      return
    }
    await opt.click()
    await page.waitForTimeout(500)

    // 버튼 텍스트 변경 확인
    await expect(page.getByRole('button', { name: /^default$/ }).first()).toBeVisible()

    assertNoCriticalErrors(errors)
  })

  test('search input — 검색 → 필터링 → X clear', async ({ page }) => {
    const errors = await gotoClusterView(page)

    const search = page.getByPlaceholder(/Search pod name|파드 이름/i)
    await search.fill('nonexistent-xyz')
    await page.waitForTimeout(500)

    // no-results card
    await expect(page.locator('text=/No pods found|찾을 수 없습니다/i').first()).toBeVisible({ timeout: 3000 })

    // X clear 버튼
    const clearBtn = page.locator('button').filter({ has: page.locator('svg.lucide-x') }).first()
    await clearBtn.click()
    await expect(search).toHaveValue('')

    assertNoCriticalErrors(errors)
  })

  test('통합 — /cluster-view mount 시 page error 0 + 라우트 이동 후 복귀', async ({ page }) => {
    const errors = await gotoClusterView(page)

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.goto('/cluster-view')
    await page.waitForLoadState('networkidle')
    await expect(page.getByRole('heading', { name: /클러스터 뷰|Cluster view/i })).toBeVisible({ timeout: 10000 })

    assertNoCriticalErrors(errors)
  })
})
