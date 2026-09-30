import { useState, type FormEvent } from "react";
import {
  Alert24Regular,
  CloudArrowDown24Regular,
  Home24Regular,
  PanelLeftContract24Regular,
  PanelLeftExpand24Regular,
  PeopleTeam24Regular,
  PersonCircle24Regular,
  Search24Regular,
  Settings24Regular,
  ShieldCheckmark24Regular,
} from "@fluentui/react-icons";
import { Button, Input, Tooltip } from "@fluentui/react-components";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";

const navItems = [
  { to: "/dashboard", label: "总览", icon: Home24Regular },
  { to: "/collector", label: "采集任务", icon: CloudArrowDown24Regular },
  { to: "/people", label: "人物库", icon: PeopleTeam24Regular },
  { to: "/research", label: "人工复核", icon: ShieldCheckmark24Regular },
  { to: "/settings", label: "系统设置", icon: Settings24Regular },
];

const pageNames: Record<string, string> = {
  dashboard: "总览",
  people: "人物库",
  research: "人工复核",
  imports: "导入任务",
  collector: "采集任务",
  settings: "系统设置",
};

export function AppLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const [globalSearch, setGlobalSearch] = useState("");
  const [logoutError, setLogoutError] = useState("");
  const { session, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const rootPath = location.pathname.split("/")[1] || "dashboard";

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    const query = globalSearch.trim();
    navigate(query ? `/people?q=${encodeURIComponent(query)}` : "/people");
  };

  return (
    <div className={`app-shell ${collapsed ? "is-collapsed" : ""}`}>
      <aside className="sidebar" aria-label="主导航">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">BI</div>
          {!collapsed && (
            <div className="brand-copy">
              <strong>Bayt Intelligence</strong>
              <span>人才数据管理平台</span>
            </div>
          )}
        </div>
        <nav className="nav-list">
          {navItems.map((item) => {
            const Icon = item.icon;
            const link = (
              <NavLink key={item.to} to={item.to} className={({ isActive }) => `nav-item ${isActive ? "is-active" : ""}`}>
                <Icon aria-hidden="true" />
                {!collapsed && <span>{item.label}</span>}
              </NavLink>
            );
            return collapsed ? (
              <Tooltip key={item.to} content={item.label} relationship="label" positioning="after">
                {link}
              </Tooltip>
            ) : link;
          })}
        </nav>
        <div className="sidebar-footer">
          <div className="user-block">
            <PersonCircle24Regular aria-hidden="true" />
            {!collapsed && <div><strong>{session?.user || "本站用户"}</strong><span>已登录 · 7 天会话</span></div>}
          </div>
          {!collapsed && <Button appearance="subtle" className="logout-button" onClick={async () => {
            setLogoutError("");
            try { await logout(); navigate("/login", { replace: true }); }
            catch { setLogoutError("退出失败，请重试"); }
          }}>退出登录</Button>}
          {logoutError && !collapsed && <span className="logout-error" role="alert">{logoutError}</span>}
          <Tooltip content={collapsed ? "展开导航" : "收起导航"} relationship="label">
            <Button
              appearance="subtle"
              className="collapse-button"
              icon={collapsed ? <PanelLeftExpand24Regular /> : <PanelLeftContract24Regular />}
              aria-label={collapsed ? "展开导航" : "收起导航"}
              onClick={() => setCollapsed((value) => !value)}
            />
          </Tooltip>
        </div>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <div className="breadcrumb-title">
            <span>人才数据中心</span>
            <strong>{pageNames[rootPath] || "人物详情"}</strong>
          </div>
          <form className="global-search" onSubmit={submitSearch} role="search">
            <Input
              value={globalSearch}
              onChange={(_, data) => setGlobalSearch(data.value)}
              contentBefore={<Search24Regular />}
              placeholder="搜索姓名、CV_ID、机构、职位或技能"
              aria-label="全局搜索"
            />
          </form>
          <div className="topbar-actions">
            <span className="system-state"><span aria-hidden="true" />数据服务正常</span>
            <Tooltip content="当前没有后台任务通知" relationship="label">
              <Button appearance="subtle" icon={<Alert24Regular />} aria-label="任务通知" />
            </Tooltip>
          </div>
        </header>
        <main className={`page-content ${rootPath === "dashboard" ? "dashboard-content" : ""}`}><Outlet /></main>
      </div>
    </div>
  );
}
