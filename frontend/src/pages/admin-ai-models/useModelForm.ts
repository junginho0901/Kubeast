import { useState, useMemo } from 'react'
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
  const [formApiKey, setFormApiKey] = useState('')
  const [formShowApiKey, setFormShowApiKey] = useState(false)
  const [formEnabled, setFormEnabled] = useState(true)
  const [formIsDefault, setFormIsDefault] = useState(false)
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
  const currentModelOptions = useMemo(() => modelOptions(currentProviderDef), [currentProviderDef])

  const resetForm = () => {
    setEditingId(null)
    setIsCreating(false)
    setFormName('')
    setFormProvider('openai')
    setFormModel('')
    setFormCustomModel(false)
    setFormBaseUrl('')
    setFormApiKey('')
    setFormShowApiKey(false)
    setFormEnabled(true)
    setFormIsDefault(false)
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
    setFormApiKey('')
    setFormShowApiKey(false)
    setFormEnabled(cfg.enabled)
    setFormIsDefault(cfg.is_default)
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
      setFormApiKey('')
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
    }
    if (formApiKey.trim()) {
      payload.api_key = formApiKey.trim()
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
    if (!formApiKey.trim() && currentProviderDef.needsApiKey !== false) {
      setTestResult({ success: false, message: 'Please enter an API key to test' })
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const result = await api.testModelConnection({
        provider: formProvider,
        model: formModel,
        base_url: formBaseUrl || undefined,
        api_key: formApiKey.trim() || undefined,
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
    } catch (e: any) {
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
    formApiKey, setFormApiKey,
    formShowApiKey, setFormShowApiKey,
    formEnabled, setFormEnabled,
    formIsDefault, setFormIsDefault,
    formCaCert, setFormCaCert,
    formOptions, setFormOptions,
    formOptionsError,
    testing,
    testResult,
    rolloutStatus,
    rolloutMessage,
    currentProviderDef,
    currentModelOptions,
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
