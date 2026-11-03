// Cost (OpenCost allocation read through k8s-service, features.cost).
import { client } from './client'
import type { CostAggregate, CostResponse, CostStatus, CostWindow } from './types'

export const costApi = {
  getCostStatus: async (): Promise<CostStatus> => {
    const { data } = await client.get('/cluster/cost/status')
    return data
  },

  // refresh: read OpenCost again instead of the server's answer of the last minute (the page's Refresh)
  getCost: async (window: CostWindow, aggregate: CostAggregate, refresh = false): Promise<CostResponse> => {
    const { data } = await client.get('/cluster/cost', { params: { window, aggregate, ...(refresh ? { refresh: '1' } : {}) } })
    return data
  },
}
