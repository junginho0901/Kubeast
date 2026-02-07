import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import RequireAuth from './components/RequireAuth'
import Dashboard from './pages/Dashboard'
import Namespaces from './pages/Namespaces'
import Resources from './pages/Resources'
import Topology from './pages/Topology'
import AIChat from './pages/AIChat'
import ClusterView from './pages/ClusterView'
import Monitoring from './pages/Monitoring'
import Login from './pages/Login'

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
          <Route path="resources/:namespace" element={<Resources />} />
          <Route path="topology/:namespace" element={<Topology />} />
          <Route path="ai-chat" element={<AIChat />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
