import { useEffect, useState } from 'react'
import { Terminal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { loadNodeShellSettings, saveNodeShellSettings } from '@/services/nodeShellSettings'

export default function AdminNodeShell() {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback })

  const [nodeShellEnabled, setNodeShellEnabled] = useState(loadNodeShellSettings().isEnabled)
  const [nodeShellNamespace, setNodeShellNamespace] = useState(loadNodeShellSettings().namespace)
  const [nodeShellImage, setNodeShellImage] = useState(loadNodeShellSettings().linuxImage)

  useEffect(() => {
    saveNodeShellSettings({
      isEnabled: nodeShellEnabled,
      namespace: nodeShellNamespace.trim() || 'default',
      linuxImage: nodeShellImage.trim() || 'docker.io/library/busybox:latest',
    })
  }, [nodeShellEnabled, nodeShellNamespace, nodeShellImage])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-white">{tr('account.nodeShell.title', 'Node Shell')}</h1>
        <p className="mt-2 text-slate-400">
          {tr('account.nodeShell.subtitle', 'Configure debug shell settings for nodes.')}
        </p>
      </div>

      <div className="card">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-lg bg-sky-500/10">
            <Terminal className="w-6 h-6 text-sky-400" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-white">{tr('account.nodeShell.title', 'Node Shell')}</h2>
            <p className="text-sm text-slate-400">
              {tr('account.nodeShell.subtitle', 'Configure debug shell settings for nodes.')}
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-slate-700 bg-slate-900/40 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-white">
                {tr('account.nodeShell.enable', 'Enable Node Shell')}
              </div>
              <div className="text-xs text-slate-400">
                {tr('account.nodeShell.enableHint', 'Show debug shell action in node details.')}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setNodeShellEnabled((prev) => !prev)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${
                nodeShellEnabled ? 'bg-emerald-500' : 'bg-slate-700'
              }`}
              aria-pressed={nodeShellEnabled}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${
                  nodeShellEnabled ? 'translate-x-5' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          <div>
            <div className="text-xs text-slate-400 mb-1">
              {tr('account.nodeShell.namespace', 'Namespace')}
            </div>
            <input
              type="text"
              value={nodeShellNamespace}
              onChange={(e) => setNodeShellNamespace(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-sm text-slate-200"
            />
            <p className="mt-1 text-[11px] text-slate-500">
              {tr(
                'account.nodeShell.namespaceHint',
                'Informational only: the server always creates the shell pod in its configured privileged namespace (NODE_SHELL_NAMESPACE).',
              )}
            </p>
          </div>

          <div>
            <div className="text-xs text-slate-400 mb-1">
              {tr('account.nodeShell.image', 'Linux image')}
            </div>
            <input
              type="text"
              value={nodeShellImage}
              onChange={(e) => setNodeShellImage(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-sm text-slate-200"
            />
            <p className="mt-1 text-[11px] text-slate-500">
              {tr(
                'account.nodeShell.imageHint',
                'Must be on the server allow list (Helm nodeShell.images / NODE_SHELL_IMAGES); the shell pod always runs in the dedicated privileged namespace.',
              )}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
