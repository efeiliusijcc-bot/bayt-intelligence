import { lazy, Suspense } from "react";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth";
import { AppLayout } from "./components/AppLayout";
import { LoadingState } from "./components/PageStates";
import { LoginPage } from "./pages/LoginPage";

const DashboardPage = lazy(() => import("./pages/DashboardPage").then((module) => ({ default: module.DashboardPage })));
const PeoplePage = lazy(() => import("./pages/PeoplePage").then((module) => ({ default: module.PeoplePage })));
const PersonDetailPage = lazy(() => import("./pages/PersonDetailPage").then((module) => ({ default: module.PersonDetailPage })));
const ImportsPage = lazy(() => import("./pages/ImportsPage").then((module) => ({ default: module.ImportsPage })));
const ImportBatchPage = lazy(() => import("./pages/ImportsPage").then((module) => ({ default: module.ImportBatchPage })));
const ResearchPage = lazy(() => import("./pages/ResearchPage").then((module) => ({ default: module.ResearchPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const CollectorPage = lazy(() => import("./pages/CollectorPage").then((module) => ({ default: module.CollectorPage })));
const CollectorJobDetailPage = lazy(() => import("./pages/CollectorJobDetailPage").then((module) => ({ default: module.CollectorJobDetailPage })));

function RequireAuth() {
  const { session, loading } = useAuth();
  const location = useLocation();
  if (loading) return <LoadingState label="正在恢复登录会话" />;
  if (!session) return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}${location.hash}` }} />;
  return <Outlet />;
}

export function App() {
  return (
    <AuthProvider>
    <Suspense fallback={<LoadingState label="正在加载页面" />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireAuth />}>
        <Route element={<AppLayout />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/people" element={<PeoplePage />} />
          <Route path="/people/:cvId" element={<PersonDetailPage />} />
          <Route path="/imports" element={<ImportsPage />} />
          <Route path="/imports/:batchId" element={<ImportBatchPage />} />
          <Route path="/collector" element={<CollectorPage />} />
          <Route path="/collector/jobs/:jobId" element={<CollectorJobDetailPage />} />
          <Route path="/research" element={<ResearchPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>
        </Route>
      </Routes>
    </Suspense>
    </AuthProvider>
  );
}
