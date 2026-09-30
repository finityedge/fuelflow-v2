import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Home } from '../pages/Home.js';
import { MyShifts } from '../pages/MyShifts.js';
import { Login } from '../pages/Login.js';
import { Register } from '../pages/Register.js';
import { Queue } from '../pages/Queue.js';
import { Upload } from '../pages/Upload.js';
import { ShiftReport } from '../pages/ShiftReport.js';
import { ShiftReports } from '../pages/ShiftReports.js';
import { TankLeakage } from '../pages/TankLeakage.js';
import { AttendantProfiles } from '../pages/AttendantProfiles.js';
import { FindingsSheet } from '../pages/FindingsSheet.js';
import { StationSettings } from '../pages/StationSettings.js';
import { ProtectedRoute } from './ProtectedRoute.js';
import { useAuthStore } from '../stores/authStore.js';
import { isAttendant } from '../lib/rbac.js';

/**
 * What `/` is depends on who is signed in.
 *
 * An attendant has no use for the dashboard: it counts reports waiting to be reviewed, and the
 * money a station is short across every colleague's shift. That is a manager's work list, and
 * there is nothing on it the person at the pump can act on. The question an attendant does
 * arrive with — how did my own shifts come out — had no screen at all, so `/` draws their own
 * record for them rather than putting it behind a nav row they would have to be told about.
 *
 * The dispatch is here rather than inside either page so that reading the router is enough to
 * know what an attendant lands on. Both pages are imported statically like every other route in
 * this file: the bundle is one file already, and a lazy split for a two-way branch would add a
 * loading state between sign-in and the first screen for no gain.
 */
function HomeRoute() {
  const user = useAuthStore((state) => state.user);
  return user && isAttendant(user.role) ? <MyShifts /> : <Home />;
}

export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <HomeRoute />
            </ProtectedRoute>
          }
        />
        <Route
          path="/upload"
          element={
            <ProtectedRoute allowedRoles={['OWNER', 'MANAGER']}>
              <Upload />
            </ProtectedRoute>
          }
        />
        {/* Declared before the :id route so "recent" is never read as a report id —
            Layout and Home both link here. */}
        <Route
          path="/shift-reports/recent"
          element={
            <ProtectedRoute>
              <ShiftReports />
            </ProtectedRoute>
          }
        />
        {/* `/review` rather than `/shift-reports/review` for the same reason, and because the
            queue is a place a manager works from rather than a view of the history. */}
        <Route
          path="/review"
          element={
            <ProtectedRoute allowedRoles={['OWNER', 'MANAGER']}>
              <Queue />
            </ProtectedRoute>
          }
        />
        {/* The fuel half of the same question the dashboard asks about money. Behind the same
            role gate as the review queue, because acting on a leak means correcting the shift
            that recorded it, and that is what the gate is standing in front of. */}
        <Route
          path="/tanks"
          element={
            <ProtectedRoute allowedRoles={['OWNER', 'MANAGER']}>
              <TankLeakage />
            </ProtectedRoute>
          }
        />
        {/* The money half of the same question, and the last screen behind this gate that is
            not a report. It names people, so it is behind the role gate for a stronger reason
            than the others: the list is every colleague's, and reading it is not something the
            people on it can consent to. */}
        <Route
          path="/attendants"
          element={
            <ProtectedRoute allowedRoles={['OWNER', 'MANAGER']}>
              <AttendantProfiles />
            </ProtectedRoute>
          }
        />
        {/* The document, rather than a sixth screen to work from. It is gated exactly as its
            three sources are — the money, the fuel and the names — because it carries all of
            them at once and, unlike them, it is built to be printed and handed over. */}
        <Route
          path="/findings"
          element={
            <ProtectedRoute allowedRoles={['OWNER', 'MANAGER']}>
              <FindingsSheet />
            </ProtectedRoute>
          }
        />
        {/* Where a station's own vocabulary is set up — the keys its reports are read against.
            Behind the OWNER/MANAGER gate because it edits rather than reads, and because the
            only person with a reason to be here is one who runs the station. */}
        <Route
          path="/settings"
          element={
            <ProtectedRoute allowedRoles={['OWNER', 'MANAGER']}>
              <StationSettings />
            </ProtectedRoute>
          }
        />
        <Route
          path="/shift-reports/:id"
          element={
            <ProtectedRoute>
              <ShiftReport />
            </ProtectedRoute>
          }
        />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
      </Routes>
    </BrowserRouter>
  );
}
