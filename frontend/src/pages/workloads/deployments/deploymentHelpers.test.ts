import { describe, expect, it } from 'vitest'

import { classifyDeploymentStatus, getDeploymentStatusColor } from './deploymentHelpers'

// A Deployment that wants replicas and has none available counts as Unavailable and is drawn red: its Progressing
// condition stays True for progressDeadlineSeconds, so 0 of 2 ready counted Degraded for 10 minutes (number check
// 10-31). The status text from the server stays as Kubernetes' condition says.
describe('Deployment status buckets', () => {
  it('none available is Unavailable whatever the status text', () => {
    expect(classifyDeploymentStatus('Progressing', { replicas: 2, available_replicas: 0 })).toBe('unavailable')
    expect(getDeploymentStatusColor('Progressing', { replicas: 2, available_replicas: 0 })).toBe('badge-error')
  })

  it('some available follows the status text', () => {
    expect(classifyDeploymentStatus('Progressing', { replicas: 3, available_replicas: 1 })).toBe('degraded')
    expect(classifyDeploymentStatus('Available', { replicas: 3, available_replicas: 3 })).toBe('healthy')
    expect(classifyDeploymentStatus('Failed', { replicas: 3, available_replicas: 2 })).toBe('unavailable')
  })

  it('a Deployment scaled to zero is not Unavailable', () => {
    expect(classifyDeploymentStatus('Available', { replicas: 0, available_replicas: 0 })).toBe('healthy')
  })

  it('without counts, the text alone decides (as before)', () => {
    expect(classifyDeploymentStatus('Progressing')).toBe('degraded')
  })
})
