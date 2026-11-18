import { test, expect, type APIRequestContext } from '@playwright/test'

import {
  STAMP, bearer, deploymentExists, forwardTo, internalKubeconfig, items, login, onPod, readyPods, restartCounts, restartsSince,
  sleep, stopFor, undoPending, type Forward,
} from './shared'

// PR #857 (cluster versions in the database): auth-service bumps a cluster's config_version in the statement that
// changes what its connection is built from, every k8s-service replica reads the versions every 5 s (± a fifth) and
// drops a bundle built from another version, and with Redis the replica auth-service told publishes a notice the
// others act on at once. Step 3 §6 test 6: a change of a cluster's registration reaches every server within 10 s and
// no request goes to the old connection after that; step 3 §7 M-2 lists it with F-8, so the second case stops Redis
// first and the database alone must carry the change.
//
// How: a cluster of the run is registered with the kubeconfig of the kind cluster `kubeast-b` (the dev `default`) and
// read on every k8s-service pod through a port-forward to that pod, so each replica builds its bundle. Its kubeconfig
// is then replaced with `test2`'s and each pod is asked for the cluster's nodes every 250 ms: each must name test2's
// node within 10 s of the PATCH's answer, and none may name kubeast-b's after it did. The cluster is deleted after.
// Skips without two ready k8s-service pods or without the kind clusters kubeast-b and test2.

const WITHIN_MS = 10_000
const OLD_KIND = process.env.E2E_FAULT_OLD_KIND || 'kubeast-b'
const NEW_KIND = process.env.E2E_FAULT_NEW_KIND || 'test2'
const K8S = 'k8s-service'

type Seen = { pod: string; at: number; nodes: string[]; status: number }

async function nodesOn(api: APIRequestContext, cluster: string): Promise<{ status: number; nodes: string[] }> {
  const res = await api.get(`/api/v1/nodes?cluster=${encodeURIComponent(cluster)}`, { timeout: 5_000, failOnStatusCode: false })
  if (!res.ok()) return { status: res.status(), nodes: [] }
  const rows = items<{ name?: string; metadata?: { name?: string } }>(await res.json())
  return { status: res.status(), nodes: rows.map((r) => r.name ?? r.metadata?.name ?? '').filter(Boolean).sort() }
}

const owns = (nodes: string[], kind: string) => nodes.some((n) => n.startsWith(`${kind}-`))

// Registers a cluster of the run on OLD_KIND, reads it on every pod, replaces its kubeconfig with NEW_KIND's and
// follows every pod for WITHIN_MS and a few seconds more. Returns when each pod first named NEW_KIND and the answers
// naming OLD_KIND after that.
async function changeAndFollow(request: APIRequestContext, during?: (follow: () => Promise<void>) => Promise<void>) {
  const token = await login(request)
  const admin = bearer(token)
  const oldKc = internalKubeconfig(OLD_KIND)!
  const newKc = internalKubeconfig(NEW_KIND)!
  const name = `e2e-w6-sync-${STAMP}-${Math.random().toString(36).slice(2, 6)}`
  const reg = await request.post('/api/v1/clusters', { headers: admin, data: { mode: 'external', display_name: name, kubeconfig: oldKc }, timeout: 60_000 })
  expect(reg.status(), await reg.text()).toBe(201)
  const id = (await reg.json()).id as string
  const forwards: Forward[] = []
  try {
    const pods = readyPods(K8S).map((p) => p.name)
    const apis = new Map<string, APIRequestContext>()
    for (const pod of pods) {
      const f = await forwardTo(pod, 8002)
      forwards.push(f)
      apis.set(pod, await onPod(f, token))
    }
    // every replica builds its bundle from the first kubeconfig
    for (const [pod, api] of apis) {
      await expect.poll(async () => owns((await nodesOn(api, id)).nodes, OLD_KIND), { message: `${pod} reads ${OLD_KIND} first`, timeout: 30_000 }).toBe(true)
    }

    const seen: Seen[] = []
    let patchedAt = 0
    const follow = async () => {
      const patch = await request.patch(`/api/v1/clusters/${id}`, { headers: admin, data: { kubeconfig: newKc }, timeout: 60_000 })
      patchedAt = Date.now()
      expect(patch.status(), await patch.text()).toBe(200)
      const until = patchedAt + WITHIN_MS + 5_000
      await Promise.all([...apis].map(async ([pod, api]) => {
        while (Date.now() < until) {
          const at = Date.now()
          const { status, nodes } = await nodesOn(api, id).catch(() => ({ status: 0, nodes: [] as string[] }))
          seen.push({ pod, at, nodes, status })
          await sleep(250)
        }
      }))
    }
    if (during) await during(follow)
    else await follow()

    const firstNew = Object.fromEntries(pods.map((pod) => {
      const hit = seen.find((s) => s.pod === pod && owns(s.nodes, NEW_KIND))
      return [pod, hit ? hit.at - patchedAt : null]
    }))
    const oldAfter = seen.filter((s) => {
      const switched = firstNew[s.pod]
      return switched !== null && s.at - patchedAt > switched && owns(s.nodes, OLD_KIND)
    })
    const lateOld = seen.filter((s) => s.at - patchedAt > WITHIN_MS && owns(s.nodes, OLD_KIND))
    test.info().attach('seen.json', { body: JSON.stringify({ patchedAt, firstNew, seen }), contentType: 'application/json' })
    return { pods, firstNew, oldAfter, lateOld }
  } finally {
    forwards.forEach((f) => f.close())
    await request.delete(`/api/v1/clusters/${id}`, { headers: admin, failOnStatusCode: false })
  }
}

test.describe('cluster versions in the database (PR #857, step 3 test 6)', () => {
  test.describe.configure({ mode: 'serial' })

  test.afterEach(() => undoPending())

  test.beforeEach(() => {
    test.skip(readyPods(K8S).length < 2, 'needs two ready k8s-service pods (replicas.k8sService: 2 once M-7 lets the chart render it)')
    test.skip(!internalKubeconfig(OLD_KIND), `needs the kind cluster ${OLD_KIND} (scripts/add-kind-cluster.sh default --addons)`)
    test.skip(!internalKubeconfig(NEW_KIND), `needs the kind cluster ${NEW_KIND} (scripts/add-kind-cluster.sh test2)`)
  })

  test('a changed kubeconfig reaches every k8s-service replica within 10 s, and no answer comes from the old connection after', async ({ request }) => {
    test.setTimeout(180_000)
    const before = restartCounts()
    const { pods, firstNew, oldAfter, lateOld } = await changeAndFollow(request)
    for (const pod of pods) {
      expect(firstNew[pod], `${pod} named ${NEW_KIND}'s node within ${WITHIN_MS} ms of the change (ms after it)`).not.toBeNull()
      expect(firstNew[pod]!, `${pod}: ms from the change to the first answer from ${NEW_KIND}`).toBeLessThanOrEqual(WITHIN_MS)
    }
    expect(oldAfter.map((s) => `${s.pod} +${s.at}`), 'answers from the old connection after a pod had switched').toEqual([])
    expect(lateOld.length, `answers from ${OLD_KIND} later than ${WITHIN_MS} ms after the change`).toBe(0)
    expect(restartsSince(before)).toEqual({})
  })

  test('with Redis stopped the change still reaches every replica within 10 s, from the versions alone (F-8 for M-2)', async ({ request }) => {
    test.skip(!deploymentExists('redis'), 'the install runs no Redis (redis.enabled false): the first case already has no notices')
    test.setTimeout(300_000)
    const before = restartCounts()
    const times: { outage?: { offAt: number; onAt: number } } = {}
    const result = await changeAndFollow(request, async (follow) => {
      // the change goes out once every Redis pod is gone (a terminating one still answers through its preStop); Redis
      // comes back after the follow — also on Ctrl-C or a timeout (atExit, the afterEach) and a killed worker (whenGone)
      times.outage = await stopFor('redis', 0, async () => {
        await sleep(5_000)
        await follow()
      })
    })
    test.info().attach('timeline.json', { body: JSON.stringify(times.outage && { redisGone: new Date(times.outage.offAt).toISOString(), redisBack: new Date(times.outage.onAt).toISOString() }, null, 2), contentType: 'application/json' })
    const { pods, firstNew, oldAfter, lateOld } = result
    for (const pod of pods) {
      expect(firstNew[pod], `${pod} named ${NEW_KIND}'s node with Redis stopped`).not.toBeNull()
      expect(firstNew[pod]!, `${pod}: ms from the change to the first answer from ${NEW_KIND}, Redis stopped`).toBeLessThanOrEqual(WITHIN_MS)
    }
    expect(oldAfter.length, 'answers from the old connection after a pod had switched').toBe(0)
    expect(lateOld.length, `answers from ${OLD_KIND} later than ${WITHIN_MS} ms after the change`).toBe(0)
    expect(restartsSince(before), 'no server restarted while Redis was down').toEqual({})
  })
})
