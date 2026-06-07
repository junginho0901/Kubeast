import { test, expect } from '@playwright/test'

// Multi-cluster UI — cluster context (step 09).
//
// The selected cluster lives in the URL query (?cluster=), is mirrored into a
// module ref, and the axios interceptor injects it into every backend API call.
// A localStorage fallback covers navigations that arrive without the query.
// (The ClusterPicker UI that lets a user switch is step 11; here we assert the
// plumbing — that the selection actually reaches the backend.)

const CLUSTER_LS_KEY = 'kubeast:current-cluster'

function clusterParamIs(value: string) {
  return (req: { url(): string }) => {
    if (!req.url().includes('/api/v1/')) return false
    try {
      return new URL(req.url()).searchParams.get('cluster') === value
    } catch {
      return false
    }
  }
}

test.describe('multi-cluster UI — cluster context (step 09)', () => {
  test('?cluster= in the URL is injected into backend API calls', async ({ page }) => {
    const req = page.waitForRequest(clusterParamIs('default'), { timeout: 20000 })
    await page.goto('/?cluster=default')
    await page.waitForLoadState('domcontentloaded')
    expect(new URL((await req).url()).searchParams.get('cluster')).toBe('default')
  })

  test('falls back to the localStorage selection when the query is absent', async ({ page }) => {
    // Seed a prior selection (what the picker would persist in step 11).
    await page.goto('/?cluster=default')
    await page.evaluate(
      (k) => localStorage.setItem(k, 'default'),
      CLUSTER_LS_KEY,
    )

    // Navigate WITHOUT the query → the provider should fall back to localStorage
    // and the interceptor should still inject ?cluster=default.
    const req = page.waitForRequest(clusterParamIs('default'), { timeout: 20000 })
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')
    expect(new URL((await req).url()).searchParams.get('cluster')).toBe('default')
  })
})
