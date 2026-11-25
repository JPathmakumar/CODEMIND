
import {
  BrowserRouter,
  Routes,
  Route,
  NavLink,
} from "react-router-dom";

import {
  LayoutDashboard,
  FolderGit2,
  Network,
  MessageSquare,
  Settings,
  BrainCircuit,
  Search,
  Bell,
} from "lucide-react";

import Repositories from "./pages/Repositories";
import CodeExplorer from "./pages/CodeExplorer";

function Dashboard() {
  return (
    <section className="dashboard-content">
      <div className="welcome-section">
        <div>
          <p className="eyebrow">YOUR WORKSPACE</p>
          <h1>Welcome to CODEMIND.</h1>
          <p className="welcome-description">
            Understand your codebase. Build smarter.
          </p>
        </div>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <span>Total repositories</span>
          <strong>0</strong>
          <small>Your connected projects</small>
        </div>

        <div className="stat-card">
          <span>Files analyzed</span>
          <strong>0</strong>
          <small>Files indexed by CODEMIND</small>
        </div>

        <div className="stat-card">
          <span>AI conversations</span>
          <strong>0</strong>
          <small>Your AI sessions</small>
        </div>
      </div>

      <section className="projects-section">
        <div className="section-heading">
          <h2>Recent repositories</h2>
          <p>Your recently connected codebases.</p>
        </div>

        <div className="empty-state">
          <div className="empty-icon">
            <FolderGit2 size={28} />
          </div>

          <h3>No repositories yet</h3>

          <p>
            Connect your first repository to start exploring
            your codebase with AI.
          </p>
        </div>
      </section>
    </section>
  );
}

function AppLayout() {
  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="logo">
          <BrainCircuit size={25} />
          <span>CODEMIND</span>
        </div>

        <nav className="navigation">
          <p className="nav-label">WORKSPACE</p>

          <NavLink to="/" end className={({ isActive }) =>
            `nav-item ${isActive ? "active" : ""}`
          }>
            <LayoutDashboard size={18} />
            Dashboard
          </NavLink>

          <NavLink to="/repositories" className={({ isActive }) =>
            `nav-item ${isActive ? "active" : ""}`
          }>
            <FolderGit2 size={18} />
            Repositories
          </NavLink>

          <NavLink to="/architecture" className={({ isActive }) =>
            `nav-item ${isActive ? "active" : ""}`
          }>
            <Network size={18} />
            Architecture
          </NavLink>

          <NavLink to="/assistant" className={({ isActive }) =>
            `nav-item ${isActive ? "active" : ""}`
          }>
            <MessageSquare size={18} />
            AI Assistant
          </NavLink>

          <p className="nav-label settings-label">PREFERENCES</p>

          <NavLink to="/settings" className={({ isActive }) =>
            `nav-item ${isActive ? "active" : ""}`
          }>
            <Settings size={18} />
            Settings
          </NavLink>
        </nav>

        <NavLink to="/explorer" className={({ isActive }) =>
  `nav-item ${isActive ? "active" : ""}`
}>
  <BrainCircuit size={18} />
  Code Explorer
</NavLink>

        <div className="sidebar-footer">
          <div className="avatar">JD</div>
          <div>
            <strong>Developer</strong>
            <span>Free workspace</span>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <span>/</span> CODEMIND
          </div>

          <div className="topbar-actions">
            <button className="icon-button" aria-label="Search">
              <Search size={19} />
            </button>

            <button className="icon-button" aria-label="Notifications">
              <Bell size={19} />
            </button>
          </div>
        </header>

        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/repositories" element={<Repositories />} />
          <Route path="/explorer" element={<CodeExplorer />} />
          <Route path="/architecture" element={<h1 className="dashboard-content">Architecture — Coming soon</h1>} />
          <Route path="/assistant" element={<h1 className="dashboard-content">AI Assistant — Coming soon</h1>} />
          <Route path="/settings" element={<h1 className="dashboard-content">Settings — Coming soon</h1>} />
          <Route path="*" element={<h1 className="dashboard-content">Page not found</h1>} />
        </Routes>
      </main>
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AppLayout />
    </BrowserRouter>
  );
}

export default App;
