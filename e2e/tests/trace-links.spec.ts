import { execSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect, type APIRequestContext } from '@playwright/test'

// Trace links (features.tracing) against scripts/kind-logsearch.sh + scripts/kind-tracing.sh: Loki and Jaeger in
// the second cluster. A Job there sends a span to Jaeger and an OTLP log with the same trace ID to Loki (the
// trace ID arrives as structured metadata), and prints a line with another trace ID in its text and one without.
// The log search returns each line's trace ID, the screen links the two with one, and the linked trace is in
// Jaeger. The Pod drawer links to a search for the pod's service. Skipped while either feature is off.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const CLUSTER = 'default'
const NS = 'default'
const STORE_CLUSTER_LABEL = 'kubeast-b'
const SERVICE = 'e2e-trace-svc'
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

type Line = { pod: string; line: string; service?: string; traceId?: string }

function storeKubectl(args: string): string {
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-trace-')), 'kubeconfig')
  fs.writeFileSync(kcPath, execSync('kind get kubeconfig --name kubeast-b', { encoding: 'utf8' }), { mode: 0o600 })
  return execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

async function login(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok(), `admin login: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

const attr = (key: string, value: string) => ({ key, value: { stringValue: value } })

test.describe('trace links', () => {
  let admin = ''
  let traceUrl = ''
  let searchUrl = ''
  const job = `e2e-trace-${Date.now().toString(36)}`
  const marker = `${job}-marker`
  const traceA = randomBytes(16).toString('hex') // span in Jaeger + OTLP log (structured metadata)
  const traceB = randomBytes(16).toString('hex') // in the line text only
  let pod = ''

  test.beforeAll(async ({ request }) => {
    admin = await login(request)
    const features = await (await request.get('/api/v1/cluster/features', { headers: bearer(admin) })).json()
    if (!features.tracing?.enabled || !features.logSearch?.clusters?.includes(CLUSTER)) return
    traceUrl = features.tracing.traceUrl
    searchUrl = features.tracing.searchUrl

    const now = `${Date.now()}000000`
    const spanId = randomBytes(8).toString('hex')
    const span = {
      resourceSpans: [{ resource: { attributes: [attr('service.name', SERVICE)] }, scopeSpans: [{ spans: [{ traceId: traceA, spanId, name: 'e2e-request', kind: 2, startTimeUnixNano: now, endTimeUnixNano: now }] }] }],
    }
    const log = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              attr('k8s.cluster.name', STORE_CLUSTER_LABEL),
              attr('k8s.namespace.name', NS),
              attr('k8s.pod.name', '__POD__'),
              attr('k8s.container.name', 'emit'),
              attr('service.name', SERVICE),
            ],
          },
          scopeLogs: [{ logRecords: [{ timeUnixNano: now, body: { stringValue: `${marker} otlp` }, traceId: traceA, spanId }] }],
        },
      ],
    }
    const yaml = [
      'apiVersion: batch/v1',
      'kind: Job',
      `metadata: {name: ${job}, namespace: ${NS}}`,
      'spec:',
      '  backoffLimit: 0',
      '  template:',
      '    spec:',
      '      restartPolicy: Never',
      '      containers:',
      '        - name: emit',
      '          image: docker.io/curlimages/curl:8.23.0',
      '          env:',
      '            - {name: POD_NAME, valueFrom: {fieldRef: {fieldPath: metadata.name}}}',
      `            - {name: SPAN_JSON, value: '${JSON.stringify(span)}'}`,
      `            - {name: LOG_JSON, value: '${JSON.stringify(log)}'}`,
      '          command: [sh, -c]',
      '          args:',
      '            - |',
      '              set -e',
      '              curl -fsS -o /dev/null -H "Content-Type: application/json" -d "$SPAN_JSON" http://jaeger.tracing.svc:4318/v1/traces',
      '              echo "$LOG_JSON" | sed "s/__POD__/$POD_NAME/" | curl -fsS -o /dev/null -H "Content-Type: application/json" -d @- http://loki.loki.svc:3100/otlp/v1/logs',
      `              echo "${marker} text trace_id=${traceB}"`,
      `              echo "${marker} plain"`,
    ].join('\n')
    const create = await request.post(`/api/v1/cluster/resources/yaml/create?cluster=${CLUSTER}`, { headers: bearer(admin), data: { yaml, namespace: NS } })
    expect(create.ok(), await create.text()).toBeTruthy()
    await expect
      .poll(
        async () => {
          const res = await request.get(`/api/v1/namespaces/${NS}/logsearch?cluster=${CLUSTER}&q=${marker}`, { headers: bearer(admin) })
          const lines: Line[] = res.ok() ? (await res.json()).lines : []
          pod = lines.find((l) => l.line.endsWith(' plain'))?.pod ?? ''
          return lines.length
        },
        { timeout: 120_000, intervals: [3000] },
      )
      .toBe(3)
  })

  test.afterAll(async ({ request }) => {
    if (admin && pod) await request.delete(`/api/v1/namespaces/${NS}/jobs/${job}?cluster=${CLUSTER}`, { headers: bearer(admin), failOnStatusCode: false })
  })

  test.beforeEach(() => {
    test.skip(!pod, 'trace links or log search are off — run scripts/kind-logsearch.sh up and scripts/kind-tracing.sh up')
  })

  test('the search gives each line its trace ID, from the store metadata or the text, and the trace is in Jaeger', async ({ request }) => {
    const res = await request.get(`/api/v1/namespaces/${NS}/logsearch?cluster=${CLUSTER}&q=${marker}`, { headers: bearer(admin) })
    expect(res.status()).toBe(200)
    const lines: Line[] = (await res.json()).lines
    const by = (suffix: string) => lines.find((l) => l.line.endsWith(suffix))
    expect(by(' otlp')?.traceId).toBe(traceA)
    expect(by(' otlp')?.service).toBe(SERVICE)
    expect(by(' otlp')?.pod).toBe(pod)
    expect(by(`trace_id=${traceB}`)?.traceId).toBe(traceB)
    expect(by(' plain')?.traceId).toBeUndefined()

    const trace = JSON.parse(storeKubectl(`get --raw /api/v1/namespaces/tracing/services/jaeger:16686/proxy/api/traces/${traceA}`))
    expect(trace.data?.[0]?.traceID).toBe(traceA)
    expect(trace.data[0].spans.map((s: { operationName: string }) => s.operationName)).toEqual(['e2e-request'])
  })

  test('the Pod drawer links the lines with a trace ID and the service search', async ({ page }) => {
    await page.goto(`/workloads/pods?cluster=${CLUSTER}&detail=Pod/${NS}/${pod}`)
    await expect(page.getByTestId('pod-logs-container')).toBeVisible({ timeout: 20000 })
    await page.getByTestId('log-source-search').click()
    await expect(page.getByTestId('logsearch-line')).toHaveCount(3, { timeout: 20000 })

    const links = page.getByTestId('logsearch-line-trace')
    await expect(links).toHaveCount(2)
    const hrefs = (await links.evaluateAll((as) => as.map((a) => a.getAttribute('href')))).sort()
    expect(hrefs).toEqual([traceUrl.replace('{{traceId}}', traceA), traceUrl.replace('{{traceId}}', traceB)].sort())
    await expect(links.first()).toHaveAttribute('target', '_blank')
    await expect(links.first()).toHaveAttribute('rel', 'noopener noreferrer')
    await expect(page.getByTestId('logsearch-line').filter({ hasText: `${marker} plain` }).getByTestId('logsearch-line-trace')).toHaveCount(0)

    // The Job's pod has no app.kubernetes.io labels: its service is the owning Job (OpenTelemetry's order).
    await expect(page.getByTestId('pod-traces-link')).toHaveAttribute('href', searchUrl.replace('{{service}}', job))
  })
})
