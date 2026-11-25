// Model Config API — list / activate / create / update / delete /
// test the LLM provider configurations stored by the
// model-config-controller. Also includes /ai/config which returns
// the runtime-effective model + app metadata.

import { client } from './client'
import type { ChosenUse, ModelConfigCreate, ModelConfigResponse, ModelUseState } from './types'

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
    api_key_env?: string
    tls_verify?: boolean
    ca_cert?: string
    options?: Record<string, unknown>
  }): Promise<{ success: boolean; model?: string; message: string }> => {
    const { data } = await client.post('/ai/model-configs/test', payload)
    return data
  },

  // The models the provider lists for this key and address; models is empty (with error) when it cannot list them.
  listProviderModels: async (payload: {
    provider: string
    base_url?: string
    api_key_env?: string
    ca_cert?: string
  }): Promise<{ models: { name: string; label?: string }[]; error?: string }> => {
    const { data } = await client.post('/ai/model-configs/models', payload)
    return data
  },

  // Which model answers each use that has none of its own until one is chosen.
  listModelUses: async (): Promise<ModelUseState[]> => {
    const { data } = await client.get('/ai/model-configs/uses')
    return data.uses
  },

  // configId null takes the choice away.
  setModelUse: async (use: ChosenUse, configId: number | null): Promise<ModelUseState[]> => {
    const { data } = await client.put(`/ai/model-configs/uses/${use}`, { config_id: configId })
    return data.uses
  },

  // Providers this install cannot run (the Claude subscription without its image or switch), with the reason.
  providerAvailability: async (): Promise<{ providers: Record<string, { available: boolean; reason?: string | null }> }> => {
    const { data } = await client.get('/ai/model-configs/providers')
    return data
  },
}
