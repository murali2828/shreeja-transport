// frontend/src/App.jsx
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'react-hot-toast';
import { useAuth } from './hooks/useAuth';

import Layout          from './components/Layout';
import Login           from './pages/Login';
import ForgotPassword  from './pages/auth/ForgotPassword';
import ResetPassword   from './pages/auth/ResetPassword';
import ChangePassword  from './pages/auth/ChangePassword';
import Dashboard       from './pages/Dashboard';

// Masters
import TankerMaster    from './pages/masters/TankerMaster';
import BmcuMaster      from './pages/masters/BmcuMaster';
import RouteMaster     from './pages/masters/RouteMaster';
import LocationMasters from './pages/masters/LocationMasters';
import UserManagement  from './pages/masters/UserManagement';
import EmailConfig     from './pages/masters/EmailConfig';
import PlanEmailConfig from './pages/masters/PlanEmailConfig';
import DistanceMaster  from './pages/masters/DistanceMaster';

// Planning
import TripPlanList    from './pages/planning/TripPlanList';
import TripPlanForm    from './pages/planning/TripPlanForm';
import RouteOptimizer  from './pages/planning/RouteOptimizer';

// Execution
import ExecutionList        from './pages/execution/ExecutionList';
import ExecutionForm        from './pages/execution/ExecutionForm';
import AcknowledgementForm  from './pages/execution/AcknowledgementForm';
import ClosedTrips          from './pages/execution/ClosedTrips';

// Reports
import DailyTSReport   from './pages/reports/DailyTSReport';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } }
});

// ─── Role-based Route Guard ───────────────────────────────────────────────────
function ProtectedRoute({ children, roles, allowMustChange }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="flex items-center justify-center h-screen text-gray-400">Loading…</div>;
  if (!user)   return <Navigate to="/login" replace />;
  // Force password change before accessing any other page
  if (user.must_change_password && !allowMustChange) return <Navigate to="/change-password" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return children;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login"           element={<Login/>}/>
      <Route path="/forgot-password" element={<ForgotPassword/>}/>
      <Route path="/reset-password"  element={<ResetPassword/>}/>
      <Route path="/change-password" element={
        <ProtectedRoute allowMustChange><ChangePassword/></ProtectedRoute>
      }/>

      {/* All protected routes inside Layout */}
      <Route path="/" element={
        <ProtectedRoute><Layout/></ProtectedRoute>
      }>
        <Route index element={<Dashboard/>}/>

        {/* Masters — admin + planner */}
        <Route path="masters/tankers" element={
          <ProtectedRoute roles={['admin','planner']}><TankerMaster/></ProtectedRoute>
        }/>
        <Route path="masters/bmcus" element={
          <ProtectedRoute roles={['admin','planner']}><BmcuMaster/></ProtectedRoute>
        }/>
        <Route path="masters/routes" element={
          <ProtectedRoute roles={['admin','planner']}><RouteMaster/></ProtectedRoute>
        }/>
        <Route path="masters/locations" element={
          <ProtectedRoute roles={['admin','planner']}><LocationMasters/></ProtectedRoute>
        }/>
        <Route path="masters/distances" element={
          <ProtectedRoute roles={['admin','planner']}><DistanceMaster/></ProtectedRoute>
        }/>
        <Route path="masters/users" element={
          <ProtectedRoute roles={['admin']}><UserManagement/></ProtectedRoute>
        }/>
        <Route path="masters/email-config" element={
          <ProtectedRoute roles={['admin']}><EmailConfig/></ProtectedRoute>
        }/>
        <Route path="masters/plan-emails" element={
          <ProtectedRoute roles={['admin']}><PlanEmailConfig/></ProtectedRoute>
        }/>

        {/* Planning — admin + planner */}
        <Route path="planning" element={
          <ProtectedRoute roles={['admin','planner']}><TripPlanList/></ProtectedRoute>
        }/>
        <Route path="planning/new" element={
          <ProtectedRoute roles={['admin','planner']}><TripPlanForm/></ProtectedRoute>
        }/>
        <Route path="planning/:id/edit" element={
          <ProtectedRoute roles={['admin','planner']}><TripPlanForm/></ProtectedRoute>
        }/>
        <Route path="planning/optimize" element={
          <ProtectedRoute roles={['admin','planner']}><RouteOptimizer/></ProtectedRoute>
        }/>

        {/* Execution — all roles */}
        <Route path="execution"           element={<ExecutionList/>}/>
        <Route path="execution/closed"    element={<ClosedTrips/>}/>
        <Route path="execution/:id"       element={<ExecutionForm/>}/>
        <Route path="execution/:id/acknowledge" element={<AcknowledgementForm/>}/>

        {/* Reports — all roles */}
        <Route path="reports" element={<DailyTSReport/>}/>
      </Route>

      <Route path="*" element={<Navigate to="/" replace/>}/>
    </Routes>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppRoutes/>
        <Toaster
          position="top-right"
          toastOptions={{
            duration: 4000,
            style: { fontSize: '14px', maxWidth: '400px' }
          }}
        />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
