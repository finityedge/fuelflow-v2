import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Home } from '../pages/Home.js';
import { Login } from '../pages/Login.js';
import { Register } from '../pages/Register.js';
import { Upload } from '../pages/Upload.js';
import { ShiftReport } from '../pages/ShiftReport.js';
import { ShiftReports } from '../pages/ShiftReports.js';
import { ProtectedRoute } from './ProtectedRoute.js';

export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Home />
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
