import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import RequireAuth from './components/RequireAuth'
import RequireAdmin from './components/RequireAdmin'
import Dashboard from './pages/Dashboard'
import Namespaces from './pages/Namespaces'
import Resources from './pages/Resources'
import Topology from './pages/Topology'
import NetworkPage from './pages/Network'
import AIChat from './pages/AIChat'
import ClusterView from './pages/ClusterView'
import Monitoring from './pages/Monitoring'
import Storage from './pages/Storage'
import Login from './pages/Login'
import Setup from './pages/Setup'
import AdminUsers from './pages/AdminUsers'
import AdminAIModels from './pages/AdminAIModels'
import AdminNodeShell from './pages/AdminNodeShell'
import Account from './pages/Account'
import HPAs from './pages/workloads/HPAs'
import VPAs from './pages/workloads/VPAs'
import PDBs from './pages/workloads/PDBs'
import AdvancedSearch from './pages/AdvancedSearch'
import Pods from './pages/workloads/Pods'
import Deployments from './pages/workloads/Deployments'
import StatefulSets from './pages/workloads/StatefulSets'
import DaemonSets from './pages/workloads/DaemonSets'
import Jobs from './pages/workloads/Jobs'
import ReplicaSets from './pages/workloads/ReplicaSets'
import CronJobs from './pages/workloads/CronJobs'
import ClusterNodes from './pages/ClusterNodes'
import Services from './pages/network/Services'
import Endpoints from './pages/network/Endpoints'
import EndpointSlices from './pages/network/EndpointSlices'
import Ingresses from './pages/network/Ingresses'
import IngressClasses from './pages/network/IngressClasses'
import NetworkPolicies from './pages/network/NetworkPolicies'
import Gateways from './pages/gateway/Gateways'
import GatewayClasses from './pages/gateway/GatewayClasses'
import HTTPRoutes from './pages/gateway/HTTPRoutes'
import GRPCRoutes from './pages/gateway/GRPCRoutes'
import ReferenceGrants from './pages/gateway/ReferenceGrants'
import BackendTLSPolicies from './pages/gateway/BackendTLSPolicies'
import BackendTrafficPolicies from './pages/gateway/BackendTrafficPolicies'
import GPUDashboard from './pages/gpu/GPUDashboard'
import GPUNodes from './pages/gpu/GPUNodes'
import GPUPods from './pages/gpu/GPUPods'
import DeviceClasses from './pages/gpu/DeviceClasses'
import ResourceClaims from './pages/gpu/ResourceClaims'
import ResourceClaimTemplates from './pages/gpu/ResourceClaimTemplates'
import ResourceSlices from './pages/gpu/ResourceSlices'
import ServiceAccounts from './pages/security/ServiceAccounts'
import Roles from './pages/security/Roles'
import RoleBindings from './pages/security/RoleBindings'
import ClusterRoles from './pages/security/ClusterRoles'
import ClusterRoleBindings from './pages/security/ClusterRoleBindings'
import ConfigMaps from './pages/configuration/ConfigMaps'
import Secrets from './pages/configuration/Secrets'
import PriorityClasses from './pages/cluster/PriorityClasses'
import RuntimeClasses from './pages/cluster/RuntimeClasses'
import Leases from './pages/cluster/Leases'
import ResourceQuotas from './pages/cluster/ResourceQuotas'
import LimitRanges from './pages/cluster/LimitRanges'
import MutatingWebhookConfigurations from './pages/cluster/MutatingWebhookConfigurations'
import ValidatingWebhookConfigurations from './pages/cluster/ValidatingWebhookConfigurations'
import CustomResourceDefinitions from './pages/custom-resources/CustomResourceDefinitions'
import CustomResourceInstances from './pages/custom-resources/CustomResourceInstances'
import { MonacoEditorLoaderInitializer } from './components/monaco/MonacoEditorLoaderInitializer'

function App() {
  return (
    <MonacoEditorLoaderInitializer>
      <BrowserRouter>
        <Routes>
          <Route path="/setup" element={<Setup />} />
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<RequireAuth><Layout /></RequireAuth>}>
            <Route index element={<Dashboard />} />
            <Route path="namespaces" element={<Namespaces />} />
            <Route path="cluster/namespaces" element={<Namespaces />} />
            <Route path="cluster/nodes" element={<ClusterNodes />} />
            <Route path="cluster/search" element={<AdvancedSearch />} />
            <Route path="workloads/pods" element={<Pods />} />
            <Route path="workloads/deployments" element={<Deployments />} />
            <Route path="workloads/statefulsets" element={<StatefulSets />} />
            <Route path="workloads/daemonsets" element={<DaemonSets />} />
            <Route path="workloads/replicasets" element={<ReplicaSets />} />
            <Route path="workloads/jobs" element={<Jobs />} />
            <Route path="workloads/cronjobs" element={<CronJobs />} />
            <Route path="storage" element={<Storage />} />
            <Route path="network/services" element={<Services />} />
            <Route path="network/endpoints" element={<Endpoints />} />
            <Route path="network/endpointslices" element={<EndpointSlices />} />
            <Route path="network/ingresses" element={<Ingresses />} />
            <Route path="network/ingressclasses" element={<IngressClasses />} />
            <Route path="network/networkpolicies" element={<NetworkPolicies />} />
            <Route path="gateway/gateways" element={<Gateways />} />
            <Route path="gateway/gatewayclasses" element={<GatewayClasses />} />
            <Route path="gateway/httproutes" element={<HTTPRoutes />} />
            <Route path="gateway/grpcroutes" element={<GRPCRoutes />} />
            <Route path="gateway/referencegrants" element={<ReferenceGrants />} />
            <Route path="gpu/dashboard" element={<GPUDashboard />} />
            <Route path="gpu/nodes" element={<GPUNodes />} />
            <Route path="gpu/pods" element={<GPUPods />} />
            <Route path="gpu/deviceclasses" element={<DeviceClasses />} />
            <Route path="gpu/resourceclaims" element={<ResourceClaims />} />
            <Route path="gpu/resourceclaimtemplates" element={<ResourceClaimTemplates />} />
            <Route path="gpu/resourceslices" element={<ResourceSlices />} />
            <Route path="gateway/backendtlspolicies" element={<BackendTLSPolicies />} />
            <Route path="gateway/backendtrafficpolicies" element={<BackendTrafficPolicies />} />
            <Route path="security/serviceaccounts" element={<ServiceAccounts />} />
            <Route path="security/roles" element={<Roles />} />
            <Route path="security/clusterroles" element={<ClusterRoles />} />
            <Route path="security/rolebindings" element={<RoleBindings />} />
            <Route path="security/clusterrolebindings" element={<ClusterRoleBindings />} />
            <Route path="configuration/configmaps" element={<ConfigMaps />} />
            <Route path="configuration/secrets" element={<Secrets />} />
            <Route path="workloads/hpas" element={<HPAs />} />
            <Route path="workloads/vpas" element={<VPAs />} />
            <Route path="workloads/pdbs" element={<PDBs />} />
            <Route path="cluster/resourcequotas" element={<ResourceQuotas />} />
            <Route path="cluster/limitranges" element={<LimitRanges />} />
            <Route path="cluster/priorityclasses" element={<PriorityClasses />} />
            <Route path="cluster/runtimeclasses" element={<RuntimeClasses />} />
            <Route path="cluster/leases" element={<Leases />} />
            <Route path="cluster/mutatingwebhookconfigurations" element={<MutatingWebhookConfigurations />} />
            <Route path="cluster/validatingwebhookconfigurations" element={<ValidatingWebhookConfigurations />} />
            <Route path="custom-resources/instances" element={<CustomResourceInstances />} />
            <Route path="custom-resources/groups" element={<CustomResourceDefinitions />} />
            <Route path="monitoring" element={<Monitoring />} />
            <Route path="cluster-view" element={<ClusterView />} />
            <Route path="account" element={<Account />} />
            <Route path="resources/:namespace" element={<Resources />} />
            <Route path="topology/:namespace" element={<Topology />} />
            <Route path="network/:namespace" element={<NetworkPage />} />
            <Route path="ai-chat" element={<AIChat />} />
            <Route path="admin/users" element={<RequireAdmin><AdminUsers /></RequireAdmin>} />
            <Route path="admin/ai-models" element={<RequireAdmin><AdminAIModels /></RequireAdmin>} />
            <Route path="admin/node-shell" element={<RequireAdmin><AdminNodeShell /></RequireAdmin>} />
          </Route>
        </Routes>
      </BrowserRouter>
    </MonacoEditorLoaderInitializer>
  )
}

export default App
