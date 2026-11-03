import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// Number check of Cluster hygiene on self: a check's "(N)" in the picker is the rows picking it lists (exempt
// findings too under "All severities"), the Checks tab gives a check's findings by their own severity as the cards
// count them (a certificate five days from expiry is critical in the warning check tls.expiry), and with more findings than the
// report lists (5000) the Findings tab counts all of them and the note says how many are listed.

const HYGIENE = { path: '/admin/cluster-hygiene', cluster: 'self' }
const NS = 'e2e-hygiene-counts'
const MANY = 5100

const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-number-hygiene-')), 'kubeconfig')
fs.writeFileSync(kcPath, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
const kubectl = (args: string, input?: string) =>
  execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim()

// a certificate that expires in five days: critical (the dev install's critical line is seven days)
function shortLivedCert(dir: string): { crt: string; key: string } {
  const crt = path.join(dir, 'tls.crt')
  const key = path.join(dir, 'tls.key')
  execSync(`openssl req -x509 -newkey rsa:2048 -nodes -days 5 -subj /CN=e2e-hygiene-counts.example.com -keyout ${key} -out ${crt}`, { stdio: 'ignore' })
  return { crt, key }
}

const tlsSecret = (name: string, crt: string, key: string, annotations?: Record<string, string>) => JSON.stringify({
  apiVersion: 'v1', kind: 'Secret', type: 'kubernetes.io/tls', metadata: { name, namespace: NS, ...(annotations ? { annotations } : {}) },
  data: { 'tls.crt': Buffer.from(crt).toString('base64'), 'tls.key': Buffer.from(key).toString('base64') },
})

type Finding = { check: string; severity: string; namespace?: string; name: string; exempt?: boolean }
type Report = {
  counts: { critical: number; warning: number; info: number; exempt: number }
  checks: { id: string; severity: string; findings: number; exempt: number; severities?: Record<string, number> }[]
  findings: Finding[]
  truncated?: boolean
}

const pagerTotal = (n: number) => new RegExp(`of ${n}(?!\\d)|(?<!\\d)${n}개 중`)

async function reportOf(page: Page): Promise<Report> {
  const res = await page.request.get(`/api/v1/cluster/hygiene?cluster=${HYGIENE.cluster}`)
  expect(res.ok(), `hygiene: ${res.status()}`).toBeTruthy()
  return (await res.json()).report
}

async function open(page: Page) {
  await page.goto(`${HYGIENE.path}?cluster=${HYGIENE.cluster}`)
  await page.getByTestId('hygiene-cluster').click()
  await page.getByTestId(`hygiene-cluster-opt-${HYGIENE.cluster}`).click()
  await expect(page.getByTestId('hygiene-summary')).toBeVisible({ timeout: 60_000 })
}

test.describe('Number check — Cluster hygiene', () => {
  test.beforeAll(() => {
    test.setTimeout(240_000)
    kubectl(`delete namespace/${NS} --ignore-not-found --timeout=180s`)
    kubectl(`create namespace ${NS}`)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-hygiene-counts-'))
    const { crt, key } = shortLivedCert(dir)
    const pem = fs.readFileSync(crt, 'utf8')
    const pkey = fs.readFileSync(key, 'utf8')
    for (const doc of [
      tlsSecret('soon-a', pem, pkey),
      tlsSecret('soon-b', pem, pkey),
      tlsSecret('unreadable', 'not a cert', 'unused'),
      tlsSecret('soon-exempt', pem, pkey, { 'kubeast.io/hygiene-exempt': 'tls.expiry', 'kubeast.io/hygiene-exempt-reason': 'e2e test CA' }),
    ]) kubectl('create -f -', doc)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test.afterAll(() => {
    kubectl(`delete namespace/${NS} --wait=false --ignore-not-found`)
  })

  test('a check counts what picking it lists, and its findings by their own severity', async ({ page }) => {
    test.setTimeout(180_000)
    const rep = await reportOf(page)
    expect(rep.truncated ?? false, 'the report lists every finding').toBe(false)
    const mine = rep.findings.filter((f) => f.namespace === NS && f.check === 'tls.expiry')
    // what kubectl made: two expiring in five days (critical), one unreadable (warning), one exempt
    expect(mine.map((f) => `${f.name}:${f.exempt ? 'exempt' : f.severity}`).sort(), 'the fixture findings')
      .toEqual(['soon-a:critical', 'soon-b:critical', 'soon-exempt:exempt', 'unreadable:warning'])
    const tls = rep.findings.filter((f) => f.check === 'tls.expiry')
    const tlsBy = (s: string) => tls.filter((f) => !f.exempt && f.severity === s).length
    const all = rep.counts.critical + rep.counts.warning + rep.counts.info + rep.counts.exempt
    // the API: a check's severities add up to the cards
    for (const s of ['critical', 'warning', 'info'] as const) {
      expect.soft(rep.checks.reduce((n, c) => n + (c.severities?.[s] ?? 0), 0), `the checks' ${s} findings = the ${s} card`).toBe(rep.counts[s])
    }

    await open(page)
    // Findings (N) = every finding
    await expect.soft(page.getByTestId('hygiene-tab-findings'), 'the Findings tab').toContainText(`(${all})`)
    // the picker's "(N)" for tls.expiry is the rows it lists under All severities, exempt ones too
    await page.getByTestId('hygiene-filter-check').click()
    const option = page.getByRole('button', { name: /^(TLS certificate expiry|TLS 인증서 만료) \(\d+\)$/ })
    await expect.soft(option, 'the picker count').toHaveText(new RegExp(`\\(${tls.length}\\)$`))
    await option.click()
    await expect.soft(page.getByTestId('hygiene-pager'), 'the rows it lists').toContainText(pagerTotal(tls.length))
    // the Checks tab: tls.expiry's findings by severity, as the list has them
    await page.getByTestId('hygiene-tab-checks').click()
    const cell = page.getByTestId('hygiene-check-row').filter({ hasText: 'tls.expiry' }).locator('td').nth(1)
    await expect.soft(cell, 'critical in tls.expiry').toContainText(new RegExp(`(Critical|치명) ${tlsBy('critical')}(?!\\d)`))
    await expect.soft(cell, 'warning in tls.expiry').toContainText(new RegExp(`(Warning|경고) ${tlsBy('warning')}(?!\\d)`))
  })

  test('with more findings than the report lists, the tab counts all of them and the note says how many are listed', async ({ page }) => {
    test.setTimeout(420_000)
    // 5100 unreadable certificates, a warning finding each
    const docs = Array.from({ length: MANY }, (_, i) => tlsSecret(`many-${i}`, 'not a cert', 'unused'))
    for (let i = 0; i < docs.length; i += 500) {
      kubectl('create -f -', JSON.stringify({ apiVersion: 'v1', kind: 'List', items: docs.slice(i, i + 500).map((d) => JSON.parse(d)) }))
    }
    expect(Number(kubectl(`get secrets -n ${NS} --field-selector type=kubernetes.io/tls --no-headers -o name | wc -l`)), 'the Secrets kubectl lists').toBe(MANY + 4)
    const rep = await reportOf(page)
    const all = rep.counts.critical + rep.counts.warning + rep.counts.info + rep.counts.exempt
    expect({ truncated: rep.truncated, listed: rep.findings.length }, 'the report lists 5000').toEqual({ truncated: true, listed: 5000 })
    expect(rep.findings.filter((f) => f.namespace === NS).length, 'most of them listed').toBeGreaterThan(0)
    expect(all, 'all of them counted').toBeGreaterThanOrEqual(MANY + 4)

    await open(page)
    await expect.soft(page.getByTestId('hygiene-tab-findings'), 'the Findings tab').toContainText(`(${all})`)
    await expect.soft(page.getByText(/findings are (shown|listed)|건만 (표시|목록)/), 'the note').toContainText(new RegExp(`5000 most severe of the ${all} findings|발견 ${all}건 중 심각한 순으로 5000건`))
    await expect.soft(page.getByTestId('hygiene-pager'), 'the rows listed').toContainText(pagerTotal(5000))
  })
})
