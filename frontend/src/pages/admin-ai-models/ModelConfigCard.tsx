import { ModelConfigResponse } from '@/services/api'
import { getProvider, getModelLabel } from '@/constants/modelCatalog'
import { Check, Pencil, Trash2, X, Radio } from 'lucide-react'
import type { UseMutationResult } from '@tanstack/react-query'

interface Props {
  cfg: ModelConfigResponse
  isEditing: boolean
  onEdit: (cfg: ModelConfigResponse) => void
  onCancelEdit: () => void
  onDelete: (id: number) => void
  activateMutation: UseMutationResult<unknown, unknown, number, unknown>
}

export default function ModelConfigCard({
  cfg,
  isEditing,
  onEdit,
  onCancelEdit,
  onDelete,
  activateMutation,
}: Props) {
  const provDef = getProvider(cfg.provider)
  const isActive = cfg.is_default && cfg.enabled

  return (
    <div
      className={`group relative rounded-xl border px-4 py-3 transition ${
        isEditing
          ? 'border-primary-500/50 bg-primary-500/5 ring-1 ring-primary-500/20'
          : isActive
            ? 'border-emerald-500/50 bg-emerald-500/5 ring-1 ring-emerald-500/20'
            : cfg.enabled
              ? 'border-slate-800 bg-slate-900/60 hover:border-slate-700'
              : 'border-slate-800/50 bg-slate-900/30 opacity-60'
      }`}
    >
      {isActive && !isEditing && (
        <div className="absolute left-0 top-0 bottom-0 w-1 rounded-l-xl bg-emerald-500" />
      )}
      {isEditing && (
        <div className="absolute left-0 top-0 bottom-0 w-1 rounded-l-xl bg-primary-500" />
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg">{provDef?.icon || '⚙️'}</span>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-slate-200">{cfg.name}</span>

              {isActive && (
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">
                  <Check className="h-2.5 w-2.5" />
                  Active
                </span>
              )}

              {!cfg.enabled && (
                <span className="inline-flex rounded-full border border-slate-700 bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-500">
                  Disabled
                </span>
              )}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              {provDef?.label || cfg.provider} · <code className="text-slate-400">{getModelLabel(cfg.provider, cfg.model)}</code>
              {cfg.api_key_set
                ? <span className="text-emerald-600 ml-1">· 🔑 Key stored</span>
                : cfg.api_key_env
                  ? <span className="text-amber-600 ml-1">· env: {cfg.api_key_env}</span>
                  : <span className="text-red-500 ml-1">· ⚠ No key</span>}
              {cfg.base_url && <span className="text-slate-600"> · {cfg.base_url}</span>}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1">
          {cfg.enabled && !isActive && (
            <button
              onClick={() => activateMutation.mutate(cfg.id)}
              disabled={activateMutation.isPending}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-slate-400 hover:bg-emerald-500/10 hover:text-emerald-400 transition"
              title="Set as Active"
            >
              <Radio className="h-3 w-3" />
              Activate
            </button>
          )}
          <button
            onClick={() => isEditing ? onCancelEdit() : onEdit(cfg)}
            className={`rounded-lg p-1.5 transition ${
              isEditing
                ? 'bg-primary-500/20 text-primary-400'
                : 'text-slate-500 hover:bg-slate-800 hover:text-slate-300'
            }`}
            title={isEditing ? 'Close edit' : 'Edit'}
          >
            {isEditing ? <X className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
          </button>
          <button
            onClick={() => {
              if (confirm(`Delete "${cfg.name}"?`)) onDelete(cfg.id)
            }}
            className="rounded-lg p-1.5 text-slate-500 hover:bg-red-500/10 hover:text-red-400"
            title="Delete"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}
