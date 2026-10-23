import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import { XRW, beat, clip, kubectl } from './clip'

// An alert about the shop's crashing API reaches the webhook; the clip opens it in the Alerts inbox once the
// investigation is done and reads the report. The wait for the investigation is cut. The alerts of earlier
// recordings are sent resolved first, and the inbox is shown firing and critical only, so the dev cluster's
// test alerts stay out of the picture.
test('alert-investigation', async ({ page }) => {
  const c = clip(page, 'alert-investigation')
  await page.goto('/alerts?cluster=default')
  const name = 'KubePodCrashLooping'
  const labels = { alertname: name, severity: 'critical', namespace: 'shop', deployment: 'checkout-api', container: 'api' }
  const investigations = async () =>
    (await (await page.request.get('/api/v1/ai/investigations', { headers: XRW, params: { cluster: 'default', limit: 50 } })).json())
      .items as Array<{ id: string; alertname: string; status: string }>
  const inbox = async () =>
    (await (await page.request.get('/api/v1/alerts/inbox', { headers: XRW, params: { cluster: 'default', limit: 200 } })).json())
      .items as Array<{ id: string; alertname: string; status: string; fingerprint: string }>

  const token = Buffer.from(
    kubectl('kubeast', ['-n', 'kubeast', 'get', 'secret', 'kubeast-secrets', '-o', 'jsonpath={.data.ALERT_WEBHOOK_TOKEN}']).trim(),
    'base64',
  ).toString()
  const send = async (status: string, alerts: object[]) => {
    const res = await page.request.post('/api/v1/alerts/webhook?cluster=default', {
      headers: { Authorization: `Bearer ${token}` },
      data: { version: '4', groupKey: `{}:{alertname="${name}"}`, status, receiver: 'kubeast', externalURL: 'http://alertmanager.monitoring:9093', alerts },
    })
    expect(res.ok(), await res.text()).toBeTruthy()
  }
  const earlier = (await inbox()).filter((i) => i.alertname === name && i.status === 'firing')
  if (earlier.length) {
    const now = new Date().toISOString()
    await send('resolved', earlier.map((i) => ({ status: 'resolved', labels, annotations: {}, startsAt: now, endsAt: now, fingerprint: i.fingerprint })))
  }

  const before = new Set((await investigations()).map((i) => i.id))
  await send('firing', [{
    status: 'firing',
    labels,
    annotations: { summary: 'checkout-api in shop is restarting repeatedly (CrashLoopBackOff).' },
    startsAt: new Date().toISOString(),
    generatorURL: 'http://prometheus.monitoring:9090/graph',
    fingerprint: randomUUID().replaceAll('-', '').slice(0, 16),
  }])
  await expect
    .poll(async () => (await investigations()).find((i) => i.alertname === name && !before.has(i.id))?.status, {
      timeout: 360_000,
      intervals: [5_000],
    })
    .toBe('done')
  const row = (await inbox()).find((i) => i.alertname === name && i.status === 'firing')!

  await page.goto('/alerts?cluster=default')
  await page.getByTestId('alert-tab-firing').click()
  await page.locator('div.w-40').filter({ hasText: 'Severity' }).getByRole('button').first().click()
  await page.getByRole('button', { name: 'critical', exact: true }).click()
  await expect(page.getByTestId(`alert-row-${row.id}`)).toBeVisible({ timeout: 15_000 })
  await page.waitForLoadState('networkidle')
  c.show()
  c.step('inbox')
  await beat(page, 2000)
  await page.getByTestId(`alert-row-${row.id}`).getByText(/restarting repeatedly/).click()
  const detail = page.getByTestId('alert-detail')
  c.step('alert')
  await expect(detail).toBeVisible()
  await beat(page, 2500)
  await detail.getByTestId('alert-report').click()
  c.step('report')
  const report = page.getByTestId('investigation-modal')
  await expect(report.getByTestId('investigation-report')).toBeVisible()
  await beat(page, 3000)
  await report.getByTestId('investigation-report').hover()
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 250)
    await beat(page, 900)
  }
  await beat(page, 1500)
  await c.save()
})
