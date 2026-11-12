import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// A list's search finds what its box names (#766): a Deployment by any of its images, an EndpointSlice by any of its
// addresses, a StorageClass by a parameter's name=value and a StatefulSet by its namespace. On `self`, with objects of
// this run that run nothing (no replicas, documentation addresses, a provisioner no one serves); each search text is
// in one object only, so the list keeps that one row.

const NS = 'e2e-search-scope'
const SC = 'e2e-search-scope-sc'
const FIXTURE = `apiVersion: v1
kind: Namespace
metadata: {name: ${NS}}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: e2e-ss-deploy, namespace: ${NS}}
spec:
  replicas: 0
  selector: {matchLabels: {app: e2e-ss-deploy}}
  template:
    metadata: {labels: {app: e2e-ss-deploy}}
    spec:
      containers:
      - {name: first, image: 'busybox:1.37'}
      - {name: second, image: 'e2e.example/search-scope-second:1'}
---
apiVersion: apps/v1
kind: StatefulSet
metadata: {name: e2e-ss-sts, namespace: ${NS}}
spec:
  replicas: 0
  serviceName: e2e-ss-sts
  selector: {matchLabels: {app: e2e-ss-sts}}
  template:
    metadata: {labels: {app: e2e-ss-sts}}
    spec: {containers: [{name: app, image: 'busybox:1.37'}]}
---
apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: e2e-ss-slice
  namespace: ${NS}
  labels: {kubernetes.io/service-name: e2e-ss-none, endpointslice.kubernetes.io/managed-by: e2e.kubeast.io}
addressType: IPv4
ports: [{name: http, port: 80, protocol: TCP}]
endpoints:
- addresses: [192.0.2.11]
- addresses: [192.0.2.12]
- addresses: [192.0.2.13]
- addresses: [192.0.2.14]
---
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata: {name: ${SC}}
provisioner: e2e.example/none
parameters: {tier: e2e-ss-gold}`

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-search-scope-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string, input?: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const k = kubectlFor('kubeast')
const rows = (page: Page) => page.locator('tbody:not([aria-hidden="true"]) tr')

test.beforeAll(() => {
  k(`delete namespace/${NS} storageclass/${SC} --ignore-not-found --timeout=120s`)
  k('apply -f -', FIXTURE)
})

test.afterAll(() => {
  k(`delete namespace/${NS} storageclass/${SC} --ignore-not-found --wait=false`)
})

async function searchKeeps(page: Page, placeholder: RegExp, text: string, name: string) {
  await page.getByPlaceholder(placeholder).fill(text)
  await expect(rows(page)).toHaveCount(1, { timeout: 30_000 })
  await expect(rows(page).first()).toContainText(name)
}

test.describe('a list search finds what its box names', () => {
  test('a Deployment by its second image', async ({ page }) => {
    const images = k(`-n ${NS} get deploy e2e-ss-deploy -o jsonpath={.spec.template.spec.containers[*].image}`)
    expect(images.split(' ')).toEqual(['busybox:1.37', 'e2e.example/search-scope-second:1'])
    await page.goto(`/workloads/deployments?cluster=self&namespace=${NS}`)
    await searchKeeps(page, /Search deployments|Deployment/, 'search-scope-second', 'e2e-ss-deploy')
  })

  test('an EndpointSlice by its fourth address', async ({ page }) => {
    const addresses = k(`-n ${NS} get endpointslice e2e-ss-slice -o jsonpath={.endpoints[*].addresses[*]}`)
    expect(addresses.split(' ')).toEqual(['192.0.2.11', '192.0.2.12', '192.0.2.13', '192.0.2.14'])
    await page.goto(`/network/endpointslices?cluster=self&namespace=${NS}`)
    await searchKeeps(page, /Search endpoint slices|EndpointSlice/, '192.0.2.14', 'e2e-ss-slice')
  })

  test('a StorageClass by a parameter name=value', async ({ page }) => {
    expect(k(`get storageclass ${SC} -o jsonpath={.parameters.tier}`)).toBe('e2e-ss-gold')
    await page.goto('/storage?tab=storageclasses&cluster=self')
    await searchKeeps(page, /Search StorageClasses|StorageClass/, 'tier=e2e-ss-gold', SC)
  })

  test('a StatefulSet by its namespace, every namespace shown', async ({ page }) => {
    expect(k(`-n ${NS} get statefulset -o name`)).toBe('statefulset.apps/e2e-ss-sts')
    await page.goto('/workloads/statefulsets?cluster=self')
    await searchKeeps(page, /Search StatefulSets|StatefulSet/, NS, 'e2e-ss-sts')
  })
})
