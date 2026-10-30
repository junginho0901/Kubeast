import { useEffect, useState, useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ModelConfigResponse } from '@/services/api'
import { PROVIDER_CATALOG, getProvider, type ProviderDef } from '@/constants/modelCatalog'
import { buildOptions, modelOptions, splitLimits, type LimitsError } from './helpers'

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
  // the model's own limits (options.max_tokens, options.tool_result_chars), for every provider
  const [formMaxTokens, setFormMaxTokens] = useState('')
  const [formToolResultChars, setFormToolResultChars] = useState('')
  const [formLimitsError, setFormLimitsError] = useState<LimitsError | null>(null)

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)


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
    enabled: formOpen && formProvider !== 'custom' && formProvider !== 'claude-code',
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
    noList: formProvider === 'claude-code',  // Claude Code has no model list API
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
    setFormMaxTokens('')
    setFormToolResultChars('')
    setFormLimitsError(null)
    setTestResult(null)
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
    const limits = splitLimits(cfg.options)
    setFormOptions(limits.rest ? JSON.stringify(limits.rest, null, 2) : '')
    setFormOptionsError(null)
    setFormMaxTokens(limits.maxTokens)
    setFormToolResultChars(limits.toolResultChars)
    setFormLimitsError(null)
    setTestResult(null)
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
    let rest: Record<string, unknown> | null = null
    if (optsRaw) {
      try {
        const parsed = JSON.parse(optsRaw)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          setFormOptionsError('Options must be a JSON object, e.g. {"temperature": 0.7}')
          return
        }
        rest = parsed
        setFormOptionsError(null)
      } catch {
        setFormOptionsError('Invalid JSON')
        return
      }
    }
    const built = buildOptions(rest, formMaxTokens, formToolResultChars)
    if ('error' in built) {
      setFormLimitsError(built.error)
      return
    }
    setFormLimitsError(null)
    if (built.options) {
      payload.options = built.options
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
      // ai-service says why in detail (e.g. the key variable is not set); axios' message only has the status
      const detail = e?.response?.data?.detail
      setTestResult({ success: false, message: (typeof detail === 'string' && detail) || e?.message || 'Test failed' })
    } finally {
      setTesting(false)
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
    formMaxTokens, setFormMaxTokens,
    formToolResultChars, setFormToolResultChars,
    formLimitsError,
    testing,
    testResult,
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
  }
}

export type ModelFormState = ReturnType<typeof useModelForm>
