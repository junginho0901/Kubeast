import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Locator, type Page, type Route } from '@playwright/test'

// Text the console did not write, drawn where people read it, runs none of the script it holds: an AI answer while it
// comes and once saved (AI Chat and the floating chat) with its tool result, an alert's annotations and links with its
// investigation report and result, a pod's logs (the Cluster View Logs tab, its Log files view and the drawer) with an
// event's message, and a Helm revision's manifest and diff (diff2html, the one view drawn from an HTML string). Each
// planted piece of markup would call window.__kubeast_e2e_ran with its number; a call, a dialog or a page error naming
// it fails, and so does an element or attribute the markup would have made. The chats are answered in the browser, the
// alert and its report are rows written to the dev database and the Helm history is answered in the browser, so no
// model is asked; the logs and the event come from a pod of the run in default, where the dev values offer log files.

const XRW = { 'X-Requested-With': 'XMLHttpRequest' }
const CLUSTER = 'self'
const MARK = '__kubeast_e2e_ran'
const ASSISTANT = '[data-testid="chat-message"][data-message-role="assistant"]'
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'
const BEFORE = 'Before the planted text.'
const AFTER = 'After the planted text.'

const call = (n: number) => `top.${MARK}(${n})`
// markup a page that took it as HTML would run, each piece calling with its own number
const PLANTED = [
  `<script>${call(1)}</script>`,
  `<img src="x" onerror="${call(2)}">`,
  `<svg onload="${call(3)}"><circle r="1"></circle></svg>`,
  `<iframe srcdoc="<script>${call(4)}</script>"></iframe>`,
  `<a href="javascript:${call(5)}">raw link</a>`,
  `<a href="jav&#x09;ascript:${call(6)}">entity link</a>`,
  `[markdown link](javascript:${call(7)})`,
  `<details open ontoggle="${call(8)}"><summary>planted summary</summary>planted details</details>`,
  `<input autofocus onfocus="${call(9)}">`,
  `<object data="javascript:${call(10)}"></object>`,
  `<a href="data:text/html,&lt;script&gt;${call(11)}&lt;/script&gt;">data link</a>`,
  `<video><source onerror="${call(12)}"></video>`,
  `<body onload="${call(13)}">`,
]
const [SCRIPT, IMG, SVG] = PLANTED
const DETAILS = PLANTED[7]
// the time the kubelet writes before each line of a followed log
const LINE_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+(?:Z|[+-]\d\d:\d\d) /

const stamp = () => Date.now().toString(36)

// before the first page loads: the function each piece would call, and what tells that one ran
async function watch(page: Page) {
  await page.addInitScript((name) => {
    const seen: string[] = []
    Object.assign(window, { [name]: (n: unknown) => seen.push(String(n)), [`${name}_seen`]: seen })
  }, MARK)
  const dialogs: string[] = []
  const errors: string[] = []
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message())
    void dialog.dismiss()
  })
  page.on('pageerror', (error) => {
    if (error.message.includes(MARK)) errors.push(error.message)
  })
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes(MARK)) errors.push(message.text())
  })
  return async () => ({
    ran: await page.evaluate((name) => [...((window as unknown as Record<string, string[] | undefined>)[`${name}_seen`] ?? [])], MARK),
    dialogs: [...dialogs],
    errors: [...errors],
  })
}
const NOTHING_RAN = { ran: [], dialogs: [], errors: [] }

const URL_ATTRIBUTES = ['href', 'src', 'srcdoc', 'data', 'action', 'formaction', 'xlink:href', 'poster', 'background']
const RUNNING_ELEMENTS = ['script', 'iframe', 'frame', 'object', 'embed', 'video', 'audio', 'source', 'base', 'meta']

// what the box holds that the planted markup would have made: an element that loads or runs something, an image of its
// address, a handler written as an attribute, an address that holds the planted call
function madeFrom(box: Locator) {
  return box.evaluate((root, { mark, urls, running }) => {
    const all = [...root.querySelectorAll('*')]
    const tag = (el: Element) => el.tagName.toLowerCase()
    return {
      elements: all.filter((el) => running.includes(tag(el))).map(tag),
      images: all.filter((el) => tag(el) === 'img' && el.getAttribute('src') === 'x').length,
      handlers: all.flatMap((el) => [...el.attributes].filter((a) => /^on/i.test(a.name)).map((a) => `${tag(el)} ${a.name}`)),
      addresses: all.flatMap((el) => urls.filter((name) => (el.getAttribute(name) ?? '').includes(mark)).map((name) => `${tag(el)} ${name}`)),
    }
  }, { mark: MARK, urls: URL_ATTRIBUTES, running: RUNNING_ELEMENTS })
}
const NOTHING_MADE = { elements: [], images: 0, handlers: [], addresses: [] }

// an image's error and a frame's load come after the drawing
const settle = (page: Page) => page.waitForTimeout(1500)

let kubeconfig = ''
// kubectl on self with the kind cluster's own kubeconfig, written on first use (the chats need none)
function kubectl(args: string[], input?: string): string {
  if (!kubeconfig) {
    kubeconfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-no-script-')), 'kubeconfig')
    fs.writeFileSync(kubeconfig, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
  }
  return execFileSync('kubectl', ['--kubeconfig', kubeconfig, '--context', 'kind-kubeast', ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const psql = (statement: string) => kubectl(['-n', 'kubeast', 'exec', 'deploy/postgres', '--', 'psql', '-U', 'kubeast', '-d', 'kubeast', '-tAc', statement])
const sql = (value: string) => `$e2e$${value}$e2e$`

async function features(page: Page) {
  const res = await page.request.get(`/api/v1/cluster/features?cluster=${CLUSTER}`)
  expect(res.ok(), `features: ${res.status()}`).toBeTruthy()
  return res.json()
}

async function dropSession(page: Page, id: string) {
  if (id) await page.request.delete(`/api/v1/sessions/${id}?cluster=${CLUSTER}`, { headers: XRW, failOnStatusCode: false })
}

async function newSession(page: Page, title: string): Promise<string> {
  const created = await page.request.post(`/api/v1/sessions?cluster=${CLUSTER}`, { headers: XRW, data: { title } })
  expect(created.ok(), `create session: ${created.status()}`).toBeTruthy()
  return withUndo((await created.json()).id as string, (id) => dropSession(page, id))
}

const RESULT = ['planted result', ...PLANTED].join('\n')
const STREAM = [
  { content: BEFORE },
  { function: 'k8s_pod_logs', args: {}, call_id: 0 },
  { function_result: 'k8s_pod_logs', result: RESULT, call_id: 0 },
  { content: `\n\n${PLANTED.join('\n\n')}\n\n${AFTER}` },
]
// the saved answer as ai-service writes it (streaming.answer_markdown)
const SAVED = `${BEFORE}\n\n<details>\n<summary>🔧 <strong>k8s_pod_logs</strong></summary>\n\n<p><strong>📋 Arguments:</strong> No arguments</p>\n\n<details>\n<summary><strong>📊 Results</strong></summary>\n\n\`\`\`\n${RESULT}\n\`\`\`\n\n</details>\n\n</details>\n\n${PLANTED.join('\n\n')}\n\n${AFTER}`

// answers the chat request with STREAM and stores the turn as the server would; resolves once both are done
function answerWithStream(page: Page, address: RegExp) {
  let sessionId = ''
  let done!: () => void
  const finished = new Promise<void>((resolve) => (done = resolve))
  const handler = async (route: Route) => {
    sessionId = /sessions\/([^/]+)\//.exec(route.request().url())?.[1] ?? ''
    const saved = await page.request.post(`/api/v1/sessions/${sessionId}/messages?cluster=${CLUSTER}`, {
      headers: XRW, data: { messages: [{ role: 'user', content: route.request().postDataJSON().message }, { role: 'assistant', content: SAVED }] },
    })
    expect(saved.ok(), `save messages: ${saved.status()}`).toBeTruthy()
    const body = STREAM.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n'
    await route.fulfill({ contentType: 'text/event-stream', body })
    done()
  }
  return withUndo({ ready: page.route(address, handler), finished, session: () => sessionId }, (c) => dropSession(page, c.session()))
}

// the tool result in its code block as the words the tool returned, the block open or not
async function expectResultAsWords(answer: Locator) {
  const code = answer.locator('pre code').filter({ hasText: 'planted result' })
  await expect(code).toHaveCount(1)
  expect(await code.textContent()).toBe(`${RESULT}\n`)
}

test.describe('Drawn text runs no script', () => {
  test('AI Chat: the markup of a saved answer runs no script and makes no element that would', async ({ page }) => {
    const ran = await watch(page)
    const title = `e2e-no-script-${stamp()}`
    const id = await newSession(page, title)
    try {
      const saved = await page.request.post(`/api/v1/sessions/${id}/messages?cluster=${CLUSTER}`, {
        headers: XRW, data: { messages: [{ role: 'user', content: 'show the markup' }, { role: 'assistant', content: [BEFORE, ...PLANTED, AFTER].join('\n\n') }] },
      })
      expect(saved.ok(), `save messages: ${saved.status()}`).toBeTruthy()
      await page.goto(`/ai-chat?cluster=${CLUSTER}`)
      await page.waitForLoadState('networkidle')
      await page.getByText(title, { exact: true }).first().click()

      const bubble = page.locator(ASSISTANT).last()
      await expect(bubble).toContainText(AFTER)
      await expect(bubble).toContainText(BEFORE)
      await settle(page)
      expect(await madeFrom(bubble)).toEqual(NOTHING_MADE)
      expect(await ran()).toEqual(NOTHING_RAN)
    } finally {
      await dropSession(page, id)
    }
  })

  test('AI Chat: markup in an answer and in its tool result runs no script, while the answer comes and once saved', async ({ page }) => {
    const ran = await watch(page)
    await page.clock.install()
    const title = `e2e-no-script-${stamp()}`
    const id = await newSession(page, title)
    const chat = answerWithStream(page, new RegExp(`/api/v1/ai/sessions/${id}/chat`))
    await chat.ready
    try {
      await page.goto(`/ai-chat?cluster=${CLUSTER}`)
      await page.waitForLoadState('networkidle')
      await page.getByText(title, { exact: true }).first().click()

      // the page clock stops once the question is sent, so the last words wait in the typewriter
      await page.clock.pauseAt(Date.now() + 1000)
      await page.getByTestId('chat-input').fill('show the markup')
      await page.getByRole('button', { name: /전송|send/i }).click()
      await chat.finished
      const coming = page.locator(ASSISTANT).last()
      await expect(coming.getByRole('button', { name: /🔧 k8s_pod_logs/ })).toBeVisible()
      await expectResultAsWords(coming)
      await settle(page)
      expect(await madeFrom(coming)).toEqual(NOTHING_MADE)
      expect(await ran()).toEqual(NOTHING_RAN)

      await page.clock.resume()
      await expect(page.getByTestId('chat-input')).toBeEnabled({ timeout: 15_000 })
      const saved = page.locator(ASSISTANT).last()
      await expect(saved).toContainText(AFTER)
      await expectResultAsWords(saved)
      await settle(page)
      expect(await madeFrom(saved)).toEqual(NOTHING_MADE)
      expect(await ran()).toEqual(NOTHING_RAN)
    } finally {
      await dropSession(page, id)
    }
  })

  test('the floating chat: markup in an answer and in its tool result runs no script, while the answer comes and once saved', async ({ page }) => {
    const ran = await watch(page)
    await page.clock.install()
    const chat = answerWithStream(page, /\/api\/v1\/ai\/sessions\/[^/]+\/floating-chat/)
    await chat.ready
    try {
      await page.goto(`/?cluster=${CLUSTER}`)
      await page.getByTestId('floating-chat-toggle').click()
      const input = page.getByTestId('floating-chat-input')
      await expect(input).toBeVisible()

      await page.clock.pauseAt(Date.now() + 1000)
      await input.fill('show the markup')
      await input.press('Enter')
      await chat.finished
      const coming = page.getByTestId('floating-answer').last()
      await expect(coming.getByRole('button', { name: /🔧 k8s_pod_logs/ })).toBeVisible()
      await expectResultAsWords(coming)
      await settle(page)
      expect(await madeFrom(coming)).toEqual(NOTHING_MADE)
      expect(await ran()).toEqual(NOTHING_RAN)

      await page.clock.resume()
      const saved = page.getByTestId('floating-answer').last()
      await expect(saved.getByTestId('floating-copy')).toBeVisible({ timeout: 15_000 })
      await expect(saved).toContainText(AFTER)
      await expectResultAsWords(saved)
      await settle(page)
      expect(await madeFrom(saved)).toEqual(NOTHING_MADE)
      expect(await ran()).toEqual(NOTHING_RAN)
    } finally {
      await dropSession(page, chat.session())
    }
  })

  test('an alert and its investigation: markup in the labels, annotations, links, report and result runs no script', async ({ page }) => {
    test.setTimeout(90_000)
    const ran = await watch(page)
    test.skip(!(await features(page)).alertInvestigation?.enabled, 'alert investigation (the inbox and its reports) is off')

    const run = stamp()
    const alertname = `E2eNoScript${run}`
    const labels = { alertname, severity: 'info', namespace: 'default', planted: IMG }
    const annotations = { summary: `${SCRIPT} in the summary`, description: PLANTED.join('\n') }
    // Alertmanager's own addresses as the webhook stores them, unchecked
    const source = `javascript:${call(20)}`
    const sender = `javascript:${call(21)}`
    const toolCalls = [{ tool: 'k8s_get_events', args: { note: IMG }, step: 1, result_chars: 10 }]
    const block = {
      version: 1, status: 'ok', no_fault: false,
      causes: [{ resource: `pod/${IMG}`, kind: 'config', started_at: null, evidence: [{ call: 1, tool: 'k8s_get_events' }], verified: false, reason: 'no_evidence' }],
      path: [SVG, 'deployment/web'],
      ruled_out: [SCRIPT],
      hypotheses: [{ id: 'h1', statement: DETAILS, resource: IMG, state: 'blocked', for: [{ call: 1, tool: 'k8s_get_events' }], against: [], blocked: SCRIPT, closed: false, problems: [{ reason: 'bad_calls', calls: [SVG] }] }],
      asked_again: false,
      checks: { evidence: true, ledger: true },
    }
    const report = [BEFORE, ...PLANTED, AFTER].join('\n\n')
    // one start for both rows: the window finds the alert's investigation by its fingerprint and start
    const at = new Date(Date.now() - 10 * 60_000).toISOString().replace('T', ' ').replace('Z', '')
    const alertId = withUndo(`e2e-no-script-${run}`, (i) => psql(`DELETE FROM alert_inbox WHERE id = '${i}'`))
    const reportId = withUndo(`inv-e2e-no-script-${run}`, (i) => psql(`DELETE FROM alert_investigations WHERE id = '${i}'`))
    const alert = [CLUSTER, `e2e-no-script-${run}`, at, alertname, 'info', 'default'].map(sql).join(', ') +
      `, ${sql(JSON.stringify(labels))}::jsonb, ${sql(JSON.stringify(annotations))}::jsonb, ${sql(source)}, ${sql(sender)}`
    const columns = 'cluster, fingerprint, starts_at, alertname, severity, namespace, labels, annotations, generator_url, alertmanager_url'
    try {
      psql(`INSERT INTO alert_inbox (id, ${columns}, state, resolved_at, first_received_at, last_received_at, receiver)
            VALUES (${sql(alertId)}, ${alert}, 'resolved', ${sql(at)}, ${sql(at)}, ${sql(at)}, 'kubeast')`)
      psql(`INSERT INTO alert_investigations (id, ${columns}, status, received_at, last_seen_at, iterations, tool_calls, report, error, provider, model, requested_by, result)
            VALUES (${sql(reportId)}, ${alert}, 'done', ${sql(at)}, ${sql(at)}, 1, ${sql(JSON.stringify(toolCalls))}::jsonb, ${sql(report)}, '', 'stub', 'small', '', ${sql(JSON.stringify(block))}::jsonb)`)

      await page.goto(`/alerts?cluster=${CLUSTER}&alert=${alertId}`)
      const detail = page.getByTestId('alert-detail')
      await expect(detail).toContainText(annotations.description, { timeout: 15_000 })
      await expect(detail).toContainText(annotations.summary)
      await expect(detail.getByTestId('alert-labels')).toContainText(IMG)
      await settle(page)
      expect(await madeFrom(detail)).toEqual(NOTHING_MADE)
      expect(await ran()).toEqual(NOTHING_RAN)

      await detail.getByTestId('alert-report').click()
      const modal = page.getByTestId('investigation-modal')
      const drawn = modal.getByTestId('investigation-report')
      await expect(drawn).toContainText(AFTER)
      await expect(drawn).toContainText(BEFORE)
      // a report draws no HTML: its markup reads as the words it is
      await expect(drawn).toContainText(SCRIPT)
      await expect(drawn).toContainText(IMG)
      const result = modal.getByTestId('investigation-result')
      await expect(result.getByTestId('investigation-result-path')).toHaveText(`${SVG} → deployment/web`)
      await expect(result.getByTestId('investigation-result-ruled-out')).toHaveText(SCRIPT)
      await expect(result.getByTestId('investigation-result-causes')).toContainText(`pod/${IMG}`)
      await expect(result.getByTestId('investigation-hypotheses')).toContainText(DETAILS)
      await expect(result.getByTestId('investigation-hypotheses')).toContainText(SCRIPT)
      await expect(modal).toContainText(annotations.description)
      await settle(page)
      expect(await madeFrom(modal)).toEqual(NOTHING_MADE)
      expect(await ran()).toEqual(NOTHING_RAN)
    } finally {
      psql(`DELETE FROM alert_investigations WHERE id = '${reportId}'`)
      psql(`DELETE FROM alert_inbox WHERE id = '${alertId}'`)
    }
  })

  test('a Helm revision: markup in its history, manifest and diff (drawn from an HTML string) runs no script', async ({ page }) => {
    test.setTimeout(60_000)
    const ran = await watch(page)
    const detail = await page.request.get(`/api/v1/helm/releases/kubeast/kubeast?cluster=${CLUSTER}`, { failOnStatusCode: false })
    test.skip(!detail.ok(), `no Helm release kubeast/kubeast on cluster self (${detail.status()})`)
    const current = (await detail.json()).revision as number
    const older = current > 1 ? current - 1 : current + 1
    const updated = new Date().toISOString()
    const manifest = ['apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: planted-manifest', 'data:', ...PLANTED.map((p, i) => `  piece${i}: ${p}`)].join('\n')
    const kept = ['apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: planted-manifest', 'data:']
    // the diff as k8s-service writes it (unifiedDiff): each piece changed in place
    const diff = [
      `--- kubeast/kubeast@${older}.manifest`,
      `+++ kubeast/kubeast@${current}.manifest`,
      `@@ -1,${kept.length + PLANTED.length} +1,${kept.length + PLANTED.length} @@`,
      ...kept.map((l) => ` ${l}`),
      ...PLANTED.flatMap((p, i) => [`-  piece${i}: ${p}`, `+  piece${i}: ${p} changed`]),
    ].join('\n') + '\n'
    // the browser's own answers: the release itself is left as it is
    const release = '**/api/v1/helm/releases/kubeast/kubeast'
    await page.route(`${release}/history*`, (route) => route.fulfill({ json: { items: [
      { revision: current, status: 'deployed', chartVersion: 'kubeast', appVersion: '', updated, description: 'Upgrade complete' },
      { revision: older, status: 'superseded', chartVersion: 'kubeast', appVersion: '', updated, description: `planted description ${SVG}` },
    ] } }))
    await page.route(`${release}/revisions/${older}/manifest*`, (route) => route.fulfill({ json: { revision: older, section: 'manifest', content: manifest } }))
    await page.route(`${release}/diff*`, (route) => route.fulfill({ json: { from: older, to: current, section: 'manifest', diff } }))

    await page.goto(`/helm/releases/kubeast/kubeast?cluster=${CLUSTER}`)
    await expect(page.locator('h1.text-3xl').first()).toHaveText('kubeast', { timeout: 30_000 })
    await page.getByRole('button', { name: /^(History|이력)$/ }).click()
    const row = page.getByRole('row').filter({ hasText: 'planted description' })
    await expect(row).toContainText(SVG)
    expect(await madeFrom(row)).toEqual(NOTHING_MADE)
    await row.click()

    const shown = page.locator('pre').filter({ hasText: 'planted-manifest' })
    expect(await shown.innerText()).toBe(manifest)
    await settle(page)
    expect(await madeFrom(shown)).toEqual(NOTHING_MADE)
    await page.getByRole('button', { name: /^(Diff vs current|현재와 비교)$/ }).click()
    const drawn = page.locator('.helm-diff2html')
    for (const piece of PLANTED) await expect(drawn).toContainText(`${piece} changed`)
    await settle(page)
    expect(await madeFrom(drawn)).toEqual(NOTHING_MADE)
    expect(await ran()).toEqual(NOTHING_RAN)
  })
})

// A pod of the run in default prints the planted pieces, one a line, and writes them to a file the dev values' log
// files pattern (/var/log/app/*.log) lists; an event about it holds three of them in its message.
test.describe.serial('Drawn text runs no script: a pod\'s logs and events', () => {
  const pod = `e2e-no-script-${stamp()}`
  const file = '/var/log/app/planted.log'
  const message = `planted event ${SCRIPT} ${IMG} ${SVG}`
  let made = false

  test.beforeAll(() => {
    test.setTimeout(180_000)
    const labels = { 'app.kubernetes.io/name': 'e2e-no-script' }
    made = true
    kubectl(['create', '-f', '-'], JSON.stringify({ apiVersion: 'v1', kind: 'List', items: [
      { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: pod, namespace: 'default', labels }, data: { lines: `${PLANTED.join('\n')}\n` } },
      { apiVersion: 'v1', kind: 'Pod', metadata: { name: pod, namespace: 'default', labels }, spec: {
        terminationGracePeriodSeconds: 0,
        containers: [{
          name: 'app', image: 'docker.io/library/busybox:1.38.0',
          command: ['sh', '-c', `mkdir -p /var/log/app && cp /planted/lines ${file} && cat /planted/lines && exec sleep 86400`],
          volumeMounts: [{ name: 'planted', mountPath: '/planted' }],
        }],
        volumes: [{ name: 'planted', configMap: { name: pod } }],
      } },
    ] }))
    kubectl(['wait', '--for=condition=Ready', `pod/${pod}`, '-n', 'default', '--timeout=120s'])
    const uid = kubectl(['get', 'pod', pod, '-n', 'default', '-o', 'jsonpath={.metadata.uid}'])
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
    kubectl(['create', '-f', '-'], JSON.stringify({
      apiVersion: 'v1', kind: 'Event', metadata: { name: `${pod}.planted`, namespace: 'default' },
      involvedObject: { apiVersion: 'v1', kind: 'Pod', name: pod, namespace: 'default', uid },
      reason: 'E2ENoScript', message, type: 'Warning', count: 1, firstTimestamp: now, lastTimestamp: now, source: { component: 'e2e' },
    }))
  })

  test.afterAll(() => {
    if (made) kubectl(['delete', `pod/${pod}`, `configmap/${pod}`, `event/${pod}.planted`, '-n', 'default', '--ignore-not-found', '--wait=false'])
  })

  test('the Cluster View Logs tab and its Log files view draw the logged markup as its words and run none of it', async ({ page }) => {
    test.setTimeout(90_000)
    const ran = await watch(page)
    const files = (await features(page)).logFiles?.enabled === true
    await page.goto(`/cluster-view?cluster=${CLUSTER}`)
    await expect(page.getByRole('heading', { name: /클러스터 뷰|Cluster view/i })).toBeVisible({ timeout: 15_000 })
    await page.getByPlaceholder(/Search pod name|Pod 이름/i).fill(pod)
    await page.getByTestId('cluster-view-pod').filter({ hasText: pod }).first().click()

    if (files) await expect(page.getByTestId('log-source-stdout')).toHaveAttribute('aria-pressed', 'true')
    const stdout = page.locator('pre.whitespace-pre-wrap').first()
    await expect(stdout).toContainText(PLANTED[PLANTED.length - 1], { timeout: 15_000 })
    // the tab follows the log with its times: each line is a time, then the words the pod wrote
    const lines = (await stdout.innerText()).trimEnd().split('\n')
    for (const line of lines) expect(line).toMatch(LINE_TIME)
    expect(lines.map((line) => line.replace(LINE_TIME, ''))).toEqual(PLANTED)
    await settle(page)
    expect(await madeFrom(stdout)).toEqual(NOTHING_MADE)
    expect(await ran()).toEqual(NOTHING_RAN)

    // with features.logFiles off the container output is all the tab reads
    if (files) await test.step('the Log files view', async () => {
      await page.getByTestId('log-source-files').click()
      await expect(page.getByTestId('logfile-select')).toContainText(file)
      const output = page.getByTestId('logfile-output').locator('pre')
      await expect(output).toContainText(PLANTED[PLANTED.length - 1], { timeout: 15_000 })
      expect((await output.innerText()).trimEnd().split('\n')).toEqual(PLANTED)
      await settle(page)
      expect(await madeFrom(page.getByTestId('logfile-output'))).toEqual(NOTHING_MADE)
      expect(await ran()).toEqual(NOTHING_RAN)
    })
  })

  test('the Pod drawer draws the logged markup and the event message as their words and runs none of it', async ({ page }) => {
    test.setTimeout(60_000)
    const ran = await watch(page)
    await page.goto(`/workloads/pods?cluster=${CLUSTER}&namespace=default&detail=Pod/default/${pod}`)
    const drawer = page.locator(DRAWER).last()
    await expect(drawer).toContainText(message, { timeout: 20_000 })
    await drawer.getByRole('button', { name: /^(Load Logs|로그 불러오기)$/ }).click()
    for (const line of PLANTED) await expect(drawer).toContainText(line, { timeout: 15_000 })
    await settle(page)
    expect(await madeFrom(drawer)).toEqual(NOTHING_MADE)
    expect(await ran()).toEqual(NOTHING_RAN)
  })
})

// After a test that did not pass, the undos it registered with withUndo run as well: a test that times out has its
// request context and browser ended before its own finally runs, if it runs at all. Each undo is safe to run twice.
const undos: (() => unknown)[] = []
function withUndo<T>(value: T, undo: (value: T) => unknown): T {
  undos.push(() => undo(value))
  return value
}
test.afterEach(async ({}, testInfo) => {
  const registered = undos.splice(0).reverse()
  if (testInfo.status === 'passed' || testInfo.status === 'skipped') return
  for (const undo of registered) await (async () => undo())().catch(() => undefined)
})
