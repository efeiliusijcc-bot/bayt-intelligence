import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "./components/AppLayout";
import { LoadingState } from "./components/PageStates";

const DashboardPage = lazy(() => import("./pages/DashboardPage").then((module) => ({ default: module.DashboardPage })));
const PeoplePage = lazy(() => import("./pages/PeoplePage").then((module) => ({ default: module.PeoplePage })));
const PersonDetailPage = lazy(() => import("./pages/PersonDetailPage").then((module) => ({ default: module.PersonDetailPage })));
const ImportsPage = lazy(() => import("./pages/ImportsPage").then((module) => ({ default: module.ImportsPage })));
const ImportBatchPage = lazy(() => import("./pages/ImportsPage").then((module) => ({ default: module.ImportBatchPage })));
const ResearchPage = lazy(() => import("./pages/ResearchPage").then((module) => ({ default: module.ResearchPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const CollectorPage = lazy(() => import("./pages/CollectorPage").then((module) => ({ default: module.CollectorPage })));

export function App() {
  return (
    <Suspense fallback={<LoadingState label="正在加载页面" />}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/people" element={<PeoplePage />} />
          <Route path="/people/:cvId" element={<PersonDetailPage />} />
          <Route path="/imports" element={<ImportsPage />} />
          <Route path="/imports/:batchId" element={<ImportBatchPage />} />
          <Route path="/collector" element={<CollectorPage />} />
          <Route path="/research" element={<ResearchPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
