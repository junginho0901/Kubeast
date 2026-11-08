import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// A name on the dev allow list that resolves to a cloud metadata address (deploy/kind/devtools.yaml, no pod behind it).
// The list spares it the check when a config is saved, so only the check when a connection opens can refuse it.
export const STAND_IN_HOST = 'model-metadata-standin.kubeast-devtools.svc.cluster.local'
export const STAND_IN = `http://${STAND_IN_HOST}:8090`
export const STAND_IN_ADDRESS = '168.63.129.16'
export const STAND_IN_SKIP = `the name is not set up: apply deploy/kind/devtools.yaml and upgrade with ${STAND_IN_HOST} in ai.baseUrlAllowedHosts (deploy/kind/values.yaml)`

export function hasStandIn(): boolean {
  try {
    const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-model-address-')), 'kubeconfig')
    fs.writeFileSync(kcPath, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
    const values = execSync(`helm --kubeconfig ${kcPath} -n kubeast get values kubeast -o json`, { encoding: 'utf8' })
    if (!JSON.stringify(JSON.parse(values).ai?.baseUrlAllowedHosts ?? []).includes(STAND_IN_HOST)) return false
    const slice = execSync(`kubectl --kubeconfig ${kcPath} -n kubeast-devtools get endpointslice model-metadata-standin -o name`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return slice.includes('model-metadata-standin')
  } catch {
    return false
  }
}
