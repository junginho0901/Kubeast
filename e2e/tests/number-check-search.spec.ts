import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// Number check of Advanced Search on cluster `default`: what it loads is each selected type's own list up to the
// limit, as the cluster has it (core Events and events.k8s.io Events are two types of one Kind); a type that fails is
// asked again and reported on every read; a list the server ends with an error partway is a failure, not the limit.

const SEARCH = { path: '/cluster/search', cluster: 'default' }
const NS = 'e2e-search'
const LIMIT = 4
const FIXTURE = [
  `apiVersion: v1\nkind: Namespace\nmetadata: {name: ${NS}}`,
  ...[1, 2, 3].map((i) => `apiVersion: v1\nkind: ConfigMap\nmetadata: {name: e2e-search-${i}, namespace: ${NS}}\ndata: {n: "${i}"}`),
  ...[1, 2, 3, 4, 5, 6].map((i) => [
    'apiVersion: v1', 'kind: Event', `metadata: {name: e2e-search-${i}, namespace: ${NS}}`,
    `involvedObject: {kind: ConfigMap, name: e2e-search-1, namespace: ${NS}}`,
    'reason: E2ESearch', `message: number check ${i}`, 'type: Normal',
  ].join('\n')),
].join('\n---\n')

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-numsearch-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string, input?: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

let k: ((a: string, input?: string) => string) | undefined
const count = (type: string) => JSON.parse(k!(`get ${type} -n ${NS} -o json`)).items.length as number

test.beforeAll(() => {
  try { k = kubectlFor('kubeast-b') } catch { return }
  // a run before this one leaves the namespace terminating: new objects, not its last ones
  k(`delete namespace/${NS} --ignore-not-found --timeout=120s`)
  k('apply -f -', FIXTURE)
})

test.afterAll(() => {
  k?.(`delete namespace/${NS} --wait=false --ignore-not-found`)
})

// the page with these types chosen (as the picker keeps them) and the namespace picked
async function open(page: Page, types: string[]) {
  await page.addInitScript((t) => localStorage.setItem('advanced-search-resources', JSON.stringify(t)), types)
  await page.goto(`${SEARCH.path}?cluster=${SEARCH.cluster}`)
  await page.getByTestId('advanced-search-namespace').click()
  await page.getByRole('button', { name: NS, exact: true }).click()
}

const loaded = (n: number) => new RegExp(`(^|\\D)${n} items loaded|(^|\\D)${n}개 항목 로드됨`)

test.describe('Number check — Advanced Search loads what the cluster has', () => {
  test.beforeEach(() => { test.skip(!k, 'kind cluster kubeast-b not found') })

  test('core and events.k8s.io Events are two types, each read up to the limit', async ({ page }) => {
    test.setTimeout(90_000)
    await open(page, ['configmaps'])
    // the picker offers both groups' Events and both can be chosen
    const picker = page.getByRole('button', { name: /Select Resources|리소스 선택/ })
    await picker.click()
    await page.getByRole('button', { name: /^(Clear All|선택 해제)$/ }).click()
    await page.getByPlaceholder(/Filter resources|리소스 필터/).fill('Event')
    const events = page.locator('button').filter({ hasText: /^Event$/ })
    await expect(events, 'one Event entry per API group').toHaveCount(2)
    await events.nth(0).click()
    await events.nth(1).click()
    await page.keyboard.press('Escape')
    await page.mouse.click(5, 5)

    await page.getByRole('button', { name: /^(Settings|설정)$/ }).click()
    await page.locator('input[type="number"]').fill(String(LIMIT))
    await page.getByRole('button', { name: /^(Save|저장)$/ }).click()

    const core = count('events')
    const grouped = count('events.events.k8s.io')
    expect([core, grouped], 'the fixture events through both APIs').toEqual([6, 6])
    const want = Math.min(core, LIMIT) + Math.min(grouped, LIMIT)
    await expect(page.getByText(loaded(want))).toHaveCount(1)
    await expect(page.getByTestId('search-truncated')).toHaveAttribute('title', `events: ${LIMIT} (+${core - LIMIT}), events.events.k8s.io: ${LIMIT} (+${grouped - LIMIT})`)

    // every loaded object matches `true`: the table's range counts them all
    await page.locator('.monaco-editor').first().click()
    await page.keyboard.type('true')
    await expect(page.getByTestId('search-page-info')).toHaveText(new RegExp(`^Showing 1-\\d+ of ${want}$|^${want}개 중 1-\\d+ 표시$`))
  })

  test('a type that fails is asked again on each read and still reported', async ({ page }) => {
    // the reads of each type in the namespace: the page reads all namespaces first, then the one picked
    const asked = { configmaps: 0, nosuchthings: 0 }
    page.on('request', (r) => {
      const u = new URL(r.url())
      const type = u.searchParams.get('resource_type') as keyof typeof asked
      if (u.pathname === '/api/v1/cluster/resources' && u.searchParams.get('namespace') === NS && type in asked) asked[type]++
    })
    await open(page, ['configmaps', 'nosuchthings'])
    await expect(page.getByText(loaded(count('configmaps')))).toHaveCount(1)
    expect(asked, 'both types read in the namespace picked after a failure').toEqual({ configmaps: 1, nosuchthings: 1 })
    const failed = page.getByTestId('search-failed')
    await expect(failed).toHaveText(/^(1 failed|1개 실패)$/)
    await expect(failed).toHaveAttribute('title', /^nosuchthings: /)

    await page.getByRole('button', { name: /^(Refresh|새로고침)$/ }).click()
    await expect.poll(() => asked.configmaps).toBe(2)
    await expect.poll(() => asked.nosuchthings, 'the failed type is asked again').toBe(2)
    await expect(failed).toHaveText(/^(1 failed|1개 실패)$/)
  })

  test('a list the server ends with an error partway is a failure with what it read, not the limit', async ({ page }) => {
    const message = 'the provided continue parameter is too old to display a consistent list result'
    // the server's answer when a later page fails (writeRawList): the objects so far, truncated and error
    await page.route((u) => u.pathname === '/api/v1/cluster/resources' && u.searchParams.get('resource_type') === 'configmaps', async (route) => {
      const res = await route.fetch()
      const body = await res.json()
      await route.fulfill({ response: res, json: { ...body, truncated: true, error: message } })
    })
    await open(page, ['configmaps'])
    const read = count('configmaps')
    await expect(page.getByText(loaded(read))).toHaveCount(1)
    await expect(page.getByTestId('search-truncated')).toHaveCount(0)
    await expect(page.getByTestId('search-failed')).toHaveText(/^(1 failed|1개 실패)$/)
    await expect(page.getByTestId('search-failed')).toHaveAttribute('title', new RegExp(`^configmaps: (stopped after ${read}|${read}개를 읽은 뒤 멈춤): ${message}$`))
  })
})
