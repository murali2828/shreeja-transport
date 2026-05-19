import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import TankerMaster from './pages/masters/TankerMaster';
import BmcuMaster from './pages/masters/BmcuMaster';
import RouteMaster from './pages/masters/RouteMaster';
import LocationMasters from './pages/masters/LocationMasters';
import UserManagement from './pages/masters/UserManagement';
import EmailConfig from './pages/masters/EmailConfig';
import TripPlanList from './pages/planning/TripPlanList';
import TripPlanForm from './pages/planning/TripPlanForm';
import ExecutionList from './pages/execution/ExecutionList';
import ExecutionForm from './pages/execution/ExecutionForm';
import AcknowledgementForm from './pages/execution/AcknowledgementForm';
import ClosedTrips from './pages/execution/ClosedTrips';
import DailyTSReport from './pages/reports/DailyTSReport';

function ProtectedRoute({ children, roles }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return children;
}

function AppRoutes() {
  const { user } = useAuth();
  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
      <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
        <Route index element={<Dashboard />} />
        <Route path="masters/tankers" element={<ProtectedRoute roles={['admin','planner']}><TankerMaster /></ProtectedRoute>} />
        <Route path="masters/bmcus" element={<ProtectedRoute roles={['admin','planner']}><BmcuMaster /></ProtectedRoute>} />
        <Route path="masters/routes" element={<ProtectedRoute roles={['admin','planner']}><RouteMaster /></ProtectedRoute>} />
        <Route path="masters/locations" element={<ProtectedRoute roles={['admin','planner']}><LocationMasters /></ProtectedRoute>} />
        <Route path="masters/users" element={<ProtectedRoute roles={['admin']}><UserManagement /></ProtectedRoute>} />
        <Route path="masters/email-config" element={<ProtectedRoute roles={['admin']}><EmailConfig /></ProtectedRoute>} />
        <Route path="planning" element={<ProtectedRoute roles={['admin','planner']}><TripPlanList /></ProtectedRoute>} />
        <Route path="planning/new" element={<ProtectedRoute roles={['admin','planner']}><TripPlanForm /></ProtectedRoute>} />
        <Route path="planning/:id/edit" element={<ProtectedRoute roles={['admin','planner']}><TripPlanForm /></ProtectedRoute>} />
        <Route path="execution" element={<ExecutionList />} />
        <Route path="execution/:id" element={<ExecutionForm />} />
        <Route path="execution/:id/acknowledge" element={<AcknowledgementForm />} />
        <Route path="execution/closed" element={<ClosedTrips />} />
        <Route path="reports" element={<DailyTSReport />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  );
}
