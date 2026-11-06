import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { SquareTerminal } from 'lucide-react'
import { usePermission } from '@/hooks/usePermission'
import { loadNodeShellSettings, saveNodeShellSettings, type NodeShellSettings } from '@/services/nodeShellSettings'
import { holdsOnAnyCluster } from '@/utils/permissions'

// The Node Shell settings: this browser's own, so they sit with the other personal settings. Shown to whoever may open
// a node shell on any cluster.
export default function NodeShellSection({ ready }: { ready: boolean }) {
  const { permissions } = usePermission()
  return holdsOnAnyCluster(permissions, 'resource.node.shell') ? <NodeShellCard ready={ready} /> : null
}

function NodeShellCard({ ready }: { ready: boolean }) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback })
  const { hash } = useLocation()
  const card = useRef<HTMLDivElement>(null)

  const [enabled, setEnabled] = useState(() => loadNodeShellSettings().isEnabled)
  const [image, setImage] = useState(() => loadNodeShellSettings().linuxImage)
  // The namespace field is gone: the server always runs the shell pod in its own privileged namespace and ignored the
  // value. The stored setting keeps its default for older pages that still send it.
  const save = (change: Partial<NodeShellSettings>) => saveNodeShellSettings({ ...loadNodeShellSettings(), ...change })

  // the old Node Shell address lands here, once the section that holds the card shows
  useEffect(() => {
    if (ready && hash === '#node-shell') card.current?.scrollIntoView({ block: 'start' })
  }, [hash, ready])

  return (
    <div className="card" id="node-shell" ref={card} data-testid="account-node-shell">
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 rounded-lg bg-slate-700/60">
          <SquareTerminal className="w-6 h-6 text-slate-300" />
        </div>
        <div>
          <h2 className="text-xl font-semibold text-ink">{tr('account.nodeShell.title', 'Node Shell')}</h2>
          <p className="text-sm text-slate-400">
            {tr('account.nodeShell.subtitle', 'Debug shell settings for nodes. Kept in this browser.')}
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-slate-700 bg-slate-900/40 p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-ink">
              {tr('account.nodeShell.enable', 'Enable Node Shell')}
            </div>
            <div className="text-xs text-slate-400">
              {tr('account.nodeShell.enableHint', 'Show debug shell action in node details.')}
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setEnabled(!enabled)
              save({ isEnabled: !enabled })
            }}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${
              enabled ? 'bg-primary-600' : 'bg-slate-700'
            }`}
            aria-pressed={enabled}
            aria-label={tr('account.nodeShell.enable', 'Enable Node Shell')}
            data-testid="node-shell-enabled"
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${
                enabled ? 'translate-x-5' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        <div>
          <label htmlFor="node-shell-image" className="block text-xs font-semibold text-slate-400 mb-1">
            {tr('account.nodeShell.image', 'Linux image')}
          </label>
          <input
            id="node-shell-image"
            type="text"
            value={image}
            onChange={(e) => {
              setImage(e.target.value)
              save({ linuxImage: e.target.value.trim() })
            }}
            placeholder={tr('account.nodeShell.imagePlaceholder', 'Server default (first image on the allow list)')}
            className="w-full h-10 rounded-lg border border-slate-700 bg-slate-950/40 px-3 text-sm text-slate-200"
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
  )
}
