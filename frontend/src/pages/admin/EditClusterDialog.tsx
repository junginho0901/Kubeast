import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Upload, Loader2 } from 'lucide-react'

import { ModalOverlay } from '@/components/ModalOverlay'
import { clustersApi, type ClusterMeta } from '@/services/api/clusters'

// Edit a registered cluster: rename, and (external only) rotate its kubeconfig
// when credentials change. The cluster id and all per-cluster RBAC grants are
// kept — the backend rejects a kubeconfig that points at a different physical
// cluster (kube-system UID mismatch).
interface Props {
  cluster: ClusterMeta
  onClose: () => void
  onSaved: () => void
}

export default function EditClusterDialog({ cluster, onClose, onSaved }: Props) {
  const { t } = useTranslation()
  const tr = (k: string, d: string) => {
    const v = t(k)
    return v === k ? d : v
  }
  const isSelf = cluster.is_self_cluster || cluster.mode === 'in_cluster'

  const [displayName, setDisplayName] = useState(cluster.display_name)
  const [kubeconfig, setKubeconfig] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) setKubeconfig(await f.text())
  }

  const dirty =
    displayName.trim() !== cluster.display_name || kubeconfig.trim() !== ''
  const canSave = displayName.trim() !== '' && dirty && !saving

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const patch: { display_name?: string; kubeconfig?: string } = {}
      if (displayName.trim() !== cluster.display_name) patch.display_name = displayName.trim()
      if (kubeconfig.trim() !== '') patch.kubeconfig = kubeconfig
      await clustersApi.updateCluster(cluster.id, patch)
      onSaved()
    } catch (e: unknown) {
      const resp = (e as { response?: { data?: { detail?: string } } }).response
      setError(resp?.data?.detail ?? (e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalOverlay onClose={saving ? () => {} : onClose}>
      <div className="w-[34rem] max-w-full rounded-xl border border-slate-700 bg-slate-800 p-6">
        <h3 className="text-lg font-bold text-white">
          {tr('cluster.edit.title', 'Edit cluster')} — {cluster.id}
        </h3>

        <label className="mt-4 block text-xs font-semibold text-slate-400">
          {tr('cluster.register.displayName', 'Display name')}
        </label>
        <input
          data-testid="edit-name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-900/60 px-3 py-2 text-sm text-white focus:border-primary-500 focus:outline-none"
        />

        {!isSelf && (
          <>
            <div className="mt-4 flex items-center justify-between">
              <label className="block text-xs font-semibold text-slate-400">
                {tr('cluster.edit.kubeconfig', 'Replace kubeconfig (optional)')}
              </label>
              <button
                onClick={() => fileRef.current?.click()}
                className="inline-flex items-center gap-1 text-xs text-slate-300 hover:text-white"
              >
                <Upload className="h-3.5 w-3.5" />
                {tr('cluster.register.upload', 'Upload')}
              </button>
              <input ref={fileRef} type="file" className="hidden" onChange={onFile} />
            </div>
            <textarea
              data-testid="edit-kubeconfig"
              value={kubeconfig}
              onChange={(e) => setKubeconfig(e.target.value)}
              placeholder={tr('cluster.edit.kubeconfigHint', 'Leave blank to keep the current kubeconfig. Paste a new one to rotate credentials.')}
              rows={7}
              className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-900/60 px-3 py-2 font-mono text-xs text-white focus:border-primary-500 focus:outline-none"
            />
            <p className="mt-1 text-[11px] text-slate-500">
              {tr('cluster.edit.sameClusterNote', 'A new kubeconfig must point to the same cluster — RBAC grants and chat history are preserved.')}
            </p>
          </>
        )}

        {error && (
          <div className="mt-3 rounded-lg border border-red-700/60 bg-red-900/30 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700/40 disabled:opacity-50"
          >
            {tr('common.cancel', 'Cancel')}
          </button>
          <button
            data-testid="edit-submit"
            onClick={save}
            disabled={!canSave}
            className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {tr('common.save', 'Save')}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}
