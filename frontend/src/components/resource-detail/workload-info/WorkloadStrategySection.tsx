import { InfoSection, InfoRow } from '../DetailCommon'
import { ResourceLink } from '../ResourceLink'
import { workloadSettingsInfo } from './workloadLayer'

interface Props {
  namespace?: string
  describe: any
  spec: Record<string, unknown>
  showStrategy: boolean
  strategyType: string
  strategyRolling: Record<string, any> | undefined
  showWorkloadSettings: boolean
  showDeploymentSettings: boolean
  showStatefulSetSettings: boolean
  showDaemonSetSettings: boolean
  showReplicaSetSettings: boolean
  daemonSetStatus: { misscheduled: number; unavailable: number }
}

export default function WorkloadStrategySection({
  namespace,
  describe,
  spec,
  showStrategy,
  strategyType,
  strategyRolling,
  showWorkloadSettings,
  showDeploymentSettings,
  showStatefulSetSettings,
  showDaemonSetSettings,
  showReplicaSetSettings,
  daemonSetStatus,
}: Props) {
  const kind = showDeploymentSettings ? 'Deployment' : showStatefulSetSettings ? 'StatefulSet' : showDaemonSetSettings ? 'DaemonSet' : 'ReplicaSet'
  const settings = workloadSettingsInfo(kind, describe, spec, daemonSetStatus)
  const row = (label: string, value: string | undefined) => value && <InfoRow label={label} value={value} />

  return (
    <>
      {showStrategy && (
        <InfoSection title="Strategy">
          <div className="space-y-2">
            <InfoRow label="Type" value={strategyType} />
            {strategyRolling?.max_unavailable != null && <InfoRow label="Max Unavailable" value={String(strategyRolling.max_unavailable)} />}
            {strategyRolling?.maxUnavailable != null && <InfoRow label="Max Unavailable" value={String(strategyRolling.maxUnavailable)} />}
            {strategyRolling?.max_surge != null && <InfoRow label="Max Surge" value={String(strategyRolling.max_surge)} />}
            {strategyRolling?.maxSurge != null && <InfoRow label="Max Surge" value={String(strategyRolling.maxSurge)} />}
            {strategyRolling?.partition != null && <InfoRow label="Partition" value={String(strategyRolling.partition)} />}
          </div>
        </InfoSection>
      )}

      {showWorkloadSettings && (
        <InfoSection title="Workload Settings">
          <div className="space-y-2">
            {showDeploymentSettings && (
              <>
                {row('Revision', settings.revision)}
                {row('Paused', settings.paused)}
                {row('Min Ready Seconds', settings.min_ready_seconds)}
                {row('Progress Deadline', settings.progress_deadline)}
                {row('Revision History Limit', settings.revision_history_limit)}
              </>
            )}
            {showStatefulSetSettings && (
              <>
                {settings.service_name && (
                  <InfoRow
                    label="Service Name"
                    value={<ResourceLink kind="Service" name={settings.service_name} namespace={namespace} />}
                  />
                )}
                {row('Pod Management Policy', settings.pod_management_policy)}
                {row('Min Ready Seconds', settings.min_ready_seconds)}
                {row('Revision History Limit', settings.revision_history_limit)}
                {row('Current Revision', settings.current_revision)}
                {row('Update Revision', settings.update_revision)}
                {row('Collision Count', settings.collision_count)}
              </>
            )}
            {showDaemonSetSettings && (
              <>
                {row('Min Ready Seconds', settings.min_ready_seconds)}
                {row('Revision History Limit', settings.revision_history_limit)}
                {row('Collision Count', settings.collision_count)}
                {row('Misscheduled Pods', settings.misscheduled_pods)}
                {row('Unavailable Pods', settings.unavailable_pods)}
              </>
            )}
            {showReplicaSetSettings && (
              <>
                {row('Owner', settings.owner)}
                {row('Revision', settings.revision)}
                {row('Min Ready Seconds', settings.min_ready_seconds)}
                {row('Fully Labeled Replicas', settings.fully_labeled_replicas)}
              </>
            )}
          </div>
        </InfoSection>
      )}
    </>
  )
}
