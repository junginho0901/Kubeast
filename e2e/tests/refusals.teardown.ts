import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test as teardown, expect } from '@playwright/test'

import { REFUSAL_LINES, refusals, serverLogs } from './cluster-refusals'

// Runs once every project that depends on setup has finished (the setup project's teardown): no line of
// REFUSAL_LINES in the logs of SERVERS since the run started (E2E_RUN_STARTED, playwright.config.ts), each pod there at
// the end and a restarted container's run before too; the install's logs, not this run's alone. A screen read refused
// for want of a person is a blank on screen, which no spec sees.

const KUBEAST_NS = 'kubeast'

function kubeastKubectl(): ((args: string[]) => string) | null {
  try {
    const kc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-refusals-')), 'kubeconfig')
    fs.writeFileSync(kc, execFileSync('kind', ['get', 'kubeconfig', '--name', 'kubeast'], { encoding: 'utf8' }), { mode: 0o600 })
    // a run's logs can pass 1 MiB, execFileSync's default buffer
    return (args) => execFileSync('kubectl', ['--kubeconfig', kc, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, timeout: 120_000 })
  } catch {
    return null
  }
}

teardown('no cluster request or kubectl run refused for want of a person during the run', async () => {
  const since = process.env.E2E_RUN_STARTED ?? ''
  expect(Number.isNaN(Date.parse(since)), `E2E_RUN_STARTED (${since || 'unset'}) is a time`).toBe(false)
  const kubectl = kubeastKubectl()
  teardown.skip(!kubectl, 'no kind cluster kubeast')
  const logs = serverLogs(kubectl!, KUBEAST_NS, since)
  expect(logs.some((l) => l.source.startsWith('k8s-service-')), `a k8s-service container read (${logs.map((l) => l.source).join(', ') || 'none'})`).toBe(true)
  const found = refusals(logs)
  expect(found.slice(0, 20), `${found.length} line(s) of "${REFUSAL_LINES.join('" or "')}" since ${since} in ${logs.map((l) => l.source).join(', ')}`).toEqual([])
  const unreadable = logs.filter((l) => l.unreadable !== undefined).map((l) => `${l.source}: ${l.unreadable}`)
  expect(unreadable, 'previous run not readable, so its lines were not counted').toEqual([])
})
