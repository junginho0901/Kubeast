import { test, expect } from '@playwright/test'

// Console metrics live on each backend's service port for an in-cluster
// scraper. Through the gateway, /metrics is just another SPA path: no
// Prometheus text format, no metric names, and the existing metrics-server
// proxy under /api/v1/cluster/metrics is unaffected.

test.describe('console metrics exposure', () => {
  test('the gateway does not serve the Prometheus endpoint', async ({ request }) => {
    for (const path of ['/metrics', '/api/v1/auth/metrics', '/api/v1/cluster/../metrics']) {
      const res = await request.get(path)
      const body = await res.text()
      expect(body, path).not.toContain('# HELP kubeast_http_requests_total')
      expect(body, path).not.toContain('kubeast_http_request_duration_seconds')
      expect(res.headers()['content-type'] || '', path).not.toContain('text/plain; version=0.0.4')
    }
  })

  test('the metrics-server proxy for pods is still routed', async ({ request }) => {
    const res = await request.get('/api/v1/cluster/metrics/pods?cluster=default')
    expect([200, 404, 503]).toContain(res.status())
    expect(await res.text()).not.toContain('# HELP')
  })
})
