// Storage API — PVCs / PVs / StorageClasses / VolumeAttachments.
// Topology of storage (PV → PVC → Pod) lives in topology.ts.

import { client } from './client'
import type {
  PVCInfo,
  PVInfo,
  StorageClassInfo,
  VolumeAttachmentInfo,
} from './types'

export const storageApi = {
  // PVCs
  // usage = true adds each claim's kubelet usage from Prometheus (PVCInfo.usage).
  getPVCs: async (namespace?: string, forceRefresh: boolean = false, usage: boolean = false): Promise<PVCInfo[]> => {
    const { data } = await client.get('/cluster/pvcs', {
      params: { namespace, force_refresh: forceRefresh, usage: usage || undefined },
    })
    return data
  },

  describePVC: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/pvcs/${name}/describe`)
    return data
  },

  deletePVC: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/pvcs/${name}`)
  },

  // PVs
  getPVs: async (): Promise<PVInfo[]> => {
    const { data } = await client.get('/cluster/pvs')
    return data
  },

  getPV: async (name: string): Promise<PVInfo> => {
    const { data } = await client.get(`/cluster/pvs/${name}`)
    return data
  },

  describePV: async (name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/pvs/${name}/describe`)
    return data
  },

  deletePV: async (name: string): Promise<void> => {
    await client.delete(`/cluster/pvs/${name}`)
  },

  // StorageClasses
  getStorageClasses: async (forceRefresh = false): Promise<StorageClassInfo[]> => {
    const { data } = await client.get('/cluster/storageclasses', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getStorageClass: async (name: string): Promise<StorageClassInfo> => {
    const { data } = await client.get(`/cluster/storageclasses/${name}`)
    return data
  },

  describeStorageClass: async (name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/storageclasses/${name}/describe`)
    return data
  },

  deleteStorageClass: async (name: string): Promise<void> => {
    await client.delete(`/cluster/storageclasses/${name}`)
  },

  // VolumeAttachments
  getVolumeAttachments: async (forceRefresh = false): Promise<VolumeAttachmentInfo[]> => {
    const { data } = await client.get('/cluster/volumeattachments', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeVolumeAttachment: async (name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/volumeattachments/${name}/describe`)
    return data
  },

  deleteVolumeAttachment: async (name: string): Promise<void> => {
    await client.delete(`/cluster/volumeattachments/${name}`)
  },
}
