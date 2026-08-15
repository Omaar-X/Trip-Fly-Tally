import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import path from 'path';
import { env } from './config/env';
import { pool } from './config/db';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { apiRateLimiter, authRateLimiter, corsOptions } from './middleware/security';

import authRoutes from './modules/auth/auth.routes';
import accountingRoutes from './modules/accounting/accounting.routes';
import reportsRoutes from './modules/reports/reports.routes';
import inventoryRoutes from './modules/inventory/inventory.routes';
import crmRoutes from './modules/crm/crm.routes';
import bookingsRoutes from './modules/bookings/bookings.routes';
import paymentsRoutes from './modules/payments/payments.routes';
import invoicesRoutes from './modules/invoices/invoices.routes';
import hrRoutes from './modules/hr/hr.routes';
import dashboardRoutes from './modules/dashboard/dashboard.routes';
import adminDatabaseRoutes from './modules/adminDatabase/adminDatabase.routes';
import companySettingsRoutes from './modules/companySettings/companySettings.routes';

export const app = express();

// ------------------------------ security ------------------------------------
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));
app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'));

app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: `${env.appSlug}-api` }));
app.get('/api/ready', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ready', service: `${env.appSlug}-api`, database: 'ok' });
  } catch (error) {
    console.error('Readiness database check failed:', error);
    res.status(503).json({ status: 'not_ready', service: `${env.appSlug}-api`, database: 'unavailable' });
  }
});

// Uploaded company branding assets (logo/favicon). NOTE: on Railway this
// directory is on the ephemeral local filesystem and will NOT survive a
// redeploy unless a persistent volume is mounted at this path.
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));
// Versioned branding assets live in the deployable application bundle, so the
// company logo does not disappear when an ephemeral uploads volume is reset.
app.use('/branding', express.static(path.join(process.cwd(), 'public', 'branding')));

// ------------------------------- modules ------------------------------------
app.use('/api', apiRateLimiter);
app.use('/api/auth/login', authRateLimiter);
app.use('/api/auth/refresh', authRateLimiter);
app.use('/api/auth', authRoutes);
// Mounted before accountingRoutes: that router is mounted at the bare '/api'
// prefix and applies an unconditional `authenticate` to everything under it
// (see accounting.routes.ts), which would otherwise shadow the public
// GET /api/company-settings/public route below.
app.use('/api/company-settings', companySettingsRoutes);
app.use('/api', accountingRoutes);            // /api/ledgers, /api/vouchers ...
app.use('/api/reports', reportsRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/crm', crmRoutes);
app.use('/api/bookings', bookingsRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/invoices', invoicesRoutes);
app.use('/api/hr', hrRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/admin/database', adminDatabaseRoutes);

// ------------------------------ error pipe ----------------------------------
app.use(notFoundHandler);
app.use(errorHandler);
