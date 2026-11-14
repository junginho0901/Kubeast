import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// A save of a YAML window takes out of the object what left the text its edit began from, each kind in the patch its API
// takes: a strategic merge patch by each list's merge key, a JSON merge patch for a custom resource, labels and annotations
// for a Namespace. What someone else added since stays. Held on `self` against kubectl, through the API and the window; the
// namespace, the node label and the CRDs are of this run and removed after.

const CLUSTER = 'self'
const run = Date.now().toString(36)
const NS = `e2e-yaml-edit-${run}`
const GROUP = `yamledit${run}.kubeast.io`
const CRD = `widgets.${GROUP}`
// a second CRD whose object has the same namespace and name as a Widget's, as Karpenter's EC2NodeClass and NodePool
const TWIN_GROUP = `yamltwin${run}.kubeast.io`
const TWIN_CRD = `gadgets.${TWIN_GROUP}`
const NODE_LABEL = `e2e-yaml-edit-${run}`
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'

const kubeconfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-yaml-edit-')), 'kubeconfig')
fs.writeFileSync(kubeconfig, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
const kubectl = (args: string, input?: string) =>
  execSync(`kubectl --kubeconfig ${kubeconfig} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
const objectOf = (args: string) => JSON.parse(kubectl(`${args} -o json`))

async function login(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post('/api/v1/auth/login', { data: { email: process.env.E2E_USER_EMAIL || 'admin', password: process.env.E2E_USER_PASSWORD || '' } })
  expect(res.ok(), `login: ${res.status()}`).toBeTruthy()
  return { Authorization: `Bearer ${(await res.json()).access_token}`, 'X-Requested-With': 'XMLHttpRequest' }
}

// what the screen sends of the text an edit began from (frontend yamlOpenedOf)
function openedOf(opened: string, saved: string) {
  const from = opened.split('\n')
  const to = saved.split('\n')
  let head = 0
  while (head < from.length && head < to.length && from[head] === to[head]) head++
  let tail = 0
  while (tail < from.length - head && tail < to.length - head && from[from.length - 1 - tail] === to[to.length - 1 - tail]) tail++
  return { head, tail, lines: from.slice(head, from.length - tail) }
}

// The text without the line starting with these words, and the lines under it that belong to it.
function without(text: string, words: string): string {
  const lines = text.split('\n')
  const at = lines.findIndex((line) => line.trimStart().startsWith(words))
  expect(at, `no line ${words} in:\n${text}`).toBeGreaterThan(-1)
  const indent = lines[at].search(/\S/) + (lines[at].trimStart().startsWith('- ') ? 2 : 0)
  let end = at + 1
  while (end < lines.length && lines[end].trim() && lines[end].search(/\S/) >= (lines[at].trimStart().startsWith('- ') ? indent : indent + 1)) end++
  return [...lines.slice(0, at), ...lines.slice(end)].join('\n')
}

const CONFIG_MAP = (name: string) => ({
  apiVersion: 'v1', kind: 'ConfigMap',
  metadata: { name, namespace: NS, labels: { keep: 'a', 'gone-label': 'b' }, annotations: { 'keep-note': 'c', 'gone-note': 'd' } },
  data: { keep: '1', 'gone-key': '2' },
})

test.describe('a line taken out of a YAML window', () => {
  let headers: Record<string, string> = {}

  const yamlOf = async (request: APIRequestContext, type: string, name: string, namespace?: string) => {
    const query = new URLSearchParams({ cluster: CLUSTER, resource_type: type, resource_name: name, force_refresh: 'true', ...(namespace ? { namespace } : {}) })
    const res = await request.get(`/api/v1/cluster/resources/yaml?${query}`, { headers })
    expect(res.status(), await res.text()).toBe(200)
    return (await res.json()).yaml as string
  }
  const applyResource = (request: APIRequestContext, type: string, name: string, namespace: string | undefined, opened: string | null, yaml: string) =>
    request.post(`/api/v1/cluster/resources/yaml/apply?cluster=${CLUSTER}`, {
      headers, data: { resource_type: type, name, namespace, yaml, ...(opened === null ? {} : { opened: openedOf(opened, yaml) }) },
    })

  test.beforeAll(async ({ request }) => {
    headers = await login(request)
    kubectl(`create namespace ${NS}`)
    kubectl('create -f -', JSON.stringify({
      apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name: CRD },
      spec: {
        group: GROUP, scope: 'Namespaced', names: { plural: 'widgets', singular: 'widget', kind: 'Widget' },
        versions: [{ name: 'v1', served: true, storage: true, schema: { openAPIV3Schema: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true } } }],
      },
    }))
    kubectl('create -f -', JSON.stringify({
      apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name: TWIN_CRD },
      spec: {
        group: TWIN_GROUP, scope: 'Namespaced', names: { plural: 'gadgets', singular: 'gadget', kind: 'Gadget' },
        versions: [{ name: 'v1', served: true, storage: true, schema: { openAPIV3Schema: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true } } }],
      },
    }))
    kubectl(`wait --for=condition=Established crd/${CRD} crd/${TWIN_CRD} --timeout=60s`)
  })

  test.afterAll(async () => {
    kubectl(`delete namespace ${NS} --wait=false --ignore-not-found`)
    kubectl(`delete crd ${CRD} ${TWIN_CRD} --wait=false --ignore-not-found`)
    const node = kubectl(`get nodes -o jsonpath='{.items[0].metadata.name}'`)
    kubectl(`label node ${node} ${NODE_LABEL}- ${NODE_LABEL}-keep-`)
  })

  test('a ConfigMap loses a data key, a label and an annotation, and nothing else', async ({ request }) => {
    kubectl('create -f -', JSON.stringify(CONFIG_MAP('lines')))
    const opened = await yamlOf(request, 'configmaps', 'lines', NS)
    const edited = without(without(without(opened, 'gone-key:'), 'gone-label:'), 'gone-note:')
    const res = await applyResource(request, 'configmaps', 'lines', NS, opened, edited)
    expect(res.status(), await res.text()).toBe(200)
    const now = objectOf(`-n ${NS} get configmap lines`)
    expect(now.data).toEqual({ keep: '1' })
    expect(now.metadata.labels).toEqual({ keep: 'a' })
    expect(now.metadata.annotations).toEqual({ 'keep-note': 'c' })
  })

  test('a Deployment follows its lists: a key deep in a container, an env entry and a container by name, an argument in its list', async ({ request }) => {
    kubectl('create -f -', JSON.stringify({
      apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'deep', namespace: NS },
      spec: {
        replicas: 0, selector: { matchLabels: { app: 'deep' } },
        template: {
          metadata: { labels: { app: 'deep' } },
          spec: {
            nodeSelector: { 'e2e-gone': 'x' },
            containers: [
              { name: 'app', image: 'registry.k8s.io/pause:3.10', args: ['--keep', '--gone-arg'], env: [{ name: 'KEEP', value: '1' }, { name: 'GONE_ENV', value: '2' }], resources: { limits: { cpu: '100m', memory: '64Mi' } } },
              { name: 'side', image: 'registry.k8s.io/pause:3.9' },
            ],
          },
        },
      },
    }))
    // the controller writes its status right after the create, which moves the version the text is read at
    kubectl(`-n ${NS} rollout status deployment/deep --timeout=60s`)
    const opened = await yamlOf(request, 'deployments', 'deep', NS)
    let edited = without(opened, 'cpu: 100m')
    edited = without(edited, '- name: GONE_ENV')
    edited = without(edited, '- --gone-arg')
    edited = without(edited, 'nodeSelector:')
    edited = without(edited, '- image: registry.k8s.io/pause:3.9')
    const res = await applyResource(request, 'deployments', 'deep', NS, opened, edited)
    expect(res.status(), await res.text()).toBe(200)
    const spec = objectOf(`-n ${NS} get deployment deep`).spec.template.spec
    expect(spec.containers.map((c: { name: string }) => c.name)).toEqual(['app'])
    expect(spec.containers[0].image).toBe('registry.k8s.io/pause:3.10')
    expect(spec.containers[0].args).toEqual(['--keep'])
    expect(spec.containers[0].env).toEqual([{ name: 'KEEP', value: '1' }])
    expect(spec.containers[0].resources.limits).toEqual({ memory: '64Mi' })
    expect(spec.nodeSelector).toBeUndefined()
  })

  test('what someone added since stays, and a save over a changed version is refused as before', async ({ request }) => {
    kubectl('create -f -', JSON.stringify(CONFIG_MAP('since')))
    const opened = await yamlOf(request, 'configmaps', 'since', NS)
    kubectl(`-n ${NS} label configmap since theirs=yes`)
    const stale = await applyResource(request, 'configmaps', 'since', NS, opened, without(opened, 'gone-key:'))
    expect(stale.status(), 'the version the text was read at').toBe(409)
    expect(objectOf(`-n ${NS} get configmap since`).data['gone-key']).toBe('2')

    const res = await applyResource(request, 'configmaps', 'since', NS, opened, without(without(opened, 'gone-key:'), 'resourceVersion:'))
    expect(res.status(), await res.text()).toBe(200)
    const now = objectOf(`-n ${NS} get configmap since`)
    expect(now.data).toEqual({ keep: '1' })
    expect(now.metadata.labels.theirs).toBe('yes')
  })

  test('a save with no opened text leaves what the document does not name', async ({ request }) => {
    kubectl('create -f -', JSON.stringify(CONFIG_MAP('whole')))
    const opened = await yamlOf(request, 'configmaps', 'whole', NS)
    const res = await applyResource(request, 'configmaps', 'whole', NS, null, without(opened, 'gone-key:'))
    expect(res.status(), await res.text()).toBe(200)
    expect(objectOf(`-n ${NS} get configmap whole`).data).toEqual({ keep: '1', 'gone-key': '2' })
  })

  test('a window left empty or holding no object is refused with the reason, and the object stays', async ({ request }) => {
    kubectl('create -f -', JSON.stringify(CONFIG_MAP('empty')))
    const opened = await yamlOf(request, 'configmaps', 'empty', NS)
    for (const [yaml, detail] of [
      ['# nothing here\n', 'the YAML is empty: there is nothing to apply'],
      ['', 'the YAML is empty: there is nothing to apply'],
      ['   \n', 'the YAML is empty: there is nothing to apply'],
      ['a', 'the YAML is text, not an object with apiVersion, kind and metadata'],
      ['- a', 'the YAML is a list, not an object with apiVersion, kind and metadata'],
    ]) {
      const res = await applyResource(request, 'configmaps', 'empty', NS, opened, yaml)
      expect([res.status(), (await res.json()).detail], JSON.stringify(yaml)).toEqual([400, detail])
    }
    const ns = await request.post(`/api/v1/cluster/namespaces/${NS}/yaml/apply?cluster=${CLUSTER}`, { headers, data: { yaml: '' } })
    expect([ns.status(), (await ns.json()).detail], 'a Namespace window the same').toEqual([400, 'the YAML is empty: there is nothing to apply'])
    expect(objectOf(`-n ${NS} get configmap empty`).data).toEqual({ keep: '1', 'gone-key': '2' })
  })

  test('a save that changes nothing answers unchanged, a save that changes something does not', async ({ request }) => {
    kubectl('create -f -', JSON.stringify(CONFIG_MAP('same')))
    const opened = await yamlOf(request, 'configmaps', 'same', NS)
    const version = objectOf(`-n ${NS} get configmap same`).metadata.resourceVersion
    const same = await applyResource(request, 'configmaps', 'same', NS, opened, opened)
    expect(same.status(), await same.text()).toBe(200)
    expect((await same.json()).unchanged).toBe(true)
    expect(objectOf(`-n ${NS} get configmap same`).metadata.resourceVersion, 'nothing was written').toBe(version)
    const edited = opened.replace(/keep: ["']1["']/, 'keep: "2"')
    expect(edited, 'the data value is in the text').not.toBe(opened)
    const changed = await applyResource(request, 'configmaps', 'same', NS, opened, edited)
    expect(changed.status(), await changed.text()).toBe(200)
    expect((await changed.json()).unchanged).toBe(false)
    expect(objectOf(`-n ${NS} get configmap same`).data.keep).toBe('2')
  })

  test('a Node loses a label line', async ({ request }) => {
    const node = kubectl(`get nodes -o jsonpath='{.items[0].metadata.name}'`)
    kubectl(`label node ${node} ${NODE_LABEL}=gone ${NODE_LABEL}-keep=yes`)
    const res0 = await request.get(`/api/v1/cluster/nodes/${node}/yaml?cluster=${CLUSTER}&force_refresh=true`, { headers })
    const opened = (await res0.json()).yaml as string
    // a node's own status moves its version
    const edited = without(without(opened, `${NODE_LABEL}: gone`), 'resourceVersion:')
    const res = await request.post(`/api/v1/cluster/nodes/${node}/yaml/apply?cluster=${CLUSTER}`, { headers, data: { yaml: edited, opened: openedOf(opened, edited) } })
    expect(res.status(), await res.text()).toBe(200)
    const labels = objectOf(`get node ${node}`).metadata.labels
    expect(labels[NODE_LABEL]).toBeUndefined()
    expect(labels[`${NODE_LABEL}-keep`]).toBe('yes')
    expect(labels['kubernetes.io/hostname']).toBeTruthy()
  })

  test('a Namespace loses a label and an annotation line, and keeps a protected one', async ({ request }) => {
    const name = `${NS}-ns`
    kubectl('create -f -', JSON.stringify({ apiVersion: 'v1', kind: 'Namespace', metadata: { name, labels: { keep: 'a', 'gone-label': 'b' }, annotations: { 'gone-note': 'c' } } }))
    try {
      const res0 = await request.get(`/api/v1/cluster/namespaces/${name}/yaml?cluster=${CLUSTER}&force_refresh=true`, { headers })
      const opened = (await res0.json()).yaml as string
      const edited = without(without(without(opened, 'gone-label:'), 'gone-note:'), 'kubernetes.io/metadata.name:')
      const res = await request.post(`/api/v1/cluster/namespaces/${name}/yaml/apply?cluster=${CLUSTER}`, { headers, data: { yaml: edited, opened: openedOf(opened, edited) } })
      expect(res.status(), await res.text()).toBe(200)
      const metadata = objectOf(`get namespace ${name}`).metadata
      expect(metadata.labels).toEqual({ keep: 'a', 'kubernetes.io/metadata.name': name })
      expect(metadata.annotations?.['gone-note']).toBeUndefined()
    } finally {
      kubectl(`delete namespace ${name} --wait=false --ignore-not-found`)
    }
  })

  test('a custom resource saves, and loses a deep key and a list item', async ({ request }) => {
    kubectl('create -f -', JSON.stringify({ apiVersion: `${GROUP}/v1`, kind: 'Widget', metadata: { name: 'w', namespace: NS, labels: { keep: 'a', 'gone-label': 'b' } }, spec: { deep: { keep: 1, 'gone-key': 2 }, items: ['keep-item', 'gone-item'] } }))
    const opened = await yamlOf(request, CRD, 'w', NS)
    const edited = without(without(without(opened, 'gone-key:'), 'gone-label:'), '- gone-item')
    const res = await applyResource(request, CRD, 'w', NS, opened, edited)
    expect(res.status(), `the API server takes this patch for a custom resource: ${await res.text()}`).toBe(200)
    const now = objectOf(`-n ${NS} get ${CRD} w`)
    expect(now.spec).toEqual({ deep: { keep: 1 }, items: ['keep-item'] })
    expect(now.metadata.labels).toEqual({ keep: 'a' })

    const whole = await applyResource(request, CRD, 'w', NS, null, (await yamlOf(request, CRD, 'w', NS)).replace('keep: 1', 'keep: 3'))
    expect(whole.status(), `a whole document too: ${await whole.text()}`).toBe(200)
    expect(objectOf(`-n ${NS} get ${CRD} w`).spec.deep).toEqual({ keep: 3 })
  })

  // Monaco's delete-line on the line holding these words. Monaco picks Cmd or Ctrl by the page's user agent (the chromium
  // project's is Windows), not by the machine the test runs on as ControlOrMeta does: Cmd+Up and Cmd+Shift+K on a Mac.
  const deleteLineInWindow = async (page: Page, opened: string, words: string) => {
    const drawer = page.locator(DRAWER).last()
    await drawer.getByRole('button', { name: 'YAML', exact: true }).click({ timeout: 30_000 })
    await expect(drawer.locator('.monaco-editor .view-lines').first()).toContainText(words, { timeout: 30_000 })
    await drawer.getByRole('button', { name: /^(edit|편집)$/i }).click()
    await drawer.locator('.monaco-editor').first().click()
    const mac = await page.evaluate(() => navigator.userAgent.includes('Macintosh'))
    await page.keyboard.press(mac ? 'Meta+ArrowUp' : 'Control+Home')
    const line = opened.split('\n').findIndex((l) => l.trimStart().startsWith(words))
    expect(line).toBeGreaterThan(-1)
    for (let i = 0; i < line; i++) await page.keyboard.press('ArrowDown')
    await page.keyboard.press(mac ? 'Meta+Shift+K' : 'Control+Shift+K')
    await expect(drawer.locator('.monaco-editor .view-lines').first()).not.toContainText(words)
    await drawer.getByRole('button', { name: /^(apply|적용)$/i }).click()
    await expect(drawer.getByRole('button', { name: /^(edit|편집)$/i }), 'the save ended').toBeVisible({ timeout: 30_000 })
  }

  test('in the window: a ConfigMap\'s key leaves, its neighbour stays', async ({ page, request }) => {
    kubectl('create -f -', JSON.stringify(CONFIG_MAP('window')))
    const opened = await yamlOf(request, 'configmaps', 'window', NS)
    await page.goto(`/?cluster=${CLUSTER}&detail=${encodeURIComponent(`ConfigMap/${NS}/window`)}`)
    await deleteLineInWindow(page, opened, 'gone-key:')
    expect(objectOf(`-n ${NS} get configmap window`).data).toEqual({ keep: '1' })
  })

  test('in the window: Apply with nothing changed says Unchanged, an emptied window says why and saves nothing', async ({ page, request }) => {
    kubectl('create -f -', JSON.stringify(CONFIG_MAP('window-same')))
    await yamlOf(request, 'configmaps', 'window-same', NS)
    const version = objectOf(`-n ${NS} get configmap window-same`).metadata.resourceVersion
    await page.goto(`/?cluster=${CLUSTER}&detail=${encodeURIComponent(`ConfigMap/${NS}/window-same`)}`)
    const drawer = page.locator(DRAWER).last()
    await drawer.getByRole('button', { name: 'YAML', exact: true }).click({ timeout: 30_000 })
    await expect(drawer.locator('.monaco-editor .view-lines').first()).toContainText('gone-key:', { timeout: 30_000 })
    await drawer.getByRole('button', { name: /^(edit|편집)$/i }).click()
    await drawer.getByRole('button', { name: /^(apply|적용)$/i }).click()
    const toast = drawer.getByTestId('yaml-apply-toast')
    await expect(toast).toHaveText('Unchanged: the object is already as this YAML says.', { timeout: 30_000 })
    await expect(toast).toHaveAttribute('data-type', 'success')
    expect(objectOf(`-n ${NS} get configmap window-same`).metadata.resourceVersion).toBe(version)

    await drawer.getByRole('button', { name: /^(edit|편집)$/i }).click()
    await drawer.locator('.monaco-editor').first().click()
    const mac = await page.evaluate(() => navigator.userAgent.includes('Macintosh'))
    await page.keyboard.press(mac ? 'Meta+A' : 'Control+A')
    await page.keyboard.press('Delete')
    await expect(drawer.locator('.monaco-editor .view-lines').first()).not.toContainText('gone-key:')
    await drawer.getByRole('button', { name: /^(apply|적용)$/i }).click()
    await expect(toast).toHaveText('the YAML is empty: there is nothing to apply', { timeout: 30_000 })
    await expect(toast).toHaveAttribute('data-type', 'error')
    expect(objectOf(`-n ${NS} get configmap window-same`).data).toEqual({ keep: '1', 'gone-key': '2' })
  })

  test('in the window: a custom resource saves and its key leaves', async ({ page, request }) => {
    kubectl('create -f -', JSON.stringify({ apiVersion: `${GROUP}/v1`, kind: 'Widget', metadata: { name: 'seen', namespace: NS }, spec: { keep: 1, 'gone-key': 2 } }))
    const opened = await yamlOf(request, CRD, 'seen', NS)
    await page.goto(`/?cluster=${CLUSTER}&detail=${encodeURIComponent(`Widget/${NS}/seen`)}&detailApi=${encodeURIComponent(`${GROUP}/v1/widgets`)}`)
    await deleteLineInWindow(page, opened, 'gone-key:')
    expect(objectOf(`-n ${NS} get ${CRD} seen`).spec).toEqual({ keep: 1 })
  })

  // The YAML tab moved, within the read's ten seconds, from a custom resource to one of another CRD with the same
  // namespace and name (as the browser's back and forward move it, or a link): the window shows that object's YAML,
  // and its save goes to that object, the first left as it was.
  test('in the window: a custom resource of another CRD with the same name shows and saves its own YAML', async ({ page, request }) => {
    kubectl('create -f -', JSON.stringify({ apiVersion: `${GROUP}/v1`, kind: 'Widget', metadata: { name: 'twin', namespace: NS }, spec: { from: 'first', 'first-key': 1 } }))
    kubectl('create -f -', JSON.stringify({ apiVersion: `${TWIN_GROUP}/v1`, kind: 'Gadget', metadata: { name: 'twin', namespace: NS }, spec: { from: 'second', 'gone-key': 2 } }))
    const opened = await yamlOf(request, TWIN_CRD, 'twin', NS)
    await page.goto(`/?cluster=${CLUSTER}&detail=${encodeURIComponent(`Widget/${NS}/twin`)}&detailApi=${encodeURIComponent(`${GROUP}/v1/widgets`)}`)
    const drawer = page.locator(DRAWER).last()
    const lines = drawer.locator('.monaco-editor .view-lines').first()
    await drawer.getByRole('button', { name: 'YAML', exact: true }).click({ timeout: 30_000 })
    await expect(lines).toContainText('from: first', { timeout: 30_000 })

    // the address changes in the page, as back and forward change it (page.goto would load the app again)
    await page.evaluate((next) => {
      window.history.pushState({}, '', next)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }, `/?cluster=${CLUSTER}&detail=${encodeURIComponent(`Gadget/${NS}/twin`)}&detailApi=${encodeURIComponent(`${TWIN_GROUP}/v1/gadgets`)}`)
    await expect(lines).toContainText('from: second', { timeout: 30_000 })
    await expect(lines).toContainText(`apiVersion: ${TWIN_GROUP}/v1`)
    await expect(lines).not.toContainText('from: first')

    await deleteLineInWindow(page, opened, 'gone-key:')
    expect(objectOf(`-n ${NS} get ${TWIN_CRD} twin`).spec).toEqual({ from: 'second' })
    expect(objectOf(`-n ${NS} get ${CRD} twin`).spec, 'the Widget of the same name is as it was').toEqual({ from: 'first', 'first-key': 1 })
  })
})
