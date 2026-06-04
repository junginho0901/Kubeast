import { test, expect, Page } from '@playwright/test'

// SSE migration 회귀 — Pod Logs + Helm Watch 가 WebSocket 에서 SSE 로 전환
// 후에도 정상 동작 + 사용자가 본 "여러 logs 왔다갔다 stuck" 회귀 방지.

async function gotoClusterView(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`PAGEERR: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`CONSOLE.error: ${m.text()}`)
  })
  await page.goto('/cluster-view')
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByRole('heading', { name: /클러스터 뷰|Cluster view/i })).toBeVisible({ timeout: 15000 })
  return errors
}

function assertNoCriticalErrors(errors: string[]) {
  const critical = errors.filter((e) =>
    /Rendered more hooks|Cannot read|undefined is not|TypeError|ReferenceError/.test(e),
  )
  expect(critical, `unexpected critical errors:\n${critical.join('\n')}`).toEqual([])
}

async function openFirstPod(page: Page) {
  await page.waitForTimeout(2000)
  const firstPod = page.locator('div.card button:has(svg.lucide-box)').first()
  if ((await firstPod.count()) === 0) return null
  await firstPod.click()
  await expect(page.locator('button').filter({ has: page.locator('svg.lucide-x.w-5') }).first())
    .toBeVisible({ timeout: 10000 })
  return firstPod
}

async function closeModal(page: Page) {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
}

test.describe('SSE migration — Pod Logs', () => {

  test('Pod logs SSE 연결 — 컨테이너 선택 후 로그 영역 mount', async ({ page }) => {
    const errors = await gotoClusterView(page)

    const opened = await openFirstPod(page)
    test.skip(!opened, 'Pod 없음')

    // 모달의 Logs 탭은 default 활성. Container dropdown 이 보이고 + 로그 영역 mount.
    await expect(page.locator('text=/Container$|컨테이너/i').first()).toBeVisible({ timeout: 5000 })
    // 로그 영역 (font-mono pre) — 'No logs available' 또는 실제 로그
    await expect(page.locator('pre.whitespace-pre-wrap').first()).toBeVisible({ timeout: 10000 })

    await closeModal(page)
    assertNoCriticalErrors(errors)
  })

  test('Pod logs SSE — 여러 Pod 빠르게 왔다갔다 후 stuck 없음 (회귀 방지)', async ({ page }) => {
    const errors = await gotoClusterView(page)
    await page.waitForTimeout(2000)

    const pods = page.locator('div.card button:has(svg.lucide-box)')
    const count = await pods.count()
    test.skip(count < 3, '3개 이상 Pod 필요')

    // 5번 왔다갔다 — 매번 모달 열고 닫기
    for (let i = 0; i < 5; i++) {
      const podIdx = i % Math.min(count, 5)
      await pods.nth(podIdx).click()
      await expect(page.locator('button').filter({ has: page.locator('svg.lucide-x.w-5') }).first())
        .toBeVisible({ timeout: 10000 })
      await page.waitForTimeout(500)  // 로그 도착 시간
      await closeModal(page)
    }

    // 마지막으로 첫 Pod 한 번 더 열기 → 로그 영역 정상 mount (stuck 검증)
    await pods.first().click()
    await expect(page.locator('pre.whitespace-pre-wrap').first()).toBeVisible({ timeout: 10000 })

    // page error 0 — race / cleanup leak 검출
    assertNoCriticalErrors(errors)
    await closeModal(page)
  })

  test('Pod logs SSE — 모달 안에서 로그 영역 + Container label 가시', async ({ page }) => {
    const errors = await gotoClusterView(page)

    const opened = await openFirstPod(page)
    test.skip(!opened, 'Pod 없음')

    // 로그 영역 + Container 레이블 둘 다 보임 (SSE 가 연결되어 로그 또는 'No logs available')
    await expect(page.locator('pre.whitespace-pre-wrap').first()).toBeVisible({ timeout: 10000 })
    await expect(page.locator('text=/^Container$|^컨테이너$/i').first()).toBeVisible({ timeout: 3000 })

    await closeModal(page)
    assertNoCriticalErrors(errors)
  })

  test('Pod logs SSE — 라우트 이동 후 복귀 (자동 reconnect)', async ({ page }) => {
    const errors = await gotoClusterView(page)

    const opened = await openFirstPod(page)
    test.skip(!opened, 'Pod 없음')

    await page.waitForTimeout(1000)
    await closeModal(page)

    // 다른 페이지로 이동 후 복귀
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')
    await page.goto('/cluster-view')
    await page.waitForLoadState('domcontentloaded')

    // 다시 Pod 클릭 → 로그 영역 mount
    await page.waitForTimeout(2000)
    const pods = page.locator('div.card button:has(svg.lucide-box)')
    if ((await pods.count()) > 0) {
      await pods.first().click()
      await expect(page.locator('pre.whitespace-pre-wrap').first()).toBeVisible({ timeout: 10000 })
      await closeModal(page)
    }

    assertNoCriticalErrors(errors)
  })
})

test.describe('SSE migration — Helm Watch', () => {

  test('Helm Releases 페이지 — SSE 구독 + 목록 표시', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(`PAGEERR: ${e.message}`))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`CONSOLE.error: ${m.text()}`)
    })

    await page.goto('/helm/releases')
    // SSE 가 long-lived connection 이라 networkidle 도달 안 함 — DOM mount 기준.
    await page.waitForLoadState('domcontentloaded')

    // 헤더 또는 빈 상태 등 페이지 본체 mount
    await page.waitForTimeout(3000)

    // SSE 가 정상 연결되면 EventSource 가 onmessage 호출. 연결 자체는 visible 검증
    // 어려우므로 page error 0 + 페이지 navigate 성공으로 판단.
    const critical = errors.filter((e) =>
      /Rendered more hooks|Cannot read|undefined is not|TypeError|ReferenceError|sse error frame/.test(e),
    )
    expect(critical).toEqual([])
  })

  test('Helm Releases — 30초 keepalive 유지 (자동 끊김 없음)', async ({ page }) => {
    test.setTimeout(120_000)  // 60s 대기 + 마진
    const errors: string[] = []
    let sseEvents = 0
    page.on('pageerror', (e) => errors.push(`PAGEERR: ${e.message}`))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`CONSOLE.error: ${m.text()}`)
      if (m.type() === 'warning' && /sse closed|sse error/.test(m.text())) sseEvents++
    })

    await page.goto('/helm/releases')
    // SSE 가 long-lived connection 이라 networkidle 도달 안 함 — DOM mount 기준.
    await page.waitForLoadState('domcontentloaded')

    // 60초 대기 — proxy idle timeout (보통 30s/60s) 보다 길게.
    // backend 의 ': keepalive\n\n' 이 30s 마다 도착해서 끊김 방지해야.
    await page.waitForTimeout(60_000)

    // sse 끊김 경고가 없어야 함
    expect(sseEvents).toBe(0)
    const critical = errors.filter((e) =>
      /Rendered more hooks|Cannot read|TypeError|sse closed/.test(e),
    )
    expect(critical).toEqual([])
  })

  test('Helm Releases — 라우트 이동 후 복귀 + 자동 reconnect', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(`PAGEERR: ${e.message}`))

    await page.goto('/helm/releases')
    // SSE 가 long-lived connection 이라 networkidle 도달 안 함 — DOM mount 기준.
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000)

    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')

    await page.goto('/helm/releases')
    // SSE 가 long-lived connection 이라 networkidle 도달 안 함 — DOM mount 기준.
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000)

    assertNoCriticalErrors(errors)
  })
})
