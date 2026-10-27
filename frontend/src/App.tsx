import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Routes, Route, useParams } from 'react-router-dom'
import Layout from './components/Layout'
import RequireAuth from './components/RequireAuth'
import RequireAdmin from './components/RequireAdmin'
import AIGate from './components/AIGate'
import RouteFallback from './components/RouteFallback'
import Login from './pages/Login'
import { ClusterProvider } from './contexts/ClusterProvider'
import ConfirmProvider from './components/ConfirmProvider'
import { PageContextProvider } from './components/PageContextProvider'

// Every page is its own chunk, fetched on first navigation. Login stays in the
// entry chunk because it is the first screen.
const Setup = lazy(() => import('./pages/Setup'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Namespaces = lazy(() => import('./pages/Namespaces'))
const ResourceGraph = lazy(() => import('./pages/ResourceGraph'))
const Timeline = lazy(() => import('./pages/Timeline'))
const AIChat = lazy(() => import('./pages/AIChat'))
const ClusterView = lazy(() => import('./pages/ClusterView'))
const Monitoring = lazy(() => import('./pages/Monitoring'))
const Cost = lazy(() => import('./pages/Cost'))
const PolicyReports = lazy(() => import('./pages/security/PolicyReports'))
const Storage = lazy(() => import('./pages/Storage'))
const AdminUsers = lazy(() => import('./pages/AdminUsers'))
const AdminAIModels = lazy(() => import('./pages/AdminAIModels'))
const AdminAudit = lazy(() => import('./pages/AdminAudit'))
const AdminAIUsage = lazy(() => import('./pages/AdminAIUsage'))
const AdminNodeShell = lazy(() => import('./pages/AdminNodeShell'))
const AdminClusters = lazy(() => import('./pages/admin/Clusters'))
const AdminOrganizations = lazy(() => import('./pages/AdminOrganizations'))
const AdminRoles = lazy(() => import('./pages/AdminRoles'))
const AdminAccessRequests = lazy(() => import('./pages/admin/AccessRequests'))
const AdminAccessReview = lazy(() => import('./pages/admin/AccessReview'))
const AdminClusterHygiene = lazy(() => import('./pages/admin/ClusterHygiene'))
const AdminSessionRecordings = lazy(() => import('./pages/admin/SessionRecordings'))
const AdminInvestigations = lazy(() => import('./pages/admin/Investigations'))
const AlertInbox = lazy(() => import('./pages/alerts/AlertInbox'))
const Account = lazy(() => import('./pages/Account'))
const HPAs = lazy(() => import('./pages/workloads/HPAs'))
const VPAs = lazy(() => import('./pages/workloads/VPAs'))
const PDBs = lazy(() => import('./pages/workloads/PDBs'))
const AdvancedSearch = lazy(() => import('./pages/AdvancedSearch'))
const Pods = lazy(() => import('./pages/workloads/Pods'))
const Deployments = lazy(() => import('./pages/workloads/Deployments'))
const StatefulSets = lazy(() => import('./pages/workloads/StatefulSets'))
const DaemonSets = lazy(() => import('./pages/workloads/DaemonSets'))
const Jobs = lazy(() => import('./pages/workloads/Jobs'))
const ReplicaSets = lazy(() => import('./pages/workloads/ReplicaSets'))
const CronJobs = lazy(() => import('./pages/workloads/CronJobs'))
const ClusterNodes = lazy(() => import('./pages/ClusterNodes'))
const Services = lazy(() => import('./pages/network/Services'))
const Endpoints = lazy(() => import('./pages/network/Endpoints'))
const EndpointSlices = lazy(() => import('./pages/network/EndpointSlices'))
const Ingresses = lazy(() => import('./pages/network/Ingresses'))
const IngressClasses = lazy(() => import('./pages/network/IngressClasses'))
const NetworkPolicies = lazy(() => import('./pages/network/NetworkPolicies'))
const Gateways = lazy(() => import('./pages/gateway/Gateways'))
const GatewayClasses = lazy(() => import('./pages/gateway/GatewayClasses'))
const HTTPRoutes = lazy(() => import('./pages/gateway/HTTPRoutes'))
const GRPCRoutes = lazy(() => import('./pages/gateway/GRPCRoutes'))
const ReferenceGrants = lazy(() => import('./pages/gateway/ReferenceGrants'))
const BackendTLSPolicies = lazy(() => import('./pages/gateway/BackendTLSPolicies'))
const GatewayPolicies = lazy(() => import('./pages/gateway/Policies'))
const GPUDashboard = lazy(() => import('./pages/gpu/GPUDashboard'))
const GPUNodes = lazy(() => import('./pages/gpu/GPUNodes'))
const GPUPods = lazy(() => import('./pages/gpu/GPUPods'))
const DeviceClasses = lazy(() => import('./pages/gpu/DeviceClasses'))
const ResourceClaims = lazy(() => import('./pages/gpu/ResourceClaims'))
const ResourceClaimTemplates = lazy(() => import('./pages/gpu/ResourceClaimTemplates'))
const ResourceSlices = lazy(() => import('./pages/gpu/ResourceSlices'))
const ServiceAccounts = lazy(() => import('./pages/security/ServiceAccounts'))
const NotFound = lazy(() => import('./pages/NotFound'))
const Roles = lazy(() => import('./pages/security/Roles'))
const RoleBindings = lazy(() => import('./pages/security/RoleBindings'))
const ClusterRoles = lazy(() => import('./pages/security/ClusterRoles'))
const ClusterRoleBindings = lazy(() => import('./pages/security/ClusterRoleBindings'))
const ConfigMaps = lazy(() => import('./pages/configuration/ConfigMaps'))
const Secrets = lazy(() => import('./pages/configuration/Secrets'))
const PriorityClasses = lazy(() => import('./pages/cluster/PriorityClasses'))
const RuntimeClasses = lazy(() => import('./pages/cluster/RuntimeClasses'))
const Leases = lazy(() => import('./pages/cluster/Leases'))
const ResourceQuotas = lazy(() => import('./pages/cluster/ResourceQuotas'))
const LimitRanges = lazy(() => import('./pages/cluster/LimitRanges'))
const MutatingWebhookConfigurations = lazy(() => import('./pages/cluster/MutatingWebhookConfigurations'))
const ValidatingWebhookConfigurations = lazy(() => import('./pages/cluster/ValidatingWebhookConfigurations'))
const ValidatingAdmissionPolicies = lazy(() => import('./pages/cluster/ValidatingAdmissionPolicies'))
const MutatingAdmissionPolicies = lazy(() => import('./pages/cluster/MutatingAdmissionPolicies'))
const CustomResourceDefinitions = lazy(() => import('./pages/custom-resources/CustomResourceDefinitions'))
const CustomResourceInstances = lazy(() => import('./pages/custom-resources/CustomResourceInstances'))
const HelmReleasesPage = lazy(() => import('./pages/helm/Releases'))
const HelmReleaseDetailPage = lazy(() => import('./pages/helm/ReleaseDetail'))

// The old per-namespace topology screen: its links open the Resource Graph on that namespace.
function TopologyRedirect() {
  const { namespace = '' } = useParams()
  return <Navigate to={`/cluster/resource-graph?namespace=${encodeURIComponent(namespace)}`} replace />
}

function App() {
  // The confirm window sits under the page context too, so the floating chat can read which confirmation is open.
  return (
    <BrowserRouter>
      <PageContextProvider>
      <ConfirmProvider>
      <ClusterProvider>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
          <Route path="/setup" element={<RequireAuth><RequireAdmin page="/setup"><Setup /></RequireAdmin></RequireAuth>} />
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<RequireAuth><Layout /></RequireAuth>}>
            <Route index element={<Dashboard />} />
            <Route path="namespaces" element={<Navigate to="/cluster/namespaces" replace />} />
            <Route path="cluster/namespaces" element={<Namespaces />} />
            <Route path="cluster/resource-graph" element={<ResourceGraph />} />
            <Route path="timeline" element={<Timeline />} />
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
            <Route path="gateway/policies" element={<GatewayPolicies />} />
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
            <Route path="cluster/validatingadmissionpolicies" element={<ValidatingAdmissionPolicies />} />
            <Route path="cluster/mutatingadmissionpolicies" element={<MutatingAdmissionPolicies />} />
            <Route path="custom-resources/instances" element={<CustomResourceInstances />} />
            <Route path="custom-resources/groups" element={<CustomResourceDefinitions />} />
            <Route path="helm/releases" element={<HelmReleasesPage />} />
            <Route path="helm/releases/:namespace/:name" element={<HelmReleaseDetailPage />} />
            <Route path="monitoring" element={<Monitoring />} />
            <Route path="alerts" element={<AIGate><AlertInbox /></AIGate>} />
            <Route path="cost" element={<Cost />} />
            <Route path="security/policyreports" element={<PolicyReports />} />
            <Route path="cluster-view" element={<ClusterView />} />
            <Route path="account" element={<Account />} />
            <Route path="resources/:namespace" element={<Navigate to="/workloads/pods" replace />} />
            <Route path="topology/:namespace" element={<TopologyRedirect />} />
            <Route path="network/:namespace" element={<Navigate to="/network/services" replace />} />
            <Route path="ai-chat" element={<AIGate><AIChat /></AIGate>} />
            <Route path="admin/clusters" element={<RequireAdmin page="/admin/clusters"><AdminClusters /></RequireAdmin>} />
            <Route path="admin/users" element={<RequireAdmin page="/admin/users"><AdminUsers /></RequireAdmin>} />
            <Route path="admin/ai-models" element={<RequireAdmin page="/admin/ai-models"><AIGate><AdminAIModels /></AIGate></RequireAdmin>} />
            <Route path="admin/audit" element={<RequireAdmin page="/admin/audit"><AdminAudit /></RequireAdmin>} />
            <Route path="admin/ai-usage" element={<RequireAdmin page="/admin/ai-usage"><AIGate><AdminAIUsage /></AIGate></RequireAdmin>} />
            <Route path="admin/node-shell" element={<RequireAdmin page="/admin/node-shell"><AdminNodeShell /></RequireAdmin>} />
            <Route path="admin/organizations" element={<RequireAdmin page="/admin/organizations"><AdminOrganizations /></RequireAdmin>} />
            <Route path="admin/roles" element={<RequireAdmin page="/admin/roles"><AdminRoles /></RequireAdmin>} />
            <Route path="admin/access-requests" element={<RequireAdmin page="/admin/access-requests"><AdminAccessRequests /></RequireAdmin>} />
            <Route path="admin/access-review" element={<RequireAdmin page="/admin/access-review"><AdminAccessReview /></RequireAdmin>} />
            <Route path="admin/cluster-hygiene" element={<RequireAdmin page="/admin/cluster-hygiene"><AdminClusterHygiene /></RequireAdmin>} />
            <Route path="admin/session-recordings" element={<RequireAdmin page="/admin/session-recordings"><AdminSessionRecordings /></RequireAdmin>} />
            <Route path="admin/investigations" element={<RequireAdmin page="/admin/investigations"><AIGate><AdminInvestigations /></AIGate></RequireAdmin>} />
            <Route path="*" element={<NotFound />} />
          </Route>
          </Routes>
        </Suspense>
      </ClusterProvider>
      </ConfirmProvider>
      </PageContextProvider>
    </BrowserRouter>
  )
}

export default App
