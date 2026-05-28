import { InfoSection } from '../DetailCommon'
import ContainerKvRow from './ContainerKvRow'
import {
  boolText,
  formatContainerCommand,
  formatProbe,
  formatCapabilities,
  toEntryPairs,
  toPorts,
  toMounts,
} from './workloadInfoFormatters'

interface Props {
  containers: any[]
}

export default function WorkloadContainers({ containers }: Props) {
  if (containers.length === 0) return null

  return (
    <InfoSection title="Containers">
      <div className="space-y-2">
        {containers.map((container: any, idx: number) => (
          <div key={`${container.name || 'container'}-${idx}`} className="rounded border border-slate-800 bg-slate-900/40 p-3 space-y-2">
            <div className="pb-2 border-b border-slate-800">
              <div className="text-sm font-semibold text-white break-words">{container.name || `container-${idx + 1}`}</div>
            </div>
            <div className="divide-y divide-slate-800/70">
              <ContainerKvRow label="Image">
                <span className="font-mono break-all">{container.image || '-'}</span>
              </ContainerKvRow>
              <ContainerKvRow label="Command">
                <span className="font-mono break-words whitespace-pre-wrap">{formatContainerCommand(container.command, container.args)}</span>
              </ContainerKvRow>
              {toPorts(container.ports).length > 0 && (
                <ContainerKvRow label="Ports">
                  <div className="flex flex-wrap gap-1.5">
                    {toPorts(container.ports).map((port, portIdx) => (
                      <span key={`${port}-${portIdx}`} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono">
                        {port}
                      </span>
                    ))}
                  </div>
                </ContainerKvRow>
              )}
              {toEntryPairs(container.requests).length > 0 && (
                <ContainerKvRow label="Requests">
                  <div className="flex flex-wrap gap-1.5">
                    {toEntryPairs(container.requests).map(([k, v]) => (
                      <span key={`req-${k}`} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono">
                        {k}={v}
                      </span>
                    ))}
                  </div>
                </ContainerKvRow>
              )}
              {toEntryPairs(container.limits).length > 0 && (
                <ContainerKvRow label="Limits">
                  <div className="flex flex-wrap gap-1.5">
                    {toEntryPairs(container.limits).map(([k, v]) => (
                      <span key={`lim-${k}`} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono">
                        {k}={v}
                      </span>
                    ))}
                  </div>
                </ContainerKvRow>
              )}
              {typeof container.env_count === 'number' && (
                <ContainerKvRow label="Env">
                  <span className="font-mono">{container.env_count}</span>
                </ContainerKvRow>
              )}
              {toMounts(container.volume_mounts).length > 0 && (
                <ContainerKvRow label="Mounts">
                  <div className="flex flex-wrap gap-1.5">
                    {toMounts(container.volume_mounts).map((mount, mountIdx) => (
                      <span key={`${mount}-${mountIdx}`} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono">
                        {mount}
                      </span>
                    ))}
                  </div>
                </ContainerKvRow>
              )}
              {container.livenessProbe && (
                <ContainerKvRow label="Liveness">
                  <span className="font-mono break-words whitespace-pre-wrap">{formatProbe(container.livenessProbe)}</span>
                </ContainerKvRow>
              )}
              {container.readinessProbe && (
                <ContainerKvRow label="Readiness">
                  <span className="font-mono break-words whitespace-pre-wrap">{formatProbe(container.readinessProbe)}</span>
                </ContainerKvRow>
              )}
              {container.startupProbe && (
                <ContainerKvRow label="Startup">
                  <span className="font-mono break-words whitespace-pre-wrap">{formatProbe(container.startupProbe)}</span>
                </ContainerKvRow>
              )}
              {container.securityContext && (
                <>
                  {container.securityContext.privileged != null && (
                    <ContainerKvRow label="Privileged">
                      <span>{boolText(container.securityContext.privileged)}</span>
                    </ContainerKvRow>
                  )}
                  {container.securityContext.runAsUser != null && (
                    <ContainerKvRow label="Run As User">
                      <span className="font-mono">{String(container.securityContext.runAsUser)}</span>
                    </ContainerKvRow>
                  )}
                  {container.securityContext.runAsNonRoot != null && (
                    <ContainerKvRow label="Non-Root">
                      <span>{boolText(container.securityContext.runAsNonRoot)}</span>
                    </ContainerKvRow>
                  )}
                  {container.securityContext.readOnlyRootFilesystem != null && (
                    <ContainerKvRow label="RO Root FS">
                      <span>{boolText(container.securityContext.readOnlyRootFilesystem)}</span>
                    </ContainerKvRow>
                  )}
                  {container.securityContext.allowPrivilegeEscalation != null && (
                    <ContainerKvRow label="Priv Escalation">
                      <span>{boolText(container.securityContext.allowPrivilegeEscalation)}</span>
                    </ContainerKvRow>
                  )}
                  {formatCapabilities(container.securityContext.capabilities) && (
                    <ContainerKvRow label="Capabilities">
                      <span className="font-mono break-words whitespace-pre-wrap">{formatCapabilities(container.securityContext.capabilities)}</span>
                    </ContainerKvRow>
                  )}
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </InfoSection>
  )
}
