import fs from 'node:fs'
import path from 'node:path'

import { test, expect } from '@playwright/test'

// What a page draws does not move once it is on screen. Sampled each animation frame from before the page's first
// script: a list's "Fit" row count, once rows show, stays one number (it was worked out from an estimated row height for
// a frame); the Settings cards below the sections that wait for the server stay where they first show.

const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/en.json'), 'utf8'))

test.describe('layout stays put', () => {
  test('a list\'s Fit row count is one number from the first frame with rows', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __rows: number[] }
      w.__rows = []
      const tick = () => {
        const rows = document.querySelectorAll('main tbody tr.cursor-pointer').length
        if (rows) w.__rows.push(rows)
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await page.goto('/security/serviceaccounts?cluster=self')
    await expect(page.locator('main tbody tr.cursor-pointer').first()).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(1500)
    const rows = await page.evaluate(() => (window as unknown as { __rows: number[] }).__rows)
    expect(rows.length, 'frames sampled with rows').toBeGreaterThan(10)
    expect([...new Set(rows)].length, `row counts seen: ${[...new Set(rows)].join(', ')}`).toBe(1)
  })

  test('Access review draws one row count from the first frame with rows, a section held whole by the page', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.addInitScript(() => {
      const w = window as unknown as { __rows: number[] }
      w.__rows = []
      const tick = () => {
        const rows = document.querySelectorAll('[data-testid="access-review-row"]').length
        if (rows) w.__rows.push(rows)
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await page.goto('/admin/access-review')
    await expect(page.getByTestId('access-review-row').first()).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(1500)
    const rows = await page.evaluate(() => (window as unknown as { __rows: number[] }).__rows)
    expect(rows.length, 'frames sampled with rows').toBeGreaterThan(10)
    expect([...new Set(rows)].length, `row counts seen: ${[...new Set(rows)].join(', ')}`).toBe(1)
  })

  test('the Settings cards do not move when the API keys section and its MCP box arrive', async ({ page }) => {
    const title = EN.account.language.title as string
    await page.addInitScript((text) => {
      const w = window as unknown as { __tops: number[] }
      w.__tops = []
      const tick = () => {
        const h2 = [...document.querySelectorAll('h2')].find((h) => h.textContent?.trim() === text)
        if (h2 && (h2 as HTMLElement).offsetParent) w.__tops.push(Math.round(h2.getBoundingClientRect().top + (document.querySelector('main')?.scrollTop ?? 0)))
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }, title)
    await page.goto('/account')
    await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(1500)
    const tops = await page.evaluate(() => (window as unknown as { __tops: number[] }).__tops)
    expect(tops.length, 'frames sampled with the card on screen').toBeGreaterThan(10)
    expect([...new Set(tops)].length, `positions seen: ${[...new Set(tops)].join(', ')}`).toBe(1)
  })
})
