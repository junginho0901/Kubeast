import { InfoSection, InfoRow } from '../DetailCommon'
import { ResourceLink } from '../ResourceLink'
import { boolText } from './workloadInfoFormatters'

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
                {describe?.revision && <InfoRow label="Revision" value={String(describe.revision)} />}
                {describe?.paused != null && <InfoRow label="Paused" value={boolText(describe.paused)} />}
                {describe?.min_ready_seconds != null && <InfoRow label="Min Ready Seconds" value={String(describe.min_ready_seconds)} />}
                {describe?.progress_deadline_seconds != null && <InfoRow label="Progress Deadline" value={`${String(describe.progress_deadline_seconds)}s`} />}
                {describe?.revision_history_limit != null && <InfoRow label="Revision History Limit" value={String(describe.revision_history_limit)} />}
              </>
            )}
            {showStatefulSetSettings && (
              <>
                {(describe?.service_name || spec.serviceName) && (
                  <InfoRow
                    label="Service Name"
                    value={<ResourceLink kind="Service" name={String(describe?.service_name || spec.serviceName)} namespace={namespace} />}
                  />
                )}
                {(describe?.pod_management_policy || spec.podManagementPolicy) && (
                  <InfoRow label="Pod Management Policy" value={String(describe?.pod_management_policy || spec.podManagementPolicy)} />
                )}
                {describe?.min_ready_seconds != null && <InfoRow label="Min Ready Seconds" value={String(describe.min_ready_seconds)} />}
                {describe?.revision_history_limit != null && <InfoRow label="Revision History Limit" value={String(describe.revision_history_limit)} />}
                {describe?.current_revision && <InfoRow label="Current Revision" value={String(describe.current_revision)} />}
                {describe?.update_revision && <InfoRow label="Update Revision" value={String(describe.update_revision)} />}
                {describe?.collision_count != null && <InfoRow label="Collision Count" value={String(describe.collision_count)} />}
              </>
            )}
            {showDaemonSetSettings && (
              <>
                {describe?.min_ready_seconds != null && <InfoRow label="Min Ready Seconds" value={String(describe.min_ready_seconds)} />}
                {describe?.revision_history_limit != null && <InfoRow label="Revision History Limit" value={String(describe.revision_history_limit)} />}
                {describe?.collision_count != null && <InfoRow label="Collision Count" value={String(describe.collision_count)} />}
                <InfoRow label="Misscheduled Pods" value={String(daemonSetStatus.misscheduled)} />
                <InfoRow label="Unavailable Pods" value={String(daemonSetStatus.unavailable)} />
              </>
            )}
            {showReplicaSetSettings && (
              <>
                {describe?.owner && <InfoRow label="Owner" value={String(describe.owner)} />}
                {describe?.revision && <InfoRow label="Revision" value={String(describe.revision)} />}
                {describe?.min_ready_seconds != null && <InfoRow label="Min Ready Seconds" value={String(describe.min_ready_seconds)} />}
                {describe?.fully_labeled_replicas != null && <InfoRow label="Fully Labeled Replicas" value={String(describe.fully_labeled_replicas)} />}
              </>
            )}
          </div>
        </InfoSection>
      )}
    </>
  )
}
