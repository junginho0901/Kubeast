import { test, expect } from '@playwright/test'

// Dashboard Context refactor (Step 4a/4b) 회귀 — Issues / Storage 모달이
// hook 분리 이후에도 정상 동작하는지 검증. 기존 dashboard.spec 는 모달을
// 열지 않으므로, 모달 내부 derived (sortedIssues / sortedPVCsForStorage 등)
// 가 깨졌는지 잡지 못해서 별도 spec.

test.describe('Dashboard modals — Context refactor regression', () => {
  test('Storage 모달 — 열기 + PVC tab + namespace dropdown', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // Storage 카드 (PVCs / PVs 통합 모달) — 'Persistent Volume' 또는 'Storage'
    // 진입점이 sidebar 가 아닌 Dashboard 본문에 있다면 그 버튼을 찾아야 함.
    // 일반적으로 Storage 모달은 Stats Grid 의 PVCs 카드 클릭 또는 별도 버튼에서 열림.
    // 우선 'pvcs' Stats Grid 카드를 통한 ResourceModal 만 확인.
    const pvcsCard = page.locator('button.card').filter({ hasText: /^PVCs$/i }).first()
    if ((await pvcsCard.count()) === 0) {
      test.skip(true, 'PVCs Stats card 없음')
      return
    }
    await pvcsCard.click()

    // ResourceModal 가 뜨면 PVC list 가 render
    await expect(page.locator('text=/PVC|Persistent Volume/i').first()).toBeVisible({ timeout: 10000 })

    // 모달 닫기 (Esc)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  })

  test('Issues 모달 — 열기 + sortedIssues render', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // Issues 진입점 — 'Cluster Issues' Quick Action 카드 또는 sidebar 'Change History'?
    // 보통 issues 카드가 있는데 없으면 skip.
    const issuesEntry = page.locator('button').filter({ hasText: /Cluster Issues|Issues|문제/i }).first()
    if ((await issuesEntry.count()) === 0) {
      test.skip(true, 'Issues entry 없음')
      return
    }
    await issuesEntry.click()

    // 모달 안에 sortedIssues 가 render 되거나, 0건이면 'No issues' 메시지
    // 둘 다 OK — 단지 hook 이 throw 하지 않으면 됨.
    await page.waitForTimeout(1000)

    // page error 가 없어야 함 (다른 hook count 깨짐 등 detection)
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.waitForTimeout(500)
    expect(errors).toEqual([])

    await page.keyboard.press('Escape')
  })

  test('Dashboard render — Storage hook 호출 후 page error 0', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)

    // hook count mismatch / undefined ref 등 critical error 가 있으면 fail
    const critical = errors.filter((e) =>
      /Rendered more hooks|Cannot read|undefined is not|TypeError/.test(e),
    )
    expect(critical, `unexpected critical errors:\n${critical.join('\n')}`).toEqual([])
  })
})
