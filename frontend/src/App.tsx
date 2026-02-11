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
import Login from './pages/Login'
import AdminUsers from './pages/AdminUsers'
import Account from './pages/Account'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<RequireAuth><Layout /></RequireAuth>}>
          <Route index element={<Dashboard />} />
          <Route path="namespaces" element={<Namespaces />} />
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
  )
}

export default App
