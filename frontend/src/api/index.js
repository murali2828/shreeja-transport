// frontend/src/api/index.js
import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

// Attach JWT token
api.interceptors.request.use(config => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Auto logout on 401
api.interceptors.response.use(
  res => res,
  err => {
    if (err.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

// ── Auth ──────────────────────────────────────────────────────────────────────
export const login          = (d)          => api.post('/auth/login', d);
export const getMe          = ()           => api.get('/auth/me');
export const getUsers       = ()           => api.get('/auth/users');
export const createUser     = (d)          => api.post('/auth/users', d);
export const updateUser     = (id, d)      => api.put(`/auth/users/${id}`, d);
export const forgotPassword = (email)      => api.post('/auth/forgot-password', { email });
export const resetPassword  = (token, new_password) => api.post('/auth/reset-password', { token, new_password });

// ── Masters ───────────────────────────────────────────────────────────────────
export const getTankers         = ()      => api.get('/masters/tankers');
export const createTanker       = (d)     => api.post('/masters/tankers', d);
export const updateTanker       = (id, d) => api.put(`/masters/tankers/${id}`, d);
export const deleteTanker       = (id)    => api.delete(`/masters/tankers/${id}`);

export const getBmcus           = ()      => api.get('/masters/bmcus');
export const createBmcu         = (d)     => api.post('/masters/bmcus', d);
export const updateBmcu         = (id, d) => api.put(`/masters/bmcus/${id}`, d);
export const deleteBmcu         = (id)    => api.delete(`/masters/bmcus/${id}`);

export const getStartingPoints  = ()      => api.get('/masters/starting-points');
export const createStartingPoint= (d)     => api.post('/masters/starting-points', d);
export const updateStartingPoint= (id, d) => api.put(`/masters/starting-points/${id}`, d);
export const deleteStartingPoint= (id)    => api.delete(`/masters/starting-points/${id}`);

export const getTestingPoints   = ()      => api.get('/masters/testing-points');
export const createTestingPoint = (d)     => api.post('/masters/testing-points', d);
export const updateTestingPoint = (id, d) => api.put(`/masters/testing-points/${id}`, d);
export const deleteTestingPoint = (id)    => api.delete(`/masters/testing-points/${id}`);

export const getDeliveryPoints  = ()      => api.get('/masters/delivery-points');
export const createDeliveryPoint= (d)     => api.post('/masters/delivery-points', d);
export const updateDeliveryPoint= (id, d) => api.put(`/masters/delivery-points/${id}`, d);
export const deleteDeliveryPoint= (id)    => api.delete(`/masters/delivery-points/${id}`);

export const getRoutes          = ()      => api.get('/masters/routes');
export const getRoute           = (id)    => api.get(`/masters/routes/${id}`);
export const createRoute        = (d)     => api.post('/masters/routes', d);
export const updateRoute        = (id, d) => api.put(`/masters/routes/${id}`, d);

export const getEmailConfig     = ()      => api.get('/masters/email-config');
export const createEmailConfig  = (d)     => api.post('/masters/email-config', d);
export const updateEmailConfig  = (id, d) => api.put(`/masters/email-config/${id}`, d);
export const deleteEmailConfig  = (id)    => api.delete(`/masters/email-config/${id}`);

// ── Plans ─────────────────────────────────────────────────────────────────────
export const getPlans      = (p)     => api.get('/plans', { params: p });
export const getPlan       = (id)    => api.get(`/plans/${id}`);
export const createPlan    = (d)     => api.post('/plans', d);
export const updatePlan    = (id, d) => api.put(`/plans/${id}`, d);
export const deletePlan    = (id)    => api.delete(`/plans/${id}`);
export const publishPlans  = (date)  => api.post('/plans/publish', { plan_for_date: date });
export const uploadPlans   = (fd)    => api.post('/plans/upload', fd);
export const downloadPlanTemplate = () =>
  api.get('/plans/template/download', { responseType: 'blob' }).then(r => {
    const url = URL.createObjectURL(r.data);
    const a = document.createElement('a');
    a.href = url; a.download = 'trip_plan_template.xlsx'; a.click();
    URL.revokeObjectURL(url);
  });

// ── Executions ────────────────────────────────────────────────────────────────
export const getExecutions      = (p)     => api.get('/executions', { params: p });
export const getExecution       = (id)    => api.get(`/executions/${id}`);
export const createExecution    = (d)     => api.post('/executions', d);
export const updateExecution    = (id, d) => api.put(`/executions/${id}`, d);
export const submitForAck       = (id)    => api.post(`/executions/${id}/submit-ack`);
export const saveAcknowledgements = (id, d) => api.post(`/executions/${id}/acknowledgements`, d);

// ── Reports ───────────────────────────────────────────────────────────────────
export const getDailyTSReport   = (p)    => api.get('/reports/daily-ts', { params: p });
export const getBmcuWiseReport  = (p)    => api.get('/reports/bmcu-wise', { params: p });
export const sendDailyReport    = (date) => api.post('/reports/send-email', { report_date: date });
export const downloadTSExcel    = (date) =>
  api.get(`/reports/daily-ts/excel?report_date=${date}`, { responseType: 'blob' }).then(r => {
    const url = URL.createObjectURL(r.data);
    const a = document.createElement('a');
    a.href = url; a.download = `ts_report_${date}.xlsx`; a.click();
    URL.revokeObjectURL(url);
  });

// ── Distance Master ───────────────────────────────────────────────────────────
export const getDistances          = (p)     => api.get('/distances', { params: p });
export const getDistanceSummary    = ()      => api.get('/distances/summary');
export const createDistance        = (d)     => api.post('/distances', d);
export const updateDistance        = (id, d) => api.put(`/distances/${id}`, d);
export const deleteDistance        = (id)    => api.delete(`/distances/${id}`);
export const downloadDistTemplate  = ()      => { window.open('/api/distances/template', '_blank'); };
export const exportDistances       = ()      => { window.open('/api/distances/export', '_blank'); };
export const uploadDistances       = (fd)    => api.post('/distances/upload', fd);

// ── Route Optimizer ───────────────────────────────────────────────────────────
export const runOptimizer          = (d)     => api.post('/optimize/run', d);
export const saveOptimizerAsPlans  = (sid, trips) => api.post(`/optimize/${sid}/save-as-plans`, { trips });
export const getOptimizeSessions   = (p)     => api.get('/optimize/sessions', { params: p });
export const getOptimizeSession    = (id)    => api.get(`/optimize/sessions/${id}`);
export const getOptimizeCompare    = (p)     => api.get('/optimize/compare', { params: p });

export default api;
