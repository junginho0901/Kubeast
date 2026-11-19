import { test, expect, type APIRequestContext } from '@playwright/test'

import { CLUSTER, Probe, type Answer, bearer, deploymentExists, kubectl, kubectlAsync, login, longestGap, notOk, podsOf, restartCounts, restartsSince, rolledOutAsync, show, sleep, NS } from './shared'

// PR #856 (chart podShutdown.preStopSeconds): the Deployments a Service sends to wait in preStop before SIGTERM, so a
// rollout with requests in flight answers no 5xx and does not hang (before it, a request right after
// `rollout restart deployment/auth-service` waited 30 s, gateway 499). Step 4 F-6 / step 3 §6 test 10 on one replica.
//
// For each Deployment: a probe sends about 10 requests a second through the gateway to routes that reach it, the
// Deployment is restarted four times with no wait between the restart and the next request, and every answer is held
// to 200 and to the probe's own time limit (no answer = status 0). The restart counts of the pods that stayed are held
// to 0. A Deployment the install does not run, or a route the install does not serve (the AI off, MCP off), skips its
// case with the reason. What it changes: four rollouts per Deployment; each case waits for its rollout to end.
// kubectl runs through kubectlAsync while the probe sends: a synchronous kubectl holds the worker's event loop, so the
// probe would send nothing during the rollouts and time the request it had started with the whole wait.

// A request that takes longer than this counts as a hang (the bug held one for 30 s).
const HANG_MS = Number(process.env.E2E_FAULT_HANG_MS || 5_000)
const ROUNDS = Number(process.env.E2E_FAULT_ROLLOUTS || 4)
// The probe sends every 100 ms; a longer time between two of its requests means the loop was held (see above). Below
// HANG_MS, so a hold alone cannot make an answer read as a hang.
const SEND_GAP_MS = 2_000

type Case = { deploy: string; why: string; paths: (h: Record<string, string>, request: APIRequestContext) => Promise<string[] | string> }

const CASES: Case[] = [
  { deploy: 'auth-service', why: 'the cluster list', paths: async () => ['/api/v1/clusters', '/api/v1/auth/me'] },
  { deploy: 'k8s-service', why: 'a pod page and the overview', paths: async () => [`/api/v1/cluster/pods/page?cluster=${CLUSTER}&namespace=${NS}&limit=5`, `/api/v1/cluster/overview?cluster=${CLUSTER}`] },
  { deploy: 'session-service', why: 'the conversation list', paths: async () => [`/api/v1/sessions?cluster=${CLUSTER}`] },
  { deploy: 'ai-service', why: 'the AI health and model list', paths: async () => ['/api/v1/ai/health', '/api/v1/ai/model-configs'] },
  { deploy: 'frontend', why: 'the page itself', paths: async () => ['/', '/color-mode.js'] },
  { deploy: 'gateway', why: 'every route goes through it', paths: async () => ['/healthz', '/api/v1/clusters'] },
  // the cache is k8s-service's; a read that misses it still answers
  { deploy: 'redis', why: 'reads k8s-service caches', paths: async () => [`/api/v1/cluster/overview?cluster=${CLUSTER}`, `/api/v1/cluster/pods/page?cluster=${CLUSTER}&namespace=${NS}&limit=5`] },
  {
    deploy: 'tool-server', why: 'an MCP tool call goes to tool-server',
    paths: async (h, request) => {
      const config = await request.get('/api/v1/ai/mcp/config', { headers: h, failOnStatusCode: false })
      if (!config.ok() || !(await config.json()).enabled) return 'mcp.enabled is off: no route through the gateway reaches tool-server'
      return ['/api/v1/ai/mcp']
    },
  },
]

// The MCP route is a POST: the probe sends GET, so tool-server's case runs its own loop.
async function mcpProbe(request: APIRequestContext, token: string, stop: { done: boolean }) {
  const path = '/api/v1/ai/mcp'
  const answers: Answer[] = []
  while (!stop.done) {
    const at = Date.now()
    try {
      const res = await request.post(path, {
        headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        // the MCP server refuses a tool call naming no cluster before tool-server ("cluster is required")
        data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'clusters_list', arguments: { cluster: CLUSTER } } },
        timeout: 10_000, failOnStatusCode: false,
      })
      const body = res.ok() ? await res.json() : null
      answers.push({ at, path, status: body?.result?.isError ? 599 : res.status(), ms: Date.now() - at })
    } catch (e) {
      answers.push({ at, path, status: 0, ms: Date.now() - at, error: (e as Error).message.split('\n')[0] })
    }
    await sleep(100)
  }
  return answers
}

test.describe('pod shutdown: a rollout with requests in flight (PR #856, F-6 on one replica)', () => {
  test.describe.configure({ mode: 'serial' })

  for (const c of CASES) {
    test(`${c.deploy}: ${ROUNDS} restarts with requests in flight answer 200 within ${HANG_MS} ms (${c.why})`, async ({ request }) => {
      test.setTimeout(ROUNDS * 240_000)
      test.skip(!deploymentExists(c.deploy), `the install runs no ${c.deploy}`)
      const token = await login(request)
      const headers = bearer(token)
      const paths = await c.paths(headers, request)
      test.skip(typeof paths === 'string', typeof paths === 'string' ? paths : '')
      const preStop = kubectl(['-n', NS, 'get', 'deploy', c.deploy, '-o', 'jsonpath={.spec.template.spec.containers[0].lifecycle.preStop.sleep.seconds}'])
      test.info().annotations.push({ type: 'preStop', description: `${c.deploy}: sleep ${preStop || 'none'}` })

      const before = restartCounts()
      const stop = { done: false }
      const mcp = c.deploy === 'tool-server' ? mcpProbe(request, token, stop) : null
      const probe = mcp ? null : new Probe(request, paths as string[], headers, 100, HANG_MS * 2)
      let answers: Answer[] = []
      try {
        for (let i = 0; i < ROUNDS; i++) {
          await kubectlAsync(['-n', NS, 'rollout', 'restart', `deploy/${c.deploy}`])
          await rolledOutAsync(c.deploy)
        }
        // the old pods' preStop and shutdown run past `rollout status`
        await sleep(15_000)
      } finally {
        stop.done = true
        answers = mcp ? await mcp : await probe!.stop()
      }
      const failed = answers.filter((a) => a.status !== 200)
      const slow = answers.filter((a) => a.ms > HANG_MS)
      test.info().attach('answers.json', { body: JSON.stringify(answers), contentType: 'application/json' })

      expect(answers.length, 'the probe kept sending').toBeGreaterThan(ROUNDS * 20)
      // the MCP loop waits for each answer, so its gaps hold the answers' times
      if (!mcp) expect(longestGap(answers), 'ms between two requests of the probe while the rollouts ran').toBeLessThanOrEqual(SEND_GAP_MS)
      expect(failed.length, `answers other than 200:\n${show(failed)}`).toBe(0)
      expect(slow.length, `answers slower than ${HANG_MS} ms:\n${show(slow)}`).toBe(0)
      expect(restartsSince(before), 'restarts of the pods that stayed').toEqual({})
      expect(podsOf(c.deploy).filter((p) => !p.ready || p.deleting).map((p) => p.name), `${c.deploy} pods left not ready`).toEqual([])
    })
  }

  test('a pod deleted by hand right after a request starts answers it (no 5xx, no hang) — each Service-backed Deployment once', async ({ request }) => {
    test.setTimeout(CASES.length * 120_000)
    const token = await login(request)
    const headers = bearer(token)
    const misses: string[] = []
    for (const c of CASES) {
      if (!deploymentExists(c.deploy) || c.deploy === 'tool-server') continue
      const paths = await c.paths(headers, request)
      if (typeof paths === 'string') continue
      const pod = podsOf(c.deploy).find((p) => p.ready && !p.deleting)
      if (!pod) { misses.push(`${c.deploy}: no ready pod`); continue }
      const probe = new Probe(request, paths, headers, 100, HANG_MS * 2)
      await sleep(1_000)
      await kubectlAsync(['-n', NS, 'delete', 'pod', pod.name, '--wait=false'])
      await sleep(5_000)
      await rolledOutAsync(c.deploy)
      await sleep(10_000)
      const answers = await probe.stop()
      const bad = notOk(answers, (a) => a.status === 200 && a.ms <= HANG_MS)
      if (bad.length) misses.push(`${c.deploy}:\n${show(bad)}`)
      const gap = longestGap(answers)
      if (gap > SEND_GAP_MS) misses.push(`${c.deploy}: the probe sent nothing for ${gap} ms`)
    }
    expect(misses, 'Deployments whose deleted pod left a request unanswered, failed or slow').toEqual([])
  })
})
