import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

api.interceptors.request.use(cfg => {
  const token = localStorage.getItem('token');
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

api.interceptors.response.use(
  r => r,
  err => {
    if (err.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

// Auth
export const login = (data) => api.post('/auth/login', data);
export const getMe = () => api.get('/auth/me');
export const getUsers = () => api.get('/auth/users');
export const createUser = (data) => api.post('/auth/users', data);
export const updateUser = (id, data) => api.put(`/auth/users/${id}`, data);

// Masters
export const getTankers = () => api.get('/masters/tankers');
export const createTanker = (d) => api.post('/masters/tankers', d);
export const updateTanker = (id, d) => api.put(`/masters/tankers/${id}`, d);
export const deleteTanker = (id) => api.delete(`/masters/tankers/${id}`);

export const getBmcus = () => api.get('/masters/bmcus');
export const createBmcu = (d) => api.post('/masters/bmcus', d);
export const updateBmcu = (id, d) => api.put(`/masters/bmcus/${id}`, d);
export const deleteBmcu = (id) => api.delete(`/masters/bmcus/${id}`);

export const getStartingPoints = () => api.get('/masters/starting-points');
export const createStartingPoint = (d) => api.post('/masters/starting-points', d);
export const updateStartingPoint = (id, d) => api.put(`/masters/starting-points/${id}`, d);
export const deleteStartingPoint = (id) => api.delete(`/masters/starting-points/${id}`);

export const getTestingPoints = () => api.get('/masters/testing-points');
export const createTestingPoint = (d) => api.post('/masters/testing-points', d);
export const updateTestingPoint = (id, d) => api.put(`/masters/testing-points/${id}`, d);
export const deleteTestingPoint = (id) => api.delete(`/masters/testing-points/${id}`);

export const getDeliveryPoints = () => api.get('/masters/delivery-points');
export const createDeliveryPoint = (d) => api.post('/masters/delivery-points', d);
export const updateDeliveryPoint = (id, d) => api.put(`/masters/delivery-points/${id}`, d);
export const deleteDeliveryPoint = (id) => api.delete(`/masters/delivery-points/${id}`);

export const getRoutes = () => api.get('/masters/routes');
export const getRoute = (id) => api.get(`/masters/routes/${id}`);
export const createRoute = (d) => api.post('/masters/routes', d);
export const updateRoute = (id, d) => api.put(`/masters/routes/${id}`, d);

export const getEmailConfig = () => api.get('/masters/email-config');
export const createEmailConfig = (d) => api.post('/masters/email-config', d);
export const updateEmailConfig = (id, d) => api.put(`/masters/email-config/${id}`, d);
export const deleteEmailConfig = (id) => api.delete(`/masters/email-config/${id}`);

// Plans
export const getPlans = (params) => api.get('/plans', { params });
export const getPlan = (id) => api.get(`/plans/${id}`);
export const createPlan = (d) => api.post('/plans', d);
export const updatePlan = (id, d) => api.put(`/plans/${id}`, d);
export const deletePlan = (id) => api.delete(`/plans/${id}`);
export const publishPlans = (plan_for_date) => api.post('/plans/publish', { plan_for_date });
export const uploadPlans = (formData) => api.post('/plans/upload', formData, { headers: { 'Content-Type': 'multipart/form-data' } });

// Executions
export const getExecutions = (params) => api.get('/executions', { params });
export const getExecution = (id) => api.get(`/executions/${id}`);
export const createExecution = (d) => api.post('/executions', d);
export const updateExecution = (id, d) => api.put(`/executions/${id}`, d);
export const submitForAck = (id) => api.post(`/executions/${id}/submit-ack`);
export const saveAcknowledgements = (id, d) => api.post(`/executions/${id}/acknowledgements`, d);

// Reports
export const getDailyTSReport = (params) => api.get('/reports/daily-ts', { params });
export const getBmcuWiseReport = (params) => api.get('/reports/bmcu-wise', { params });
export const sendDailyReport = (report_date) => api.post('/reports/send-email', { report_date });
export const downloadTSExcel = (report_date) => api.get('/reports/daily-ts/excel', {
  params: { report_date }, responseType: 'blob'
});

export default api;
