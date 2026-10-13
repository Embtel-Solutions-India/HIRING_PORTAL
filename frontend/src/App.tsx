import { useEffect, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { Logo } from "./components/ui";
import { useCurrentUser, useStore } from "./data/store";
import { can, type Permission } from "./lib/permissions";
import BookingPage from "./pages/BookingPage";
import CandidateDetail from "./pages/CandidateDetail";
import Candidates from "./pages/Candidates";
import Dashboard from "./pages/Dashboard";
import Email from "./pages/Email";
import Interviews from "./pages/Interviews";
import Jobs from "./pages/Jobs";
import Login from "./pages/Login";
import Pipeline from "./pages/Pipeline";
import Review from "./pages/Review";
import Settings from "./pages/Settings";
import Team from "./pages/Team";

function Splash() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <span className="animate-pulse">
        <Logo />
      </span>
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const status = useStore((s) => s.status);
  const init = useStore((s) => s.init);
  const startSync = useStore((s) => s.startSync);
  const location = useLocation();

  useEffect(() => {
    if (status === "loading") void init();
  }, [status, init]);
  useEffect(() => (status === "ready" ? startSync() : undefined), [status, startSync]);

  if (status === "loading") return <Splash />;
  if (status === "anonymous") return <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return <>{children}</>;
}

function RequirePermission({ permission, children }: { permission: Permission; children: ReactNode }) {
  const user = useCurrentUser();
  if (!user || !can(user.role, permission)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      {/* Public, candidate-facing booking page (Calendly-style) */}
      <Route path="/book/:slug" element={<BookingPage />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="pipeline" element={<Pipeline />} />
        <Route path="candidates" element={<Candidates />} />
        <Route path="candidates/:id" element={<CandidateDetail />} />
        <Route path="review" element={<Review />} />
        <Route path="interviews" element={<Interviews />} />
        <Route
          path="email"
          element={
            <RequirePermission permission="emails.sendSingle">
              <Email />
            </RequirePermission>
          }
        />
        <Route path="jobs" element={<Jobs />} />
        <Route
          path="team"
          element={
            <RequirePermission permission="users.view">
              <Team />
            </RequirePermission>
          }
        />
        <Route
          path="settings"
          element={
            <RequirePermission permission="sources.manage">
              <Settings />
            </RequirePermission>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
