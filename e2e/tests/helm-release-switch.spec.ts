import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

import { test, expect } from '@playwright/test'

// A Helm release's page moved to another release in the page (a drawer's Helm badge, back, forward) is that release's:
// it opens on Overview, with none of the first release's Values edit or Uninstall window — whose Preview or Uninstall
// would act on the second release. On `self`, with two release Secrets the spec writes (one template, no running
// workload) in a namespace of its run, removed after.

const CLUSTER = 'self'
const run = Date.now().toString(36)
const NS = `e2e-helmswitch-${run}`
const RELEASES = ['first', 'second'] as const
const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/en.json'), 'utf8')).helmReleaseDetail

const kubeconfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-helmswitch-')), 'kubeconfig')
fs.writeFileSync(kubeconfig, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
const kubectl = (args: string, input?: string) =>
  execSync(`kubectl --kubeconfig ${kubeconfig} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()

const TEMPLATE = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ .Release.Name }}-conf\ndata:\n  replicas: {{ .Values.replicaCount | quote }}\n'

function releaseSecret(name: string, replicaCount: number) {
  const now = new Date().toISOString()
  const release = {
    name, namespace: NS, version: 1,
    info: { first_deployed: now, last_deployed: now, status: 'deployed', description: 'e2e fixture' },
    chart: { metadata: { apiVersion: 'v2', name: `e2e-${name}`, version: '0.1.0' }, templates: [{ name: 'templates/conf.yaml', data: Buffer.from(TEMPLATE).toString('base64') }], values: {} },
    config: { replicaCount }, manifest: '',
  }
  return JSON.stringify({
    apiVersion: 'v1', kind: 'Secret', type: 'helm.sh/release.v1',
    metadata: { name: `sh.helm.release.v1.${name}.v1`, namespace: NS, labels: { name, owner: 'helm', status: 'deployed', version: '1' } },
    stringData: { release: gzipSync(Buffer.from(JSON.stringify(release))).toString('base64') },
  })
}

test.describe('a Helm release page moved to another release', () => {
  test.beforeAll(() => {
    kubectl(`create namespace ${NS}`)
    RELEASES.forEach((name, i) => kubectl(`-n ${NS} apply -f -`, releaseSecret(name, i + 2)))
  })

  test.afterAll(() => {
    kubectl(`delete namespace ${NS} --wait=false --ignore-not-found`)
  })

  test('opens on its own Overview, with no Values edit or Uninstall window of the release before', async ({ page }) => {
    const at = (name: string) => `/helm/releases/${NS}/${name}?cluster=${CLUSTER}`
    const tab = (key: 'overview' | 'values') => page.getByRole('button', { name: EN.tabs[key], exact: true })
    const editing = page.getByRole('button', { name: EN.upgrade.cancel, exact: true })
    const uninstallOf = (name: string) => page.getByText(EN.uninstall.title.replace('{{name}}', name), { exact: true })

    await page.goto(at('first'))
    await expect(page.locator('h1')).toHaveText('first', { timeout: 30_000 })
    await tab('values').click()
    await page.getByRole('button', { name: EN.upgrade.edit, exact: true }).click()
    await expect(editing, 'the first release\'s values are being edited').toHaveCount(1)
    await page.getByRole('button', { name: EN.uninstall.button, exact: true }).click()
    await expect(uninstallOf('first')).toHaveCount(1)

    // the address changes in the page, as back and forward change it (page.goto would load the app again)
    await page.evaluate((next) => {
      window.history.pushState({}, '', next)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }, at('second'))
    await expect(page.locator('h1')).toHaveText('second', { timeout: 30_000 })
    await expect(uninstallOf('first'), 'no Uninstall window of the first release').toHaveCount(0)
    await expect(uninstallOf('second'), 'nor one the second release did not open').toHaveCount(0)
    await expect(tab('overview')).toHaveClass(/border-primary-500/)
    await expect(tab('values')).not.toHaveClass(/border-primary-500/)
    await expect(editing, 'no edit of the first release\'s values').toHaveCount(0)

    await tab('values').click()
    await expect(page.getByRole('button', { name: EN.upgrade.edit, exact: true }), 'the second release\'s Values tab starts read-only').toHaveCount(1)
    expect(kubectl(`-n ${NS} get secret -l owner=helm -o jsonpath={.items[*].metadata.labels.name}`).split(' ').sort()).toEqual([...RELEASES].sort())
  })
})
