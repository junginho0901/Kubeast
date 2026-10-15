import { test, expect } from '@playwright/test'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The alert investigator acts in a cluster as user and group kubeast:investigator
// (templates/impersonation-investigator.yaml, features.alertInvestigation on in the dev values): it reads what an
// investigation needs and nothing more. Asked of both dev clusters as real requests — the second one gets the render
// from scripts/add-kind-cluster.sh --addons, the first one from the chart.

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-investigator-'))
  const kcPath = path.join(dir, 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  const run = (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  // As the investigator; resolves to 'allowed' or the API server's refusal.
  const as = (args: string): string => {
    try {
      run(`--as=kubeast:investigator --as-group=kubeast:investigator ${args}`)
      return 'allowed'
    } catch (e) {
      const err = String((e as { stderr?: string }).stderr || e)
      return /forbidden/i.test(err) ? 'forbidden' : `error: ${err.slice(0, 200)}`
    }
  }
  return { as, run, dir }
}

for (const kindName of ['kubeast-b', 'kubeast']) {
  test(`${kindName}: the investigator reads pods, logs, events, nodes and workloads, and nothing else`, () => {
    const { as, run } = kubectlFor(kindName)
    const pod = run('-n kube-system get pod -l k8s-app=kube-dns -o jsonpath={.items[0].metadata.name}').trim()
    expect(pod).not.toBe('')

    expect(as('get pods -A -o name')).toBe('allowed')
    expect(as(`-n kube-system logs ${pod} --tail=1`)).toBe('allowed')
    expect(as('get events -A -o name')).toBe('allowed')
    expect(as('get nodes -o name')).toBe('allowed')
    expect(as('get deployments,statefulsets,daemonsets -A -o name')).toBe('allowed')

    expect(as('get secrets -A -o name')).toBe('forbidden')
    expect(as(`-n kube-system exec ${pod} -- true`)).toBe('forbidden')
    expect(as(`-n kube-system delete pod ${pod} --dry-run=server`)).toBe('forbidden')
    expect(as('-n kube-system scale deploy/coredns --replicas=2 --dry-run=server')).toBe('forbidden')
    expect(as('get --raw /api/v1/namespaces/kube-system/services/kube-dns:53/proxy/')).toBe('forbidden')
  })
}

// features.alertInvestigation.extraRules in the dev values add Kyverno PolicyReports (read only); the second cluster
// has Kyverno, the first only the rule.
test('the investigator reads PolicyReports where the dev values add them, and still cannot write them', () => {
  const b = kubectlFor('kubeast-b')
  expect(b.as('get policyreports.wgpolicyk8s.io -A -o name')).toBe('allowed')
  expect(b.as('get clusterpolicyreports.wgpolicyk8s.io -o name')).toBe('allowed')
  // a real report by name: `delete --all` on an empty namespace would delete nothing and pass
  const [ns, name] = b.run('get policyreports.wgpolicyk8s.io -A -o jsonpath={.items[0].metadata.namespace}/{.items[0].metadata.name}').trim().split('/')
  expect(name).toBeTruthy()
  expect(b.as(`-n ${ns} delete policyreports.wgpolicyk8s.io ${name} --dry-run=server`)).toBe('forbidden')
  expect(b.as('get clusterpolicies.kyverno.io -o name')).toBe('forbidden')
  // the first cluster has no PolicyReport CRD, so `auth can-i` cannot resolve the type: ask the API server for the
  // RBAC decision itself
  const a = kubectlFor('kubeast')
  const review = (verb: string) => {
    const file = path.join(a.dir, `review-${verb}.yaml`)
    fs.writeFileSync(file, `apiVersion: authorization.k8s.io/v1\nkind: SelfSubjectAccessReview\nspec:\n  resourceAttributes:\n    group: wgpolicyk8s.io\n    resource: policyreports\n    verb: ${verb}\n`)
    return a.run(`--as=kubeast:investigator --as-group=kubeast:investigator create -f ${file} -o jsonpath={.status.allowed}`).trim()
  }
  expect(review('list')).toBe('true')
  expect(review('create')).toBe('false')
})

test('kubeast-b: the investigator may GET the listed Prometheus through the proxy, like the Read group', () => {
  const { as } = kubectlFor('kubeast-b')
  expect(as('get --raw /api/v1/namespaces/monitoring/services/prometheus:9090/proxy/-/healthy')).toBe('allowed')
  expect(as('create --raw /api/v1/namespaces/monitoring/services/prometheus:9090/proxy/api/v1/admin/tsdb/snapshot -f /dev/null')).toBe('forbidden')
})
