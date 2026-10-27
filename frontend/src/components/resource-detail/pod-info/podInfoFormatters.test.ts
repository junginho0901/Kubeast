import { describe, expect, it } from 'vitest'
import { getVolumeDetail } from './podInfoFormatters'

describe('getVolumeDetail', () => {
  it('reads the volumes of k8s-service describe', () => {
    expect(getVolumeDetail({ name: 'spool', type: 'EmptyDir' })).toEqual({ type: 'EmptyDir', detail: '-' })
    expect(getVolumeDetail({ name: 'ca', type: 'Projected' })).toEqual({ type: 'Projected', detail: '-' })
    expect(getVolumeDetail({ name: 'conf', type: 'ConfigMap', config_map: 'app-conf' })).toEqual({ type: 'ConfigMap', detail: 'app-conf' })
    expect(getVolumeDetail({ name: 'keys', type: 'Secret', secret: 'app-keys' })).toEqual({ type: 'Secret', detail: 'app-keys' })
    expect(getVolumeDetail({ name: 'data', type: 'PersistentVolumeClaim', pvc: 'data-0' })).toEqual({ type: 'PersistentVolumeClaim', detail: 'data-0' })
    expect(getVolumeDetail({ name: 'logs', type: 'HostPath', path: '/var/log' })).toEqual({ type: 'HostPath', detail: '/var/log' })
  })

  it('reads a volume of the Pod spec', () => {
    expect(getVolumeDetail({ name: 'conf', configMap: { name: 'app-conf' } })).toEqual({ type: 'ConfigMap', detail: 'app-conf' })
    expect(getVolumeDetail({ name: 'logs', hostPath: { path: '/var/log', type: 'Directory' } })).toEqual({ type: 'HostPath', detail: '/var/log (Directory)' })
    expect(getVolumeDetail({ name: 'token', projected: { sources: [{ serviceAccountToken: {} }, { configMap: {} }] } })).toEqual({ type: 'Projected', detail: 'serviceAccountToken; configMap' })
  })
})
