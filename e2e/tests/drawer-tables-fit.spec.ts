import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// A drawer's tables fit the drawer: at 1440×900 no table in the Pod, PodDisruptionBudget, Deployment, Service,
// PersistentVolumeClaim, PersistentVolume, StorageClass and Node drawers is wider than its box, and no header word is
// wider than its column — the Conditions table once cut "Last Transition" at the drawer's edge, and the Node's pods
// hid their IP and Age behind a scroll the trackpad's scrollbar does not show. Objects in e2e-drawer-fit on `self`,
// made here and removed after.

const NS = 'e2e-drawer-fit'
const NODE = 'kubeast-control-plane'
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'

const kc = execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' })
const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-drawer-fit-')), 'kubeconfig')
fs.writeFileSync(kcPath, kc, { mode: 0o600 })
const kubectl = (args: string, input?: string) =>
  execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()

const FIXTURE = `
apiVersion: v1
kind: Namespace
metadata: { name: ${NS} }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: fit-web, namespace: ${NS} }
spec:
  replicas: 1
  selector: { matchLabels: { app: fit-web } }
  template:
    metadata: { labels: { app: fit-web } }
    spec:
      containers: [{ name: app, image: busybox:1.37, imagePullPolicy: IfNotPresent, command: [sleep, "86400"] }]
---
apiVersion: v1
kind: Service
metadata: { name: fit-web, namespace: ${NS} }
spec:
  selector: { app: fit-web }
  ports:
    - { name: http, port: 80, targetPort: 8080, appProtocol: kubernetes.io/h2c }
    - { name: metrics-endpoint, port: 9090, targetPort: metrics-http, protocol: TCP }
    - { name: dns, port: 53, targetPort: 5353, protocol: UDP }
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: fit-pdb, namespace: ${NS} }
spec: { minAvailable: 1, selector: { matchLabels: { app: fit-web } } }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: fit-claim, namespace: ${NS} }
spec: { storageClassName: standard, accessModes: [ReadWriteOnce], resources: { requests: { storage: 8Mi } } }
---
apiVersion: v1
kind: Pod
metadata: { name: fit-mount, namespace: ${NS} }
spec:
  containers:
    - name: app
      image: busybox:1.37
      imagePullPolicy: IfNotPresent
      command: [sleep, "86400"]
      volumeMounts: [{ name: data, mountPath: /data }]
  volumes: [{ name: data, persistentVolumeClaim: { claimName: fit-claim } }]
`

// what in the open drawer sits past its box: tables wider than their scroll box and header cells whose words do not
// fit their column, as "<headers>: +N px"
async function cut(page: Page): Promise<string[]> {
  return page.locator(DRAWER).last().evaluate((drawer) => [...drawer.querySelectorAll('table')].flatMap((t) => {
    const heads = [...t.querySelectorAll('thead th')].map((th) => (th.textContent ?? '').trim())
    const box = t.parentElement!
    const wide = box.scrollWidth - box.clientWidth
    const found = wide > 1 ? [`${heads.join(' | ')}: table +${wide} px`] : []
    for (const th of t.querySelectorAll<HTMLElement>('thead th')) {
      const over = th.scrollWidth - th.clientWidth
      if (over > 1) found.push(`${heads.join(' | ')}: "${(th.textContent ?? '').trim()}" +${over} px`)
    }
    return found
  }))
}

const headers = (page: Page) => page.locator(DRAWER).last().locator('thead th').allTextContents()

test.describe('Drawer tables fit the drawer', () => {
  test.beforeAll(async () => {
    test.setTimeout(240_000)
    kubectl('apply -f -', FIXTURE)
    kubectl(`wait -n ${NS} --for=condition=Ready pod/fit-mount --timeout=180s`)
    kubectl(`wait -n ${NS} --for=condition=Available deploy/fit-web --timeout=120s`)
    kubectl(`wait -n ${NS} --for=jsonpath={.status.phase}=Bound pvc/fit-claim --timeout=60s`)
    // the disruption controller has written its condition (with observedGeneration), allowed or not
    kubectl(`wait -n ${NS} --for=jsonpath='{.status.conditions[0].type}'=DisruptionAllowed pdb/fit-pdb --timeout=60s`)
  })

  test.afterAll(() => {
    kubectl(`delete namespace ${NS} --wait=true --timeout=180s --ignore-not-found`)
  })

  test('at 1440×900 no drawer table is wider than its box and no header is cut', async ({ page }) => {
    test.setTimeout(300_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    const pv = kubectl(`get pvc fit-claim -n ${NS} -o jsonpath={.spec.volumeName}`)
    expect(pv, 'the claim is bound to a volume').toMatch(/^pvc-/)
    const rs = kubectl(`get rs -n ${NS} -l app=fit-web -o jsonpath={.items[0].metadata.name}`)
    // each drawer, with a header of the table it is opened for: read once that table is on screen
    // (a Deployment lists its ReplicaSets; the pod table is the ReplicaSet's)
    const drawers: [string, string][] = [
      [`Pod/${NS}/fit-mount`, 'Last Transition'],
      [`PodDisruptionBudget/${NS}/fit-pdb`, 'Observed Generation'],
      [`Deployment/${NS}/fit-web`, 'Available'],
      [`ReplicaSet/${NS}/${rs}`, 'Restarts'],
      [`Service/${NS}/fit-web`, 'AppProtocol'],
      [`PersistentVolumeClaim/${NS}/fit-claim`, 'Mounted As'],
      [`PersistentVolume/${pv}`, 'Mounted As'],
      ['StorageClass/standard', 'Requested'],
      [`Node/${NODE}`, 'IP'],
    ]
    const found: string[] = []
    for (const [detail, header] of drawers) {
      await page.goto(`/?cluster=self&detail=${encodeURIComponent(detail)}`)
      await page.locator(DRAWER).last().waitFor({ timeout: 20_000 })
      await expect.poll(() => headers(page), { timeout: 20_000, message: `${detail} shows its ${header} column` }).toContain(header)
      found.push(...(await cut(page)).map((c) => `${detail}: ${c}`))
    }
    expect(found, 'tables past the drawer box and headers past their column').toEqual([])
  })
})
