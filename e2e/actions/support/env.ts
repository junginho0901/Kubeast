// Target cluster for the action suite + kubectl against it.
//
// Every kubectl call uses the kubeconfig named by E2E_ACTIONS_KUBECONFIG (written by
// seed/seed.sh from `kind get kubeconfig`). The shell's own KUBECONFIG is never used:
// an ambient kubeconfig may point at a real cluster.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** Same default as playwright.config.ts; contexts the drivers open themselves need it explicitly. */
export const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:30080'
export const NS = 'qa-sweep'
export const NS2 = 'qa-sweep-2'
/** Cluster id as registered in Kubeast (the picker option data-testid=cluster-option-<id>). */
export const TARGET_CLUSTER = process.env.E2E_ACTIONS_CLUSTER || 'test2'
/** kind cluster name the seed targets; the Kubeast registration above must point at it. */
export const TARGET_KIND = process.env.E2E_ACTIONS_KIND || 'test2'
/** A second kind cluster, not registered in Kubeast, for the cluster-register driver. */
export const EXTRA_KIND = process.env.E2E_ACTIONS_EXTRA_KIND || 'kubeast-np'

export const SEED_DIR = path.join(__dirname, '..', 'seed')
export const KUBECONFIG = process.env.E2E_ACTIONS_KUBECONFIG || path.join(SEED_DIR, `.kubeconfig-${TARGET_KIND}`)

export function requireKubeconfig(): string {
  if (!fs.existsSync(KUBECONFIG)) {
    throw new Error(`target kubeconfig missing: ${KUBECONFIG} — run with the actions-seed project (seed/seed.sh writes it)`)
  }
  return KUBECONFIG
}

export type KubectlResult = { ok: boolean; out: string }

export function kubectl(args: string[]): KubectlResult {
  try {
    const out = execFileSync('kubectl', args, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, KUBECONFIG: requireKubeconfig() },
    }).trim()
    return { ok: true, out }
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string }
    return { ok: false, out: String(err.stderr || err.message || e).trim() }
  }
}

export const exists = (args: string[]) => kubectl(['-n', NS, 'get', ...args, '-o', 'name']).ok
export const jsonpath = (args: string[], jp: string) => kubectl(['-n', NS, 'get', ...args, '-o', `jsonpath=${jp}`]).out
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Poll a cluster-state predicate (controllers apply rollbacks and deletes asynchronously). */
export async function until(fn: () => boolean, ms = 20000, every = 1000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await sleep(every)
  }
  return fn()
}
