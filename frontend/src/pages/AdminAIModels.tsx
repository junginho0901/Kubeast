import { useTranslation } from 'react-i18next'
import { Bot, Loader2, Plus } from 'lucide-react'
import { useModelForm } from './admin-ai-models/useModelForm'
import ModelConfigForm from './admin-ai-models/ModelConfigForm'
import ModelConfigCard from './admin-ai-models/ModelConfigCard'

export default function AdminAIModels() {
  const { t } = useTranslation()
  const tr = (key: string, fb: string) => t(key, { defaultValue: fb })
  const form = useModelForm()
  const {
    configs,
    isLoading,
    editingId,
    isCreating,
    deleteMutation,
    activateMutation,
    resetForm,
    openEditForm,
    openCreateForm,
  } = form

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      {/* header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-100 flex items-center gap-2">
            <Bot className="h-5 w-5 text-primary-400" />
            {tr('admin.aiModels.title', 'AI Model Configuration')}
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            {tr('admin.aiModels.subtitle', 'Manage LLM provider configurations used by the AI assistant.')}
          </p>
        </div>
        {!isCreating && editingId === null && (
          <button
            onClick={openCreateForm}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-500"
          >
            <Plus className="h-4 w-4" />
            {tr('admin.aiModels.add', 'Add Model')}
          </button>
        )}
      </div>

      {/* ── Create form (at top) ── */}
      {isCreating && <ModelConfigForm form={form} />}

      {/* ── model config list ── */}
      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-slate-500" />
        </div>
      ) : !configs?.length && !isCreating ? (
        <div className="text-center py-12 text-sm text-slate-500">
          {tr('admin.aiModels.empty', 'No model configurations yet. The default environment config is being used.')}
        </div>
      ) : (
        <div className="space-y-3 mt-4">
          {configs?.map((cfg) => {
            const isEditing = editingId === cfg.id
            return (
              <div key={cfg.id}>
                <ModelConfigCard
                  cfg={cfg}
                  isEditing={isEditing}
                  onEdit={openEditForm}
                  onCancelEdit={resetForm}
                  onDelete={deleteMutation.mutate}
                  activateMutation={activateMutation}
                />
                {isEditing && <ModelConfigForm form={form} />}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
