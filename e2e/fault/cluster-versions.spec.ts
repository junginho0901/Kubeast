import { test, expect, type APIRequestContext } from '@playwright/test'

import {
  ROTATION_NEEDS, STAMP, bearer, deploymentExists, forwardTo, items, login, onPod, readyPods, restartCounts, restartsSince,
  rotationCluster, sleep, stopFor, undoPending, type Forward,
} from './shared'

// PR #857 (cluster versions in the database): auth-service bumps a cluster's config_version in the statement that
// changes what its connection is built from, every k8s-service replica reads the versions every 5 s (± a fifth) and
// drops a bundle built from another version, and with Redis the replica auth-service told publishes a notice the
// others act on at once. Step 3 §6 test 6: a change of a cluster's registration reaches every server within 10 s and
// no request goes to the old connection after that; step 3 §7 M-2 lists it with F-8, so the second case stops Redis
// first and the database alone must carry the change.
//
// How: a cluster of the run is registered with the admin kubeconfig of a cluster the install has not registered
// (E2E_FAULT_ROTATE_*) and its nodes are read on every k8s-service pod through a port-forward to that pod, so each
// replica builds its bundle. Its kubeconfig is then replaced with the same cluster's ServiceAccount, which may not list
// nodes, and each pod is asked for the nodes every 250 ms from the moment the PATCH is sent: each must answer with that
// ServiceAccount's 403 within 10 s of the PATCH's answer, and none may list nodes after it did. seen.json has when the
// PATCH was sent and answered, so the time each pod took is read from either (with Redis stopped the answer comes
// seconds late: the k8s-service auth-service calls tries to publish its notice first). The cluster is deleted after.
// Skips without two ready k8s-service pods or without the two kubeconfigs.

const WITHIN_MS = 10_000
const K8S = 'k8s-service'
const rotation = rotationCluster()

type Seen = { pod: string; at: number; nodes: string[]; status: number; refusal: string }

async function nodesOn(api: APIRequestContext, cluster: string): Promise<{ status: number; nodes: string[]; refusal: string }> {
  const res = await api.get(`/api/v1/nodes?cluster=${encodeURIComponent(cluster)}`, { timeout: 5_000, failOnStatusCode: false })
  if (!res.ok()) return { status: res.status(), nodes: [], refusal: await res.text() }
  const rows = items<{ name?: string; metadata?: { name?: string } }>(await res.json())
  return { status: res.status(), nodes: rows.map((r) => r.name ?? r.metadata?.name ?? '').filter(Boolean).sort(), refusal: '' }
}

// the admin credential lists the nodes; the ServiceAccount is refused them with its own name in the answer
const fromOld = (s: { status: number; nodes: string[] }) => s.status === 200 && s.nodes.length > 0
const fromNew = (s: { status: number; refusal: string }) => s.status === 403 && s.refusal.includes(rotation!.limitedUser)

// Registers a cluster of the run with the admin kubeconfig, reads it on every pod, replaces its kubeconfig with the
// ServiceAccount's and follows every pod for WITHIN_MS and a few seconds more. Returns when each pod first answered with
// the ServiceAccount's refusal and the answers listing nodes after that.
async function changeAndFollow(request: APIRequestContext, during?: (follow: () => Promise<void>) => Promise<void>) {
  const token = await login(request)
  const admin = bearer(token)
  const name = `e2e-w6-sync-${STAMP}-${Math.random().toString(36).slice(2, 6)}`
  const reg = await request.post('/api/v1/clusters', { headers: admin, data: { mode: 'external', display_name: name, kubeconfig: rotation!.admin }, timeout: 60_000 })
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
    // every replica builds its bundle from the admin kubeconfig
    for (const [pod, api] of apis) {
      await expect.poll(async () => fromOld(await nodesOn(api, id)), { message: `${pod} lists the nodes with the admin credential first`, timeout: 30_000 }).toBe(true)
    }

    const seen: Seen[] = []
    let patchSentAt = 0
    let patchedAt = 0
    const follow = async () => {
      patchSentAt = Date.now()
      const answered = request.patch(`/api/v1/clusters/${id}`, { headers: admin, data: { kubeconfig: rotation!.limited }, timeout: 60_000 })
        .finally(() => { patchedAt = Date.now() })
      const [patch] = await Promise.all([answered, ...[...apis].map(async ([pod, api]) => {
        while (!patchedAt || Date.now() < patchedAt + WITHIN_MS + 5_000) {
          const at = Date.now()
          const { status, nodes, refusal } = await nodesOn(api, id).catch(() => ({ status: 0, nodes: [] as string[], refusal: '' }))
          seen.push({ pod, at, nodes, status, refusal })
          await sleep(250)
        }
      })])
      expect(patch.status(), await patch.text()).toBe(200)
    }
    if (during) await during(follow)
    else await follow()

    // ms from the PATCH's answer (below zero: the pod had switched before it came) and from its sending
    const firstAt = new Map(pods.map((pod) => [pod, seen.find((s) => s.pod === pod && fromNew(s))?.at ?? null]))
    const since = (from: number) => Object.fromEntries(pods.map((pod) => [pod, firstAt.get(pod) == null ? null : firstAt.get(pod)! - from]))
    const firstNew = since(patchedAt)
    const firstNewFromSent = since(patchSentAt)
    const oldAfter = seen.filter((s) => {
      const switched = firstNew[s.pod]
      return switched !== null && s.at - patchedAt > switched && fromOld(s)
    })
    const lateOld = seen.filter((s) => s.at - patchedAt > WITHIN_MS && fromOld(s))
    test.info().attach('seen.json', {
      body: JSON.stringify({ patchSentAt, patchedAt, patchMs: patchedAt - patchSentAt, firstNew, firstNewFromSent, seen }),
      contentType: 'application/json',
    })
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
    test.skip(!rotation, ROTATION_NEEDS)
  })

  test('a changed kubeconfig reaches every k8s-service replica within 10 s, and no answer comes from the old connection after', async ({ request }) => {
    test.setTimeout(180_000)
    const before = restartCounts()
    const { pods, firstNew, oldAfter, lateOld } = await changeAndFollow(request)
    for (const pod of pods) {
      expect(firstNew[pod], `${pod} answered as the ServiceAccount within ${WITHIN_MS} ms of the change (ms after it)`).not.toBeNull()
      expect(firstNew[pod]!, `${pod}: ms from the change to the first answer as the ServiceAccount`).toBeLessThanOrEqual(WITHIN_MS)
    }
    expect(oldAfter.map((s) => `${s.pod} +${s.at}`), 'answers from the old connection after a pod had switched').toEqual([])
    expect(lateOld.length, `node lists of the admin credential later than ${WITHIN_MS} ms after the change`).toBe(0)
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
      expect(firstNew[pod], `${pod} answered as the ServiceAccount with Redis stopped`).not.toBeNull()
      expect(firstNew[pod]!, `${pod}: ms from the change to the first answer as the ServiceAccount, Redis stopped`).toBeLessThanOrEqual(WITHIN_MS)
    }
    expect(oldAfter.length, 'answers from the old connection after a pod had switched').toBe(0)
    expect(lateOld.length, `node lists of the admin credential later than ${WITHIN_MS} ms after the change`).toBe(0)
    expect(restartsSince(before), 'no server restarted while Redis was down').toEqual({})
  })
})
