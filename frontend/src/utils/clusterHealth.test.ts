import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { healthDotClass } from './clusterHealth'

// The registry stores "unreachable" when a cluster's Test fails (auth-service TestCluster): its dot is the red the
// row's word "Unreachable" means, in the picker and on the admin page.
describe('healthDotClass', () => {
  it('draws every word for a cluster that does not answer in red', () => {
    for (const status of ['unreachable', 'unhealthy', 'disconnected']) expect(healthDotClass(status), status).toBe('bg-red-500')
  })

  it('keeps green for a healthy cluster and grey for one not checked', () => {
    expect(healthDotClass('healthy')).toBe('bg-green-500')
    expect(healthDotClass('unknown')).toBe('bg-slate-500')
    expect(healthDotClass(undefined)).toBe('bg-slate-500')
  })

  it('is the one rule of the picker and the admin page', () => {
    for (const file of ['../components/ClusterPicker.tsx', '../pages/admin/Clusters.tsx']) {
      const src = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')
      expect(src, file).not.toContain('function healthDotClass')
      expect(src, file).toContain("from '@/utils/clusterHealth'")
    }
  })
})
