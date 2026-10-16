import { useEffect, useState, useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ModelConfigResponse } from '@/services/api'
import { PROVIDER_CATALOG, getProvider, type ProviderDef } from '@/constants/modelCatalog'
import { modelOptions } from './helpers'

export function useModelForm() {
  const qc = useQueryClient()

  const [editingId, setEditingId] = useState<number | null>(null)
  const [isCreating, setIsCreating] = useState(false)

  const [formName, setFormName] = useState('')
  const [formProvider, setFormProvider] = useState('openai')
  const [formModel, setFormModel] = useState('')
  const [formCustomModel, setFormCustomModel] = useState(false)
  const [formBaseUrl, setFormBaseUrl] = useState('')
  // Name of the ai-service env var that holds the provider key (keys are never stored)
  const [formApiKeyEnv, setFormApiKeyEnv] = useState(PROVIDER_CATALOG[0].defaultApiKeyEnv)
  const [formEnabled, setFormEnabled] = useState(true)
  const [formIsDefault, setFormIsDefault] = useState(false)
  const [formTier, setFormTier] = useState<'default' | 'economy'>('default')
  // 로컬/셀프호스트 모델용 고급 설정
  const [formCaCert, setFormCaCert] = useState('')          // 자체 서명 CA (PEM)
  const [formOptions, setFormOptions] = useState('')        // 생성 옵션 (JSON 문자열)
  const [formOptionsError, setFormOptionsError] = useState<string | null>(null)

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)

  const [rolloutStatus, setRolloutStatus] = useState<'idle' | 'rolling' | 'done' | 'error'>('idle')
  const [rolloutMessage, setRolloutMessage] = useState('')

  const { data: configs, isLoading } = useQuery({
    queryKey: ['model-configs'],
    queryFn: () => api.listModelConfigs(),
  })

  const invalidateModelQueries = () => {
    qc.invalidateQueries({ queryKey: ['model-configs'] })
    qc.invalidateQueries({ queryKey: ['ai-config'] })
  }

  const createMutation = useMutation({
    mutationFn: (data: any) => api.createModelConfig(data),
    onSuccess: () => {
      invalidateModelQueries()
      resetForm()
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) => api.updateModelConfig(id, data),
    onSuccess: () => {
      invalidateModelQueries()
      resetForm()
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteModelConfig(id),
    onSuccess: invalidateModelQueries,
  })

  const activateMutation = useMutation({
    mutationFn: (id: number) => api.updateModelConfig(id, { is_default: true }),
    onSuccess: invalidateModelQueries,
  })

  const currentProviderDef: ProviderDef = getProvider(formProvider) ?? PROVIDER_CATALOG[0]
  // The provider's own model list for the open form; the built-in list when it cannot be had.
  const [listBaseUrl, setListBaseUrl] = useState(formBaseUrl)
  const [listCaCert, setListCaCert] = useState(formCaCert.trim())
  useEffect(() => {
    const id = setTimeout(() => {
      setListBaseUrl(formBaseUrl)
      setListCaCert(formCaCert.trim())
    }, 500)
    return () => clearTimeout(id)
  }, [formBaseUrl, formCaCert])
  const formOpen = isCreating || editingId != null
  const providerModels = useQuery({
    queryKey: ['provider-models', formProvider, listBaseUrl, formApiKeyEnv, listCaCert],
    queryFn: () => api.listProviderModels({ provider: formProvider, base_url: listBaseUrl || undefined, api_key_env: formApiKeyEnv || undefined, ca_cert: listCaCert || undefined }),
    enabled: formOpen && formProvider !== 'custom',
    staleTime: 5 * 60_000,
    retry: false,
  })
  const fetchedModels = providerModels.data?.models
  const currentModelOptions = useMemo(() => modelOptions(currentProviderDef, fetchedModels), [currentProviderDef, fetchedModels])
  // A new config starts on the provider's first listed model when the built-in default is not one of them;
  // an edited config keeps its stored model.
  useEffect(() => {
    if (isCreating && !formCustomModel && fetchedModels?.length && !fetchedModels.some((m) => m.name === formModel)) {
      setFormModel(fetchedModels[0].name)
    }
  }, [isCreating, formCustomModel, fetchedModels, formModel])
  const modelList = {
    loading: providerModels.isFetching,
    fromProvider: Boolean(fetchedModels?.length),
    count: fetchedModels?.length ?? 0,
    error: providerModels.data?.error ?? (providerModels.error ? String(providerModels.error) : undefined),
  }

  const resetForm = () => {
    setEditingId(null)
    setIsCreating(false)
    setFormName('')
    setFormProvider('openai')
    setFormModel('')
    setFormCustomModel(false)
    setFormBaseUrl('')
    setFormApiKeyEnv(PROVIDER_CATALOG[0].defaultApiKeyEnv)
    setFormEnabled(true)
    setFormIsDefault(false)
    setFormTier('default')
    setFormCaCert('')
    setFormOptions('')
    setFormOptionsError(null)
    setTestResult(null)
    setRolloutStatus('idle')
    setRolloutMessage('')
  }

  const openEditForm = (cfg: ModelConfigResponse) => {
    const provDef = getProvider(cfg.provider)
    const isKnown = provDef?.models.some((m) => m.name === cfg.model) ?? false
    setIsCreating(false)
    setEditingId(cfg.id)
    setFormName(cfg.name)
    setFormProvider(cfg.provider)
    setFormModel(cfg.model)
    setFormCustomModel(!isKnown)
    setFormBaseUrl(cfg.base_url || '')
    setFormApiKeyEnv(cfg.api_key_env || provDef?.defaultApiKeyEnv || '')
    setFormEnabled(cfg.enabled)
    setFormIsDefault(cfg.is_default)
    setFormTier(cfg.tier === 'economy' ? 'economy' : 'default')
    setFormCaCert(cfg.ca_cert || '')
    setFormOptions(cfg.options ? JSON.stringify(cfg.options, null, 2) : '')
    setFormOptionsError(null)
    setTestResult(null)
    setRolloutStatus('idle')
    setRolloutMessage('')
  }

  const openCreateForm = () => {
    resetForm()
    setIsCreating(true)
  }

  const handleProviderChange = (newProvider: string) => {
    setFormProvider(newProvider)
    const prov = getProvider(newProvider)
    if (prov) {
      setFormModel(prov.models[0]?.name ?? '')
      setFormCustomModel(false)
      setFormBaseUrl(prov.defaultBaseUrl ?? '')
      setFormApiKeyEnv(prov.defaultApiKeyEnv ?? '')
      setTestResult(null)
    }
  }

  const handleSubmit = () => {
    const payload: Record<string, any> = {
      name: formName,
      provider: formProvider,
      model: formModel,
      base_url: formBaseUrl || undefined,
      enabled: formEnabled,
      is_default: formIsDefault,
      tier: formTier,
    }
    if (currentProviderDef.needsApiKey !== false) {
      payload.api_key_env = formApiKeyEnv.trim() || null
    }
    // 자체 서명 CA (PEM)
    if (formCaCert.trim()) {
      payload.ca_cert = formCaCert.trim()
    } else if (editingId) {
      payload.ca_cert = null  // 편집 중 비우면 제거
    }
    // 생성 옵션(JSON) — 파싱 검증
    const optsRaw = formOptions.trim()
    if (optsRaw) {
      try {
        const parsed = JSON.parse(optsRaw)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          setFormOptionsError('Options must be a JSON object, e.g. {"temperature": 0.7}')
          return
        }
        payload.options = parsed
        setFormOptionsError(null)
      } catch {
        setFormOptionsError('Invalid JSON')
        return
      }
    } else if (editingId) {
      payload.options = null  // 편집 중 비우면 제거
    }
    if (editingId) {
      updateMutation.mutate({ id: editingId, data: payload })
    } else {
      createMutation.mutate(payload)
    }
  }

  const handleTest = async () => {
    if (!formApiKeyEnv.trim() && currentProviderDef.needsApiKey !== false) {
      setTestResult({ success: false, message: 'Enter the name of the env var that holds the API key' })
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const result = await api.testModelConnection({
        provider: formProvider,
        model: formModel,
        base_url: formBaseUrl || undefined,
        api_key_env: formApiKeyEnv.trim() || undefined,
        ca_cert: formCaCert.trim() || undefined,
      })
      setTestResult(result)
    } catch (e: any) {
      setTestResult({ success: false, message: e?.message || 'Test failed' })
    } finally {
      setTesting(false)
    }
  }

  const handleRollout = async () => {
    setRolloutStatus('rolling')
    setRolloutMessage('Restarting ai-service to pick up new API keys…')
    try {
      const resp = await fetch('/api/v1/cluster/health')
      if (resp.ok) {
        setRolloutStatus('done')
        setRolloutMessage('Service is healthy. New API keys should be available.')
      } else {
        throw new Error('Health check returned non-ok')
      }
    } catch {
      setRolloutStatus('error')
      setRolloutMessage('Rollout may still be in progress. Please wait and refresh.')
    }
  }

  const isSaving = createMutation.isPending || updateMutation.isPending

  return {
    configs,
    isLoading,
    editingId,
    isCreating,
    formName, setFormName,
    formProvider,
    formModel, setFormModel,
    formCustomModel, setFormCustomModel,
    formBaseUrl, setFormBaseUrl,
    formApiKeyEnv, setFormApiKeyEnv,
    formEnabled, setFormEnabled,
    formIsDefault, setFormIsDefault,
    formTier, setFormTier,
    formCaCert, setFormCaCert,
    formOptions, setFormOptions,
    formOptionsError,
    testing,
    testResult,
    rolloutStatus,
    rolloutMessage,
    currentProviderDef,
    currentModelOptions,
    modelList,
    isSaving,
    deleteMutation,
    activateMutation,
    resetForm,
    openEditForm,
    openCreateForm,
    handleProviderChange,
    handleSubmit,
    handleTest,
    handleRollout,
  }
}

export type ModelFormState = ReturnType<typeof useModelForm>
