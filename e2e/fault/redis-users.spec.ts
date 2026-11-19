import { test, expect, type APIRequestContext } from '@playwright/test'

import {
  CLUSTER, NS, Probe, STAMP, bearer, deploymentExists, internalKubeconfig, kubectl, kubectlOk, login, podLog, readyPods, restartCounts,
  podsOf, restartsSince, rolledOut, show, sleep, stopFor, takeDown, undoPending, type Answer,
} from './shared'

// PR #866 (one Redis user per service): the chart's Valkey runs an ACL file — k8s-service reaches kubeast:* keys and
// channels with the commands its cache and the cluster notices send, tool-server only subscribes to the cluster change
// channel, the probes only PING, the default user is off — and tool-server drops a cluster's kubeconfig on
// k8s-service's change notice and keeps one at most 10 s. Step 3 §7 M-6b: "ACL refusal test" and "test 6 (tool-server
// 10 s)"; step 4 F-8 (Redis off 60 s, then on: screen reads error 0, server restarts 0, recovery by itself) is in this
// file too, with the case of a k8s-service that started while Redis was down (PR #857: "a cache that started without
// Redis moves there when it answers").
//
// The passwords are read from the Secret the redis pod reads them from and go to valkey-cli on stdin, never on a command
// line. Each case skips with the reason: no Redis, the users off (redis.acl.enabled false or an existingSecret without
// the keys), MCP off for the tool-server case, the kind clusters kubeast-b and test2 missing.

const REDIS = 'redis'
const K8S = 'k8s-service'
const OLD_KIND = process.env.E2E_FAULT_OLD_KIND || 'kubeast-b'
const NEW_KIND = process.env.E2E_FAULT_NEW_KIND || 'test2'

type RedisContainer = { args?: string[]; env?: { name: string; valueFrom?: { secretKeyRef?: { name: string; key: string } } }[] }
const redisSpec = (): RedisContainer | null => {
  if (!deploymentExists(REDIS)) return null
  const containers = JSON.parse(kubectl(['-n', NS, 'get', 'deploy', REDIS, '-o', 'jsonpath={.spec.template.spec.containers}'])) as (RedisContainer & { name: string })[]
  return containers.find((c) => c.name === 'redis') ?? null
}
const aclOn = () => !!redisSpec()?.args?.includes('--aclfile')
const usersSecret = () => redisSpec()?.env?.find((e) => e.name === 'REDISCLI_AUTH')?.valueFrom?.secretKeyRef?.name ?? 'kubeast-redis-users'

// ready addresses of a Service's EndpointSlices: what kube-proxy sends to
function readyEndpoints(service: string): number {
  const raw = JSON.parse(kubectl(['-n', NS, 'get', 'endpointslices', '-l', `kubernetes.io/service-name=${service}`, '-o', 'json'])) as {
    items: { endpoints?: { addresses: string[]; conditions?: { ready?: boolean } }[] }[]
  }
  return raw.items.flatMap((s) => s.endpoints ?? []).filter((e) => e.conditions?.ready !== false).reduce((n, e) => n + e.addresses.length, 0)
}

function password(key: string): string {
  const b64 = kubectl(['-n', NS, 'get', 'secret', usersSecret(), '-o', `jsonpath={.data.${key}}`])
  return Buffer.from(b64, 'base64').toString('utf8')
}

// One valkey-cli command as a user (the password on stdin), or as nobody (user null); its whole answer.
function asUser(user: string | null, pw: string, cmd: string[]): string {
  const quoted = cmd.map((c) => `'${c.replace(/'/g, "'\\''")}'`).join(' ')
  const script = user === null
    ? `env -u REDISCLI_AUTH redis-cli --no-auth-warning ${quoted} 2>&1`
    : `read -r p; REDISCLI_AUTH="$p" redis-cli --no-auth-warning --user ${user} ${quoted} 2>&1`
  const r = kubectlOk(['-n', NS, 'exec', '-i', `deploy/${REDIS}`, '-c', 'redis', '--', 'sh', '-c', script], { input: `${pw}\n`, timeout: 20_000 })
  return r.out.trim()
}

// The Helm release list is a read k8s-service keeps in Redis (30 s, internal/helm/releases.go); the screen reads of F-8's
// probe come from its informers, the cluster or auth-service and write no key there.
const HELM_LIST = `/api/v1/helm/releases?cluster=${CLUSTER}`
const HELM_KEYS = 'kubeast:cache:helm|releases|'

// A read of the Helm release list, then its key in Redis within 20 s; each try reads the list again, which a miss writes.
async function helmListKeyInRedis(request: APIRequestContext, headers: Record<string, string>, pw: string, when: string) {
  const res = await request.get(HELM_LIST, { headers, failOnStatusCode: false })
  expect(res.status(), `the Helm release list ${when}`).toBe(200)
  await expect.poll(async () => {
    await request.get(HELM_LIST, { headers, failOnStatusCode: false })
    return asUser('k8s-service', pw, ['--scan', '--pattern', `${HELM_KEYS}*`]).split('\n').filter((l) => l.startsWith(HELM_KEYS)).length
  }, { message: `${HELM_KEYS} keys in Redis ${when}`, timeout: 20_000 }).toBeGreaterThan(0)
}

// An answer as one word: the refusal's code, or ok.
const kind = (whole: string) => kindOf(whole.split('\n')[0].trim().replace(/^\(error\) /, ''))
const kindOf = (answer: string) => /^NOPERM/.test(answer) ? 'NOPERM' : /^NOAUTH/.test(answer) ? 'NOAUTH' : /^WRONGPASS/.test(answer) ? 'WRONGPASS' : /^(ERR|WRONGTYPE)/.test(answer) ? `error: ${answer}` : 'ok'

async function mcpOn(request: APIRequestContext, token: string) {
  const res = await request.get('/api/v1/ai/mcp/config', { headers: bearer(token), failOnStatusCode: false })
  return res.ok() && !!(await res.json()).enabled
}

async function nodesByTool(request: APIRequestContext, token: string, cluster: string): Promise<string> {
  const res = await request.post('/api/v1/ai/mcp', {
    headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'k8s_get_resources', arguments: { cluster, resource_type: 'nodes', output: 'jsonpath={.items[*].metadata.name}' } } },
    failOnStatusCode: false, timeout: 20_000,
  })
  if (!res.ok()) return `http ${res.status()}`
  const result = (await res.json()).result
  return result?.isError ? `error ${result?.content?.[0]?.text ?? ''}` : String(result?.content?.[0]?.text ?? '')
}

test.afterEach(() => undoPending())

test.describe('Redis users per service (PR #866)', () => {
  test.describe.configure({ mode: 'serial' })

  test('each Redis user is refused what it does not send: the default user is off, probe only PINGs, tool-server only subscribes, k8s-service keeps to kubeast:*', () => {
    test.skip(!deploymentExists(REDIS), 'the install runs no Redis (redis.enabled false)')
    test.skip(!aclOn(), 'the chart\'s Redis runs one password (redis.acl.enabled false, or secrets.existingSecret without redis.acl.existingSecretHasKeys)')
    const k8s = password('REDIS_K8S_SERVICE_PASSWORD')
    const probe = password('REDIS_PROBE_PASSWORD')
    const key = `kubeast:cache:e2e-w6-${STAMP}`
    const got: Record<string, string> = {}
    const ask = (label: string, user: string | null, pw: string, cmd: string[]) => { got[label] = kind(asUser(user, pw, cmd)) }

    ask('default PING', null, '', ['PING'])
    ask('probe PING', 'probe', probe, ['PING'])
    ask('probe GET', 'probe', probe, ['GET', key])
    ask('k8s-service SET kubeast:cache:', 'k8s-service', k8s, ['SET', key, 'v', 'EX', '30'])
    ask('k8s-service GET kubeast:cache:', 'k8s-service', k8s, ['GET', key])
    ask('k8s-service PUBLISH kubeast:clusters:changed:', 'k8s-service', k8s, ['PUBLISH', 'kubeast:clusters:changed:e2e', 'x'])
    ask('k8s-service GET outside kubeast:', 'k8s-service', k8s, ['GET', `e2e-w6-${STAMP}`])
    ask('k8s-service PUBLISH outside kubeast:', 'k8s-service', k8s, ['PUBLISH', `e2e-w6-${STAMP}`, 'x'])
    for (const cmd of [['FLUSHALL'], ['FLUSHDB'], ['KEYS', '*'], ['CONFIG', 'GET', 'maxmemory'], ['EVAL', 'return 1', '0'], ['HSET', `kubeast:e2e-${STAMP}`, 'f', 'v'], ['ACL', 'WHOAMI']]) {
      ask(`k8s-service ${cmd[0]}`, 'k8s-service', k8s, cmd)
    }
    const expected: Record<string, string> = {
      'default PING': 'NOAUTH',
      'probe PING': 'ok',
      'probe GET': 'NOPERM',
      'k8s-service SET kubeast:cache:': 'ok',
      'k8s-service GET kubeast:cache:': 'ok',
      'k8s-service PUBLISH kubeast:clusters:changed:': 'ok',
      'k8s-service GET outside kubeast:': 'NOPERM',
      'k8s-service PUBLISH outside kubeast:': 'NOPERM',
      'k8s-service FLUSHALL': 'NOPERM', 'k8s-service FLUSHDB': 'NOPERM', 'k8s-service KEYS': 'NOPERM', 'k8s-service CONFIG': 'NOPERM',
      'k8s-service EVAL': 'NOPERM', 'k8s-service HSET': 'NOPERM', 'k8s-service ACL': 'NOPERM',
    }
    if (deploymentExists('tool-server')) {
      const tool = password('REDIS_TOOL_SERVER_PASSWORD')
      ask('tool-server PING', 'tool-server', tool, ['PING'])
      for (const cmd of [['GET', key], ['SET', key, 'v'], ['FLUSHDB'], ['PUBLISH', 'kubeast:clusters:changed:0', 'x'], ['KEYS', '*'], ['SCAN', '0']]) {
        ask(`tool-server ${cmd[0]}`, 'tool-server', tool, cmd)
        expected[`tool-server ${cmd[0]}`] = 'NOPERM'
      }
      expected['tool-server PING'] = 'ok'
    }
    expect(got).toEqual(expected)
  })

  for (const redisDown of [false, true]) {
    test(`tool-server reads a changed cluster within 10 s on every replica${redisDown ? ', Redis stopped (the 10 s keep alone)' : ' (the change notice)'}`, async ({ request }) => {
      test.setTimeout(300_000)
      const token = await login(request)
      test.skip(!deploymentExists('tool-server'), 'the install runs no tool-server (ai.enabled false)')
      test.skip(!(await mcpOn(request, token)), 'mcp.enabled is off: the tool is called over MCP')
      test.skip(redisDown && !deploymentExists(REDIS), 'the install runs no Redis')
      const oldKc = internalKubeconfig(OLD_KIND)
      const newKc = internalKubeconfig(NEW_KIND)
      test.skip(!oldKc || !newKc, `needs the kind clusters ${OLD_KIND} and ${NEW_KIND}`)
      const admin = bearer(token)
      const reg = await request.post('/api/v1/clusters', { headers: admin, data: { mode: 'external', display_name: `e2e-w6-tool-${STAMP}-${redisDown ? 'r' : 'n'}`, kubeconfig: oldKc }, timeout: 60_000 })
      expect(reg.status(), await reg.text()).toBe(201)
      const id = (await reg.json()).id as string
      const replicas = readyPods('tool-server').length
      const seen: { at: number; text: string }[] = []
      let patchedAt = 0
      let outage: { offAt: number; onAt: number } | null = null
      let redisAtPatch: { pods: number; endpoints: number } | null = null
      try {
        // every tool-server replica keeps the first kubeconfig: as many calls as replicas and more, through the Service
        for (let i = 0; i < replicas * 4; i++) expect(await nodesByTool(request, token, id), 'the tool reads the first cluster').toContain(`${OLD_KIND}-`)
        const follow = async () => {
          // what could answer as Redis right before the change: its pods (terminating ones too) and ready endpoints
          if (redisDown) redisAtPatch = { pods: podsOf(REDIS).length, endpoints: readyEndpoints(REDIS) }
          const patch = await request.patch(`/api/v1/clusters/${id}`, { headers: admin, data: { kubeconfig: newKc }, timeout: 60_000 })
          patchedAt = Date.now()
          expect(patch.status(), await patch.text()).toBe(200)
          while (Date.now() - patchedAt < 15_000) {
            seen.push({ at: Date.now() - patchedAt, text: await nodesByTool(request, token, id) })
            await sleep(200)
          }
        }
        // with Redis stopped the change is made only once every Redis pod is gone (a terminating one still answers)
        if (redisDown) outage = await stopFor(REDIS, 0, async () => { await sleep(3_000); await follow() })
        else await follow()
      } finally {
        await request.delete(`/api/v1/clusters/${id}`, { headers: admin, failOnStatusCode: false })
      }
      test.info().attach('tool-answers.json', { body: JSON.stringify(seen), contentType: 'application/json' })
      if (outage) test.info().attach('timeline.json', { body: JSON.stringify({ redisGone: new Date(outage.offAt).toISOString(), patched: new Date(patchedAt).toISOString(), redisBack: new Date(outage.onAt).toISOString(), redisAtPatch }, null, 2), contentType: 'application/json' })
      if (redisDown) expect(redisAtPatch, 'Redis pods and ready endpoints right before the change').toEqual({ pods: 0, endpoints: 0 })
      const late = seen.filter((s) => s.at > 10_000 && !s.text.includes(`${NEW_KIND}-`))
      expect(seen.filter((s) => s.at > 10_000).length, 'calls after the first 10 s').toBeGreaterThan(replicas * 4)
      expect(late.map((s) => `+${s.at}ms ${s.text.slice(0, 80)}`), `answers not from ${NEW_KIND} later than 10 s after the change`).toEqual([])
    })
  }

  test('F-8: Redis off for 60 s, then on — screen reads answer 200 throughout, no server restarts, the cache is in Redis again', async ({ request }) => {
    test.skip(!deploymentExists(REDIS), 'the install runs no Redis (redis.enabled false)')
    test.setTimeout(300_000)
    const token = await login(request)
    const headers = bearer(token)
    // the read the end checks writes its key before the outage too, so a key missing after it is the outage's
    const acl = aclOn()
    const k8s = acl ? password('REDIS_K8S_SERVICE_PASSWORD') : ''
    if (acl) await helmListKeyInRedis(request, headers, k8s, 'before Redis is stopped')
    const reads = [
      `/api/v1/cluster/pods/page?cluster=${CLUSTER}&namespace=${NS}&limit=5`,
      `/api/v1/cluster/overview?cluster=${CLUSTER}`,
      `/api/v1/cluster/nodes?cluster=${CLUSTER}`,
      `/api/v1/cluster/namespaces/${NS}/configmaps?cluster=${CLUSTER}`,
      '/api/v1/clusters',
    ]
    const before = restartCounts()
    const probe = new Probe(request, reads, headers, 100, 10_000)
    let answers: Answer[] = []
    let outage: { offAt: number; onAt: number } | null = null
    try {
      await sleep(5_000)
      // 60 s from the moment the last Redis pod is gone
      outage = await stopFor(REDIS, 60)
      await sleep(20_000)
    } finally {
      answers = await probe.stop()
    }
    test.info().attach('reads.json', { body: JSON.stringify(answers), contentType: 'application/json' })
    test.info().attach('timeline.json', { body: JSON.stringify({ redisGone: new Date(outage.offAt).toISOString(), redisBack: new Date(outage.onAt).toISOString(), offMs: outage.onAt - outage.offAt }, null, 2), contentType: 'application/json' })
    const bad = answers.filter((a) => a.status !== 200)
    expect(answers.length, 'the probe kept sending').toBeGreaterThan(500)
    expect(bad.length, `screen reads not answered 200 while Redis was off or coming back:\n${show(bad)}`).toBe(0)
    expect(restartsSince(before), 'restarts of the pods that stayed (Redis itself is replaced)').toEqual({})
    // the cache is written to Redis again (k8s-service's user may SCAN kubeast:*)
    if (!acl) {
      test.info().annotations.push({ type: 'not checked', description: 'Redis keys after the outage: no Redis users to read them with (redis.acl off)' })
      return
    }
    await helmListKeyInRedis(request, headers, k8s, 'after Redis is back')
  })

  test('F-8 (PR #857): a k8s-service started while Redis was down moves its cache to Redis within 15 s of Redis answering', async ({ request }) => {
    test.skip(!deploymentExists(REDIS), 'the install runs no Redis (redis.enabled false)')
    test.setTimeout(420_000)
    const token = await login(request)
    const headers = bearer(token)
    const probe = new Probe(request, [`/api/v1/cluster/overview?cluster=${CLUSTER}`, '/api/v1/clusters'], headers, 200, 10_000)
    let started: string[] = []
    let backAt = 0
    let answers: Answer[] = []
    let down: Awaited<ReturnType<typeof takeDown>> | null = null
    try {
      // k8s-service restarts only once every Redis pod is gone: a terminating one still answers through its preStop
      down = await takeDown(REDIS)
      const old = new Set(readyPods(K8S).map((p) => p.name))
      kubectl(['-n', NS, 'rollout', 'restart', `deploy/${K8S}`])
      rolledOut(K8S, 240)
      started = readyPods(K8S).map((p) => p.name).filter((n) => !old.has(n))
      const since = new Date(Date.now() - 300_000).toISOString()
      for (const pod of started) expect(podLog(pod, since), `${pod} started on the in-memory cache`).toContain('redis not available, using in-memory cache until it answers')
    } finally {
      backAt = down ? down.bringBack() : Date.now()
      answers = await probe.stop()
    }
    test.info().attach('reads.json', { body: JSON.stringify(answers), contentType: 'application/json' })
    test.info().attach('timeline.json', { body: JSON.stringify({ redisGone: down ? new Date(down.offAt).toISOString() : null, redisBack: new Date(backAt).toISOString(), started }, null, 2), contentType: 'application/json' })
    expect(started.length, 'new k8s-service pods').toBeGreaterThan(0)
    const since = new Date(backAt - 5_000).toISOString()
    for (const pod of started) {
      await expect.poll(() => podLog(pod, since).includes('redis answered, the cache moves there from memory'), { message: `${pod} moves its cache to Redis`, timeout: 15_000 }).toBe(true)
    }
    const bad = answers.filter((a) => a.status !== 200)
    expect(bad.length, `reads not answered 200 while k8s-service restarted without Redis:\n${show(bad)}`).toBe(0)
  })
})
