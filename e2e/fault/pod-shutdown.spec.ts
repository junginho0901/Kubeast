import { test, expect, type APIRequestContext } from '@playwright/test'

import {
  CLUSTER, NodeProbe, Probe, SEND_GAP_MS, type Answer, bearer, containerOf, deploymentExists, expectProbeKeptSending, gatewayOnNode, kubectl, kubectlAsync,
  login, longestGap, notOk, podsOf, replicasOf, restartCounts, restartsSince, rolledOutAsync, show, sleep, NS,
} from './shared'

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
      if (!mcp) expectProbeKeptSending(answers)
      expect(failed.length, `answers other than 200:\n${show(failed)}`).toBe(0)
      expect(slow.length, `answers slower than ${HANG_MS} ms:\n${show(slow)}`).toBe(0)
      expect(restartsSince(before), 'restarts of the pods that stayed').toEqual({})
      expect(podsOf(c.deploy).filter((p) => !p.ready || p.deleting).map((p) => p.name), `${c.deploy} pods left not ready`).toEqual([])
    })
  }

  // A pod deleted is not replaced first (maxSurge is for rollouts), so with one pod nothing answers from its SIGTERM,
  // after the preStop wait, until the new pod is ready: that gap is held to the readiness probe's initialDelaySeconds +
  // 2 × periodSeconds + 5 s, and no answer, in it or out of it, takes longer than HANG_MS. With two or more pods every
  // answer is 200 within HANG_MS.
  test('a pod deleted by hand: with two or more pods no 5xx and no hang, with one answers other than 200 only until the new pod\'s second readiness probe + 5 s and none slower than HANG_MS — each Service-backed Deployment once', async ({ request }) => {
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
      const replicas = replicasOf(c.deploy)
      const readiness = JSON.parse(kubectl(['-n', NS, 'get', 'deploy', c.deploy, '-o', 'jsonpath={.spec.template.spec.containers[0].readinessProbe}']) || '{}') as { initialDelaySeconds?: number; periodSeconds?: number }
      const delayS = readiness.initialDelaySeconds ?? 0
      const periodS = readiness.periodSeconds ?? 0
      // the gateway's own pod is read from the kind node: Docker Desktop's published port holds a laptop's request while no gateway answers
      const onNode = c.deploy === 'gateway' ? gatewayOnNode(containerOf(pod.name).node) : null
      if (c.deploy === 'gateway' && !onNode) { misses.push('gateway: no NodePort or node address to send from the kind node'); continue }
      const probe = onNode ? new NodeProbe(onNode.node, onNode.url, paths, token, 100, HANG_MS * 2) : new Probe(request, paths, headers, 100, HANG_MS * 2)
      await sleep(1_000)
      await kubectlAsync(['-n', NS, 'delete', 'pod', pod.name, '--wait=false'])
      await sleep(5_000)
      await rolledOutAsync(c.deploy)
      await sleep(10_000)
      const answers = await probe.stop()
      test.info().attach(`answers-${c.deploy}.json`, { body: JSON.stringify(answers), contentType: 'application/json' })
      const gap = longestGap(answers)
      if (gap > SEND_GAP_MS) misses.push(`${c.deploy}: the probe sent nothing for ${gap} ms`)
      const slow = answers.filter((a) => a.ms > HANG_MS)
      if (slow.length) misses.push(`${c.deploy}: answers slower than ${HANG_MS} ms:\n${show(slow)}`)
      const failed = notOk(answers)
      if (replicas >= 2) {
        if (failed.length) misses.push(`${c.deploy} (${replicas} pods): answers other than 200:\n${show(failed)}`)
        continue
      }
      // one pod: from the start of the first answer other than 200 to the end of the last
      const spanMs = failed.length ? Math.max(...failed.map((a) => a.at + a.ms)) - failed[0].at : 0
      // the new pod is ready at its first readiness probe after initialDelaySeconds, or at the next one when that came too early
      const limitMs = (delayS + periodS * 2 + 5) * 1000
      const kinds = Object.entries(failed.reduce<Record<string, number>>((m, a) => ({ ...m, [a.status]: (m[a.status] ?? 0) + 1 }), {})).map(([s, n]) => `${s} ×${n}`).join(', ')
      test.info().annotations.push({ type: 'gap with one pod', description: `${c.deploy}${onNode ? ' (sent from the kind node)' : ''}: ${spanMs} ms of answers other than 200 (limit ${limitMs} ms = readiness initialDelaySeconds ${delayS} + 2 × periodSeconds ${periodS} + 5 s), ${failed.length} of ${answers.length}${kinds ? `: ${kinds}` : ''}` })
      if (spanMs > limitMs) misses.push(`${c.deploy} (1 pod): answers other than 200 for ${spanMs} ms, past ${limitMs} ms:\n${show(failed)}`)
    }
    expect(misses, 'Deployments whose deleted pod left a request failed or slow past what the pod count allows').toEqual([])
  })
})
