import { expect, test } from '@playwright/test'

import { XRW, beat, clip } from './clip'

// A shell in a storefront pod from its drawer, then the recording of that session played back.
// The wait for the upload between the two is cut.
test('terminal', async ({ page }) => {
  const c = clip(page, 'terminal')
  const since = new Date().toISOString()
  await page.goto('/workloads/pods?cluster=default')
  await expect(page.locator('main tbody tr').first()).toBeVisible({ timeout: 30_000 })
  c.show()
  c.step('exec')
  await beat(page, 1500)
  await page.getByPlaceholder(/search/i).first().pressSequentially('storefront', { delay: 60 })
  await beat(page, 800)
  await page.getByRole('cell', { name: /^storefront-/ }).first().click()
  const drawer = page.locator('div[class*="fixed"][class*="inset-y-0"][class*="right-0"]').last()
  await expect(drawer).toBeVisible()
  await beat(page, 1500)
  await drawer.getByRole('button', { name: 'Exec', exact: true }).click()
  await expect(page.getByText('Connected', { exact: true })).toBeVisible({ timeout: 20_000 })
  await page.locator('.xterm').last().click()
  c.step('commands')
  for (const line of ['hostname', 'python --version', 'wget -qO- http://127.0.0.1:8080/ | head -n 6']) {
    await beat(page, 700)
    await page.keyboard.type(line, { delay: 55 })
    await page.keyboard.press('Enter')
  }
  await beat(page, 3000)
  await page.keyboard.type('exit', { delay: 55 })
  await page.keyboard.press('Enter')
  await beat(page, 1200)
  c.hide()

  let id = ''
  await expect
    .poll(async () => {
      const list = (await (await page.request.get('/api/v1/cluster/recordings', { headers: XRW, params: { cluster: '', limit: '5' } })).json()) as Array<{
        id: string
        started_at: string
        status: string
        target: string
      }>
      const mine = list.find((r) => r.started_at >= since && r.target.startsWith('storefront-'))
      id = mine?.id ?? ''
      return mine?.status
    }, { timeout: 120_000, intervals: [3_000] })
    .toBe('uploaded')

  await page.goto('/admin/session-recordings')
  await expect(page.getByTestId(`recording-row-${id}`)).toBeVisible({ timeout: 20_000 })
  c.show()
  c.step('replay')
  await beat(page, 2000)
  await page.getByTestId(`recording-play-${id}`).click()
  const player = page.getByTestId('recording-player-modal')
  await expect(player.locator('.ap-player, .ap-wrapper').first()).toBeVisible({ timeout: 15_000 })
  await beat(page, 12_000)
  await c.save()
})
