import { useTranslation } from 'react-i18next'
import { Bot, Loader2, Plus } from 'lucide-react'
import { useModelForm } from './admin-ai-models/useModelForm'
import ModelConfigForm from './admin-ai-models/ModelConfigForm'
import ModelConfigCard from './admin-ai-models/ModelConfigCard'
import { ModalFrame } from '@/components/ModalFrame'
import { modalButton } from '@/components/modalStyles'

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
    <div className="space-y-6">
      {/* header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-white flex items-center gap-2">
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
            className="btn btn-primary flex items-center gap-2"
          >
            <Plus className="h-4 w-4" />
            {tr('admin.aiModels.add', 'Add Model')}
          </button>
        )}
      </div>

      {/* ── Create window ── */}
      {isCreating && (
        <ModalFrame
          size="md"
          title={tr('admin.aiModels.new', 'New Model')}
          onClose={resetForm}
          busy={form.isSaving}
          testId="ai-model-create-dialog"
          footer={
            <>
              <button type="button" onClick={resetForm} className={modalButton.cancel} disabled={form.isSaving}>
                {tr('common.cancel', 'Cancel')}
              </button>
              <button type="button" onClick={form.handleSubmit} disabled={form.isSaving || !form.formName || !form.formModel} className={modalButton.primary}>
                {form.isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
                {tr('admin.aiModels.create', 'Create')}
              </button>
            </>
          }
        >
          <ModelConfigForm form={form} inModal />
        </ModalFrame>
      )}

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
