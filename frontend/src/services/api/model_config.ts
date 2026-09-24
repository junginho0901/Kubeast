// Model Config API — list / activate / create / update / delete /
// test the LLM provider configurations stored by the
// model-config-controller. Also includes /ai/config which returns
// the runtime-effective model + app metadata.

import { client } from './client'
import type { ModelConfigCreate, ModelConfigResponse } from './types'

export const modelConfigApi = {
  // /ai/config returns the runtime-resolved model + app info — kept
  // here next to model-configs because the UI surfaces them together.
  getAIConfig: async (): Promise<{ model: string; app_name: string; version: string }> => {
    const { data } = await client.get('/ai/config')
    return data
  },

  listModelConfigs: async (enabledOnly = false): Promise<ModelConfigResponse[]> => {
    const { data } = await client.get('/ai/model-configs', { params: { enabled_only: enabledOnly } })
    return data
  },

  getActiveModelConfig: async (): Promise<ModelConfigResponse | null> => {
    const { data } = await client.get('/ai/model-configs/active')
    return data
  },

  createModelConfig: async (payload: ModelConfigCreate): Promise<ModelConfigResponse> => {
    const { data } = await client.post('/ai/model-configs', payload)
    return data
  },

  updateModelConfig: async (id: number, payload: Partial<ModelConfigCreate>): Promise<ModelConfigResponse> => {
    const { data } = await client.patch(`/ai/model-configs/${id}`, payload)
    return data
  },

  deleteModelConfig: async (id: number): Promise<void> => {
    await client.delete(`/ai/model-configs/${id}`)
  },

  testModelConnection: async (payload: {
    provider: string
    model: string
    base_url?: string
    api_key?: string
    tls_verify?: boolean
    azure_api_version?: string
  }): Promise<{ success: boolean; model?: string; message: string }> => {
    const { data } = await client.post('/ai/model-configs/test', payload)
    return data
  },
}
