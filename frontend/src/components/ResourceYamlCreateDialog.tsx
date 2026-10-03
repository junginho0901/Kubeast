import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Editor from '@/components/monaco/CodeEditor'
import { ModalOverlay } from '@/components/ModalOverlay'
import { api } from '@/services/api'

const CLUSTER_SCOPED_KINDS = new Set([
  'Namespace', 'Node', 'PersistentVolume', 'StorageClass', 'VolumeAttachment', 'IngressClass',
  'GatewayClass', 'ClusterRole', 'ClusterRoleBinding', 'PriorityClass', 'RuntimeClass',
  'MutatingWebhookConfiguration', 'ValidatingWebhookConfiguration', 'CustomResourceDefinition',
  'DeviceClass', 'ResourceSlice',
])

interface ResourceYamlCreateDialogProps {
  title: string
  initialYaml: string
  namespace?: string
  onClose: () => void
  onCreated?: () => void
}

export default function ResourceYamlCreateDialog({
  title,
  initialYaml,
  namespace,
  onClose,
  onCreated,
}: ResourceYamlCreateDialogProps) {
  const { t } = useTranslation()
  const [yaml, setYaml] = useState(initialYaml)
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setYaml(initialYaml)
  }, [initialYaml])

  // The namespace hint only makes sense for namespaced kinds; the sample YAML
  // every caller passes starts with the kind, so read it from there.
  const clusterScoped = useMemo(() => {
    const kind = /^kind:\s*([A-Za-z]+)/m.exec(yaml)?.[1]
    return !!kind && CLUSTER_SCOPED_KINDS.has(kind)
  }, [yaml])

  const editorOptions = useMemo(
    () => ({
      readOnly: isCreating,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'none' as const,
      wordWrap: 'off' as const,
      fontSize: 12,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    }),
    [isCreating],
  )

  const handleCreate = async () => {
    if (!yaml.trim() || isCreating) return
    setIsCreating(true)
    setError(null)
    try {
      await api.createResourcesFromYaml(yaml, namespace)
      onCreated?.()
      onClose()
    } catch (err: any) {
      const detail = err?.response?.data?.detail || err?.message || t('yamlCreate.failed', { defaultValue: 'Failed to create resource' })
      setError(String(detail))
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div
        className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-4xl mx-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-white">{title}</h3>
        <p className="mt-1 text-xs text-slate-400">
          {clusterScoped
            ? t('yamlCreate.clusterScoped', { defaultValue: 'Cluster-scoped resource: metadata.namespace is not used.' })
            : namespace
              ? t('yamlCreate.namespaceOverride', { namespace, defaultValue: 'Namespace override: {{namespace}}' })
              : t('yamlCreate.namespaceFromYaml', { defaultValue: 'Namespace is read from YAML metadata.namespace (or default namespace if omitted).' })}
        </p>

        <div className="mt-4 border border-slate-700 rounded-lg overflow-hidden">
          <div className="h-[460px]">
            <Editor
              height="100%"
              theme="vs-dark"
              language="yaml"
              value={yaml}
              onChange={(next) => setYaml(next ?? '')}
              options={editorOptions}
            />
          </div>
        </div>

        {error && (
          <p className="mt-3 text-sm text-red-400 break-words whitespace-pre-wrap">
            {error}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-slate-300 hover:text-white border border-slate-600 rounded-lg hover:bg-slate-800"
            disabled={isCreating}
          >
            {t('yamlCreate.cancel', { defaultValue: 'Cancel' })}
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={isCreating || !yaml.trim()}
            className="btn btn-primary px-4 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isCreating ? t('yamlCreate.creating', { defaultValue: 'Creating...' }) : t('yamlCreate.create', { defaultValue: 'Create' })}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}

