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
import RoleManagement  from './pages/masters/RoleManagement';
import EmailConfig     from './pages/masters/EmailConfig';
import PlanEmailConfig from './pages/masters/PlanEmailConfig';
import DistanceMaster  from './pages/masters/DistanceMaster';
import VendorMaster    from './pages/masters/VendorMaster';
import MaterialMaster  from './pages/masters/MaterialMaster';
import TankerDocuments from './pages/masters/TankerDocuments';

// Planning
import TripPlanList    from './pages/planning/TripPlanList';
import TripPlanForm    from './pages/planning/TripPlanForm';
import DeletedPlansList from './pages/planning/DeletedPlansList';
import RouteOptimizer  from './pages/planning/RouteOptimizer';
import DayOptimizer    from './pages/planning/DayOptimizer';

// Execution
import ExecutionList        from './pages/execution/ExecutionList';
import ExecutionForm        from './pages/execution/ExecutionForm';
import AcknowledgementForm  from './pages/execution/AcknowledgementForm';
import MaterialTripForm     from './pages/execution/MaterialTripForm';
import QaDispatchEntry      from './pages/quality/QaDispatchEntry';
import QaDispatchList       from './pages/quality/QaDispatchList';
import QaDocuments          from './pages/quality/QaDocuments';
import ClosedTrips          from './pages/execution/ClosedTrips';
import Approvals            from './pages/execution/Approvals';
import NonTripGatePass      from './pages/execution/NonTripGatePass';
import TankerPosition       from './pages/execution/TankerPosition';
import LiveTracking         from './pages/execution/LiveTracking';

// Reports
import DailyTSReport   from './pages/reports/DailyTSReport';
import Analytics       from './pages/reports/Analytics';
import CostDrivers     from './pages/reports/CostDrivers';
import TankerRates     from './pages/masters/TankerRates';
import TankerBilling   from './pages/billing/TankerBilling';
import BillingDecision from './pages/billing/BillingDecision';
import ChangeRequestDecision from './pages/changeRequests/ChangeRequestDecision';
import TollChangeDecision from './pages/billing/TollChangeDecision';
import AuditLog        from './pages/reports/AuditLog';
import BmcuBreakup     from './pages/reports/BmcuBreakup';
import TripDurations   from './pages/reports/TripDurations';
import DayUtilisation  from './pages/reports/DayUtilisation';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } }
});

// ─── Role-based Route Guard ───────────────────────────────────────────────────
function ProtectedRoute({ children, roles, module, allowMustChange }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="flex items-center justify-center h-screen text-gray-400">Loading…</div>;
  if (!user)   return <Navigate to="/login" replace />;
  // Force password change before accessing any other page
  if (user.must_change_password && !allowMustChange) return <Navigate to="/change-password" replace />;
  // `module`: allowed when the role's module permission is on (admin always); `roles`: legacy role list.
  const mine = Array.isArray(user.roles) && user.roles.length ? user.roles : [user.role];
  const byModule = module && (mine.includes('admin') || user.permissions?.[module] === true);
  const byRole   = roles && roles.some(r => mine.includes(r));
  if ((roles || module) && !byModule && !byRole) return <Navigate to="/" replace />;
  return children;
}

// Users whose only module is Quality land on the QA entry page instead of the dashboard.
function HomeRedirect({ children }) {
  const { user } = useAuth();
  const p = user?.permissions || {};
  const onlyQuality = user && !(user.roles || [user.role]).includes('admin') && p.quality === true && !p.masters && !p.planning && !p.execution && !p.billing && !p.reports;
  return onlyQuality ? <Navigate to="/quality/entry" replace /> : children;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login"           element={<Login/>}/>
      <Route path="/forgot-password" element={<ForgotPassword/>}/>
      <Route path="/reset-password"  element={<ResetPassword/>}/>
      <Route path="/billing-decision" element={<BillingDecision/>}/>
      <Route path="/change-request-decision" element={<ChangeRequestDecision/>}/>
      <Route path="/toll-change-decision" element={<TollChangeDecision/>}/>
      <Route path="/change-password" element={
        <ProtectedRoute allowMustChange><ChangePassword/></ProtectedRoute>
      }/>

      {/* All protected routes inside Layout */}
      <Route path="/" element={
        <ProtectedRoute><Layout/></ProtectedRoute>
      }>
        <Route index element={<HomeRedirect><Dashboard/></HomeRedirect>}/>

        {/* Quality team — module permission 'quality' (migration 052) */}
        <Route path="quality/entry"   element={<ProtectedRoute module="quality"><QaDispatchEntry/></ProtectedRoute>}/>
        <Route path="quality/entries" element={<ProtectedRoute module="quality"><QaDispatchList/></ProtectedRoute>}/>
        <Route path="quality/documents" element={<ProtectedRoute module="quality"><QaDocuments/></ProtectedRoute>}/>

        {/* Masters — admin + planner */}
        <Route path="masters/tankers" element={
          <ProtectedRoute roles={['admin']} module="masters"><TankerMaster/></ProtectedRoute>
        }/>
        <Route path="masters/bmcus" element={
          <ProtectedRoute roles={['admin']} module="masters"><BmcuMaster/></ProtectedRoute>
        }/>
        <Route path="masters/routes" element={
          <ProtectedRoute roles={['admin']} module="masters"><RouteMaster/></ProtectedRoute>
        }/>
        <Route path="masters/locations" element={
          <ProtectedRoute roles={['admin']} module="masters"><LocationMasters/></ProtectedRoute>
        }/>
        <Route path="masters/tanker-rates" element={
          <ProtectedRoute roles={['admin']} module="masters"><TankerRates/></ProtectedRoute>
        }/>
        <Route path="masters/distances" element={
          <ProtectedRoute roles={['admin']} module="masters"><DistanceMaster/></ProtectedRoute>
        }/>
        <Route path="masters/vendors" element={
          <ProtectedRoute roles={['admin']} module="masters"><VendorMaster/></ProtectedRoute>
        }/>
        <Route path="masters/materials" element={
          <ProtectedRoute roles={['admin']} module="masters"><MaterialMaster/></ProtectedRoute>
        }/>
        <Route path="masters/documents" element={
          <ProtectedRoute roles={['admin','executor']} module="masters"><TankerDocuments/></ProtectedRoute>
        }/>
        <Route path="masters/roles" element={
          <ProtectedRoute roles={['admin']}><RoleManagement/></ProtectedRoute>
        }/>
        <Route path="masters/users" element={
          <ProtectedRoute roles={['admin']}><UserManagement/></ProtectedRoute>
        }/>
        <Route path="masters/email-config" element={
          <ProtectedRoute roles={['admin']} module="masters"><EmailConfig/></ProtectedRoute>
        }/>
        <Route path="masters/plan-emails" element={
          <ProtectedRoute roles={['admin']} module="masters"><PlanEmailConfig/></ProtectedRoute>
        }/>

        {/* Planning — admin + planner */}
        <Route path="planning" element={
          <ProtectedRoute roles={['admin','planner']} module="planning"><TripPlanList/></ProtectedRoute>
        }/>
        <Route path="planning/new" element={
          <ProtectedRoute roles={['admin','planner']} module="planning"><TripPlanForm/></ProtectedRoute>
        }/>
        <Route path="planning/:id/edit" element={
          <ProtectedRoute roles={['admin','planner']} module="planning"><TripPlanForm/></ProtectedRoute>
        }/>
        <Route path="planning/deleted" element={
          <ProtectedRoute roles={['admin','planner']} module="planning"><DeletedPlansList/></ProtectedRoute>
        }/>
        <Route path="planning/optimize" element={
          <ProtectedRoute roles={['admin','planner']} module="planning"><RouteOptimizer/></ProtectedRoute>
        }/>
        <Route path="planning/optimize-day" element={
          <ProtectedRoute roles={['admin','planner']} module="planning"><DayOptimizer/></ProtectedRoute>
        }/>

        {/* Execution — all roles */}
        <Route path="execution" element={<ProtectedRoute roles={['admin','planner','executor','biller','viewer']} module="execution"><ExecutionList/></ProtectedRoute>}/>
        <Route path="execution/closed" element={<ProtectedRoute roles={['admin','planner','executor','biller','viewer']} module="execution"><ClosedTrips/></ProtectedRoute>}/>
        <Route path="execution/gate-pass" element={<ProtectedRoute roles={['admin','planner','executor','biller','viewer']} module="execution"><NonTripGatePass/></ProtectedRoute>}/>
        <Route path="tanker-position" element={<ProtectedRoute roles={['admin','planner','executor','biller','viewer']} module="execution"><TankerPosition/></ProtectedRoute>}/>
        <Route path="tracking"            element={
          <ProtectedRoute roles={['admin','planner','executor','biller','viewer']} module="execution"><LiveTracking/></ProtectedRoute>
        }/>
        <Route path="approvals" element={<ProtectedRoute roles={['admin','planner','executor','biller','viewer']} module="execution"><Approvals/></ProtectedRoute>}/>
        <Route path="execution/:id" element={<ProtectedRoute roles={['admin','planner','executor','biller','viewer']} module="execution"><ExecutionForm/></ProtectedRoute>}/>
        <Route path="execution/:id/acknowledge" element={<ProtectedRoute roles={['admin','planner','executor','biller','viewer']} module="execution"><AcknowledgementForm/></ProtectedRoute>}/>
        <Route path="execution/:id/material" element={<ProtectedRoute roles={['admin','planner','executor','biller','viewer']} module="execution"><MaterialTripForm/></ProtectedRoute>}/>

        {/* Reports — all roles */}
        <Route path="billing" element={
          <ProtectedRoute roles={['admin','biller']} module="billing"><TankerBilling/></ProtectedRoute>
        }/>
        <Route path="reports" element={<ProtectedRoute module="reports"><DailyTSReport/></ProtectedRoute>}/>
        <Route path="reports/analytics" element={<ProtectedRoute module="reports"><Analytics/></ProtectedRoute>}/>
        <Route path="reports/cost-drivers" element={<ProtectedRoute module="reports"><CostDrivers/></ProtectedRoute>}/>
        <Route path="reports/bmcu-breakup" element={<ProtectedRoute module="reports"><BmcuBreakup/></ProtectedRoute>}/>
        <Route path="reports/trip-durations" element={<ProtectedRoute module="reports"><TripDurations/></ProtectedRoute>}/>
        <Route path="reports/day-utilisation" element={<ProtectedRoute module="reports"><DayUtilisation/></ProtectedRoute>}/>
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
