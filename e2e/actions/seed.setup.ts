// Setup project for the action suite: (re)create the seed objects on the target kind cluster and write
// the kubeconfig the drivers' kubectl calls use. Runs before the "actions" project (dependencies).
import { test as setup, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { KUBECONFIG, SEED_DIR, TARGET_KIND } from './support/env'

setup('seed the target cluster', async ({}, testInfo) => {
  setup.setTimeout(10 * 60_000) // namespace deletion waits for PVC protection; the first run pulls images
  if (process.env.E2E_ACTIONS_SEED === '0') {
    // Re-use the previous seed (iterating on drivers that do not consume seed objects).
    testInfo.annotations.push({ type: 'skipped seed', description: 'E2E_ACTIONS_SEED=0' })
    expect(fs.existsSync(KUBECONFIG), `kubeconfig from an earlier seed at ${KUBECONFIG}`).toBeTruthy()
    return
  }
  const out = execFileSync('bash', [path.join(SEED_DIR, 'seed.sh')], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TARGET_KIND, KUBECONFIG_OUT: KUBECONFIG },
  })
  await testInfo.attach('seed.log', { body: out, contentType: 'text/plain' })
  expect(fs.existsSync(KUBECONFIG), `kubeconfig written to ${KUBECONFIG}`).toBeTruthy()
  expect(out).toContain('qa-pod ready')
})
