import { Materials } from "./routes/Materials";
import { MaterialReview } from "./routes/MaterialReview";
import { Mistakes } from "./routes/Mistakes";
import { MistakeDetail } from "./routes/MistakeDetail";
import { Textbooks } from "./routes/admin/Textbooks";
import { TextbookReview } from "./routes/admin/TextbookReview";
import { Accounts } from "./routes/admin/Accounts";
import { Routes, Route, Navigate, Outlet } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth";
import { AppShell } from "./components/AppShell";
import { StatusPanel } from "./components/StatusPanel";
import { DesignPreview } from "./components/DesignPreview";
import { Login } from "./routes/Login";
import { Activate } from "./routes/Activate";
import { StudyEntry, RequireTextbook } from "./routes/StudyEntry";
import { Home } from "./routes/Home";
import { Study } from "./routes/Study";
import { TaskHistory } from "./routes/TaskHistory";
import { Profile } from "./routes/Profile";
function Layout() {
  const a = useAuth();
  if (a.loading)
    return <StatusPanel state="loading" title="正在读取学习账号" />;
  if (!a.session) return <Login />;
  return (
    <AppShell
      mode={a.session.actor.role}
      name={a.profile?.displayName ?? "管理员"}
      onLogout={() => void a.logout()}
    >
      <Outlet />
    </AppShell>
  );
}
export function App() {
  if (import.meta.env.DEV && window.location.pathname === "/ui-preview")
    return <DesignPreview />;
  return (
    <AuthProvider>
      <Routes>
        <Route path="/activate" element={<Activate />} />
        <Route path="/reset" element={<Activate />} />
        <Route element={<Layout />}>
          <Route
            index
            element={
              <RequireTextbook>
                <Home />
              </RequireTextbook>
            }
          />
          <Route path="/select" element={<StudyEntry />} />
          <Route path="/study/:id" element={<Study />} />
          <Route path="/history" element={<TaskHistory />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/materials" element={<Materials />} />
          <Route path="/materials/:id" element={<MaterialReview />} />
          <Route path="/mistakes" element={<Mistakes />} />
          <Route path="/mistakes/:id" element={<MistakeDetail />} />
          <Route path="/admin/textbooks" element={<Textbooks />} />
          <Route path="/admin/textbooks/:id" element={<TextbookReview />} />
          <Route path="/admin/accounts" element={<Accounts />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </AuthProvider>
  );
}
