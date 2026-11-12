import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Editor from '@/components/monaco/CodeEditor'
import { ModalFrame } from '@/components/ModalFrame'
import { modalButton, yamlEditorHeight } from '@/components/modalStyles'
import { useAIContext } from '@/hooks/useAIContext'
import { api } from '@/services/api'
import { announceCreated, createdOf, createdText, type CreatedObject } from '@/services/createdNoticeStore'

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
  // a YAML of several objects is created in order and stops at the first the cluster refuses: those before it stay
  const [madeBefore, setMadeBefore] = useState<CreatedObject[]>([])

  useEffect(() => {
    setYaml(initialYaml)
  }, [initialYaml])

  // the action and where it goes, not the YAML being written
  useAIContext({
    source: 'ResourceYamlCreateDialog',
    summary: `생성 창 — ${title}${namespace ? ` (${namespace})` : ''}`,
    data: { action: 'create', title, namespace, error: error ?? undefined, created_before_error: madeBefore.length ? madeBefore : undefined },
  }, [title, namespace, error, madeBefore])

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
    setMadeBefore([])
    try {
      const created = await api.createResourcesFromYaml(yaml, namespace)
      announceCreated(window.location.pathname, createdOf(created))
      onCreated?.()
      onClose()
    } catch (err: any) {
      const detail = err?.response?.data?.detail || err?.message || t('yamlCreate.failed', { defaultValue: 'Failed to create resource' })
      setError(String(detail))
      const made = createdOf(err?.response?.data)
      setMadeBefore(made)
      // what was made is in the cluster now: the list behind the window reads it
      if (made.length) onCreated?.()
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <ModalFrame
      size="lg"
      title={title}
      subtitle={clusterScoped
        ? t('yamlCreate.clusterScoped', { defaultValue: 'Cluster-scoped resource: metadata.namespace is not used.' })
        : namespace
          ? t('yamlCreate.namespaceOverride', { namespace, defaultValue: 'Namespace override: {{namespace}}' })
          : t('yamlCreate.namespaceFromYaml', { defaultValue: 'Namespace is read from YAML metadata.namespace (or default namespace if omitted).' })}
      onClose={onClose}
      busy={isCreating}
      testId="yaml-create-dialog"
      footer={
        <>
          <button type="button" onClick={onClose} className={modalButton.cancel} disabled={isCreating}>
            {t('yamlCreate.cancel', { defaultValue: 'Cancel' })}
          </button>
          <button type="button" onClick={handleCreate} disabled={isCreating || !yaml.trim()} className={modalButton.primary}>
            {isCreating ? t('yamlCreate.creating', { defaultValue: 'Creating...' }) : t('yamlCreate.create', { defaultValue: 'Create' })}
          </button>
        </>
      }
    >
      <div className="border border-slate-700 rounded-lg overflow-hidden" style={{ height: yamlEditorHeight(yaml) }}>
        <Editor
          height="100%"
          theme="vs-dark"
          language="yaml"
          value={yaml}
          onChange={(next) => setYaml(next ?? '')}
          options={editorOptions}
        />
      </div>
      {!yaml.trim() && (
        <p role="alert" data-testid="yaml-create-empty" className="mt-1 text-[11px] text-red-400">
          {t('yamlCreate.empty', { defaultValue: 'Nothing to create: enter the YAML of an object.' })}
        </p>
      )}

      {error && (
        <p data-testid="yaml-create-error" className="mt-3 text-sm text-red-400 wrap-break-word whitespace-pre-wrap">
          {error}
        </p>
      )}
      {error && madeBefore.length > 0 && (
        <p data-testid="yaml-create-made-before" className="mt-1 text-sm text-emerald-300 wrap-break-word">
          {t('yamlCreate.madeBefore', { defaultValue: 'Created before it stopped: {{objects}}', objects: madeBefore.map(createdText).join(', ') })}
        </p>
      )}
    </ModalFrame>
  )
}

