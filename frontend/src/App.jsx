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
import VendorMaster    from './pages/masters/VendorMaster';
import TankerDocuments from './pages/masters/TankerDocuments';

// Planning
import TripPlanList    from './pages/planning/TripPlanList';
import TripPlanForm    from './pages/planning/TripPlanForm';
import DeletedPlansList from './pages/planning/DeletedPlansList';
import RouteOptimizer  from './pages/planning/RouteOptimizer';

// Execution
import ExecutionList        from './pages/execution/ExecutionList';
import ExecutionForm        from './pages/execution/ExecutionForm';
import AcknowledgementForm  from './pages/execution/AcknowledgementForm';
import ClosedTrips          from './pages/execution/ClosedTrips';
import Approvals            from './pages/execution/Approvals';
import NonTripGatePass      from './pages/execution/NonTripGatePass';
import TankerPosition       from './pages/execution/TankerPosition';

// Reports
import DailyTSReport   from './pages/reports/DailyTSReport';
import Analytics       from './pages/reports/Analytics';
import TankerRates     from './pages/masters/TankerRates';
import TankerBilling   from './pages/billing/TankerBilling';
import BillingDecision from './pages/billing/BillingDecision';
import AuditLog        from './pages/reports/AuditLog';
import BmcuBreakup     from './pages/reports/BmcuBreakup';
import TripDurations   from './pages/reports/TripDurations';
import DayUtilisation  from './pages/reports/DayUtilisation';

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
      <Route path="/billing-decision" element={<BillingDecision/>}/>
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
        <Route path="masters/tanker-rates" element={
          <ProtectedRoute roles={['admin','planner','viewer']}><TankerRates/></ProtectedRoute>
        }/>
        <Route path="masters/distances" element={
          <ProtectedRoute roles={['admin','planner']}><DistanceMaster/></ProtectedRoute>
        }/>
        <Route path="masters/vendors" element={
          <ProtectedRoute roles={['admin','planner']}><VendorMaster/></ProtectedRoute>
        }/>
        <Route path="masters/documents" element={
          <ProtectedRoute roles={['admin','planner','executor']}><TankerDocuments/></ProtectedRoute>
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
        <Route path="planning/deleted" element={
          <ProtectedRoute roles={['admin','planner']}><DeletedPlansList/></ProtectedRoute>
        }/>
        <Route path="planning/optimize" element={
          <ProtectedRoute roles={['admin','planner']}><RouteOptimizer/></ProtectedRoute>
        }/>

        {/* Execution — all roles */}
        <Route path="execution"           element={<ExecutionList/>}/>
        <Route path="execution/closed"    element={<ClosedTrips/>}/>
        <Route path="execution/gate-pass" element={<NonTripGatePass/>}/>
        <Route path="tanker-position"     element={<TankerPosition/>}/>
        <Route path="approvals"           element={<Approvals/>}/>
        <Route path="execution/:id"       element={<ExecutionForm/>}/>
        <Route path="execution/:id/acknowledge" element={<AcknowledgementForm/>}/>

        {/* Reports — all roles */}
        <Route path="billing" element={
          <ProtectedRoute roles={['admin','biller','viewer']}><TankerBilling/></ProtectedRoute>
        }/>
        <Route path="reports" element={<DailyTSReport/>}/>
        <Route path="reports/analytics" element={<Analytics/>}/>
        <Route path="reports/bmcu-breakup" element={<BmcuBreakup/>}/>
        <Route path="reports/trip-durations" element={<TripDurations/>}/>
        <Route path="reports/day-utilisation" element={<DayUtilisation/>}/>
        <Route path="reports/audit" element={
          <ProtectedRoute roles={['admin']}><AuditLog/></ProtectedRoute>
        }/>
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
