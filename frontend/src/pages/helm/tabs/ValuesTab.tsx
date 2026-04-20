import { useState } from 'react'
import Editor from '@monaco-editor/react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { api, type HelmUpgradeResponse } from '@/services/api'
import { usePermission } from '@/hooks/usePermission'
import UpgradePreviewModal from '../modals/UpgradePreviewModal'

export default function ValuesTab({ namespace, name }: { namespace: string; name: string }) {
  const { t } = useTranslation()
  const { has } = usePermission()
  const canEdit = has('resource.helm.upgrade')

  const valuesQuery = useQuery({
    queryKey: ['helm-section', namespace, name, 'values'],
    queryFn: () => api.helm.getSection(namespace, name, 'values'),
    enabled: !!namespace && !!name,
  })

  // Local draft; entering edit mode seeds it from the last-known server
  // copy. We do not bind directly to the query data so a background
  // refetch can't stomp the user's in-progress edit.
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [preview, setPreview] = useState<HelmUpgradeResponse | null>(null)

  const current = valuesQuery.data?.content ?? ''

  const beginEdit = () => {
    setDraft(current)
    setEditing(true)
  }

  if (valuesQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-10 text-slate-400">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    )
  }

  if (!editing) {
    return (
      <div className="space-y-3">
        {canEdit && (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={beginEdit}
              className="inline-flex items-center gap-1.5 rounded border border-slate-600 bg-slate-800 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-700"
            >
              {t('helmReleaseDetail.upgrade.edit')}
            </button>
          </div>
        )}
        <div className="rounded-lg bg-slate-900 border border-slate-700 overflow-hidden">
          <Editor
            height="60vh"
            defaultLanguage="yaml"
            value={current || ''}
            theme="vs-dark"
            options={{
              readOnly: true,
              minimap: { enabled: false },
              fontSize: 12,
              lineNumbers: 'on',
              wordWrap: 'on',
              scrollBeyondLastLine: false,
            }}
          />
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="space-y-3">
        <div className="rounded-lg bg-slate-950 border border-slate-700 overflow-hidden">
          <Editor
            height="50vh"
            defaultLanguage="yaml"
            value={draft}
            theme="vs-dark"
            onChange={(v) => setDraft(v ?? '')}
            options={{
              minimap: { enabled: false },
              fontSize: 12,
              lineNumbers: 'on',
              wordWrap: 'on',
              scrollBeyondLastLine: false,
              tabSize: 2,
              insertSpaces: true,
            }}
          />
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              setEditing(false)
              setDraft('')
            }}
            className="inline-flex items-center gap-1.5 rounded border border-slate-600 bg-slate-800 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-700"
          >
            {t('helmReleaseDetail.upgrade.cancel')}
          </button>
          <button
            type="button"
            disabled={draft === current}
            onClick={async () => {
              try {
                const r = await api.helm.upgradeValues(namespace, name, {
                  values: draft,
                  dryRun: true,
                })
                setPreview(r)
              } catch (err: any) {
                setPreview({
                  dryRun: true,
                  fromRevision: 0,
                  chartVersion: '',
                  diff: err?.response?.data?.detail ?? err?.message ?? 'dry-run failed',
                })
              }
            }}
            className="px-4 py-2 text-sm bg-primary-600 hover:bg-primary-700 text-white rounded-lg disabled:opacity-40"
          >
            {t('helmReleaseDetail.upgrade.preview')}
          </button>
        </div>
      </div>

      {preview && (
        <UpgradePreviewModal
          namespace={namespace}
          name={name}
          values={draft}
          preview={preview}
          onClose={() => setPreview(null)}
          onApplied={() => {
            setPreview(null)
            setEditing(false)
            setDraft('')
          }}
        />
      )}
    </>
  )
}
