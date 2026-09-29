import { test, expect } from '@playwright/test'
import fs from 'fs'

// Audit log CSV export: the button downloads a CSV of the applied filter and
// the export itself is recorded as admin.audit.export.
test.describe('audit log CSV export', () => {
  test('downloads a CSV and records the export', async ({ page, request }) => {
    await page.goto('/admin/audit')
    await expect(page.getByTestId('audit-export-csv')).toBeVisible()

    const downloadPromise = page.waitForEvent('download')
    await page.getByTestId('audit-export-csv').click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/^audit-logs-\d{8}-\d{6}\.csv$/)

    const text = fs.readFileSync((await download.path()) as string, 'utf8')
    expect(text.startsWith('﻿')).toBeTruthy()
    const lines = text.replace(/^﻿/, '').split('\r\n')
    expect(lines[0]).toBe(
      'id,created_at,service,action,result,error,actor_email,actor_user_id,cluster,namespace,target_type,target_id,target_email,request_ip,request_id,path,before,after',
    )
    // The audit log of a live cluster is never empty (logins are recorded).
    expect(lines.length).toBeGreaterThan(2)

    const res = await request.get('/api/v1/auth/admin/audit-logs?action=admin.audit.export&limit=1')
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    expect(body.total).toBeGreaterThan(0)
    const raw = body.items[0].After ?? body.items[0].after
    const after = typeof raw === 'string' ? JSON.parse(raw) : raw
    expect(after.rows).toBeGreaterThan(0)
  })
})
