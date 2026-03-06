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
import Account from './pages/Account'
import ComingSoon from './pages/ComingSoon'
import Pods from './pages/workloads/Pods'
import ClusterNodes from './pages/ClusterNodes'
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
            <Route path="cluster/search" element={<ComingSoon title="Advanced Search (Beta)" />} />
            <Route path="workloads/pods" element={<Pods />} />
            <Route path="workloads/deployments" element={<ComingSoon title="Deployments" />} />
            <Route path="workloads/statefulsets" element={<ComingSoon title="Stateful Sets" />} />
            <Route path="workloads/daemonsets" element={<ComingSoon title="Daemon Sets" />} />
            <Route path="workloads/replicasets" element={<ComingSoon title="Replica Sets" />} />
            <Route path="workloads/jobs" element={<ComingSoon title="Jobs" />} />
            <Route path="workloads/cronjobs" element={<ComingSoon title="CronJobs" />} />
            <Route path="storage" element={<Storage />} />
            <Route path="network/services" element={<ComingSoon title="Services" />} />
            <Route path="network/endpoints" element={<ComingSoon title="Endpoints" />} />
            <Route path="network/endpointslices" element={<ComingSoon title="Endpoint Slices" />} />
            <Route path="network/ingresses" element={<ComingSoon title="Ingresses" />} />
            <Route path="network/ingressclasses" element={<ComingSoon title="Ingress Classes" />} />
            <Route path="network/networkpolicies" element={<ComingSoon title="Network Policies" />} />
            <Route path="gateway/gateways" element={<ComingSoon title="Gateways" />} />
            <Route path="gateway/gatewayclasses" element={<ComingSoon title="Gateway Classes" />} />
            <Route path="gateway/httproutes" element={<ComingSoon title="HTTP Routes" />} />
            <Route path="gateway/grpcroutes" element={<ComingSoon title="GRPC Routes" />} />
            <Route path="gateway/referencegrants" element={<ComingSoon title="Reference Grants" />} />
            <Route path="gateway/backendtlspolicies" element={<ComingSoon title="Backend TLS Policies" />} />
            <Route path="gateway/backendtrafficpolicies" element={<ComingSoon title="Backend Traffic Policies" />} />
            <Route path="security/serviceaccounts" element={<ComingSoon title="Service Accounts" />} />
            <Route path="security/roles" element={<ComingSoon title="Roles" />} />
            <Route path="security/rolebindings" element={<ComingSoon title="Role Bindings" />} />
            <Route path="configuration/configmaps" element={<ComingSoon title="Config Maps" />} />
            <Route path="configuration/secrets" element={<ComingSoon title="Secrets" />} />
            <Route path="configuration/hpas" element={<ComingSoon title="Horizontal Pod Autoscalers" />} />
            <Route path="configuration/vpas" element={<ComingSoon title="Vertical Pod Autoscalers" />} />
            <Route path="configuration/pdbs" element={<ComingSoon title="Pod Disruption Budgets" />} />
            <Route path="configuration/resourcequotas" element={<ComingSoon title="Resource Quotas" />} />
            <Route path="configuration/limitranges" element={<ComingSoon title="Limit Ranges" />} />
            <Route path="configuration/priorityclasses" element={<ComingSoon title="Priority Classes" />} />
            <Route path="configuration/runtimeclasses" element={<ComingSoon title="Runtime Classes" />} />
            <Route path="configuration/leases" element={<ComingSoon title="Leases" />} />
            <Route path="configuration/mutatingwebhookconfigurations" element={<ComingSoon title="Mutating Webhook Configurations" />} />
            <Route path="configuration/validatingwebhookconfigurations" element={<ComingSoon title="Validating Webhook Configurations" />} />
            <Route path="custom-resources/instances" element={<ComingSoon title="Custom Resource Instances" />} />
            <Route path="custom-resources/groups" element={<ComingSoon title="Custom Resource Definitions" />} />
            <Route path="monitoring" element={<Monitoring />} />
            <Route path="cluster-view" element={<ClusterView />} />
            <Route path="account" element={<Account />} />
            <Route path="resources/:namespace" element={<Resources />} />
            <Route path="topology/:namespace" element={<Topology />} />
            <Route path="network/:namespace" element={<NetworkPage />} />
            <Route path="ai-chat" element={<AIChat />} />
            <Route path="admin/users" element={<RequireAdmin><AdminUsers /></RequireAdmin>} />
          </Route>
        </Routes>
      </BrowserRouter>
    </MonacoEditorLoaderInitializer>
  )
}

export default App
