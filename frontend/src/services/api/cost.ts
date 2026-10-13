// Cost (OpenCost allocation read through k8s-service, features.cost).
import { client } from './client'
import type { CostAggregate, CostResponse, CostStatus, CostWindow } from './types'

export const costApi = {
  getCostStatus: async (): Promise<CostStatus> => {
    const { data } = await client.get('/cluster/cost/status')
    return data
  },

  getCost: async (window: CostWindow, aggregate: CostAggregate): Promise<CostResponse> => {
    const { data } = await client.get('/cluster/cost', { params: { window, aggregate } })
    return data
  },
}
