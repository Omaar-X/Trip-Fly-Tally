# Trip Fly ERP Production Deployment Guide

This project is production-ready for the intended stack:

- Frontend: React, Vite, TypeScript on Vercel
- Backend: Node.js, Express, TypeScript on Railway
- Database: Railway MySQL

## Issues Found And Fixed

- Missing runtime security middleware for rate limiting and compression.
- CORS allowed only a static list without explicit rejection behavior or production wildcard protection.
- JWTs did not enforce issuer/audience checks.
- Production env parsing accepted empty values and weak/equal JWT secrets.
- Password hashing rounds were fixed in code instead of configurable by environment.
- `/api/auth/me` returned token claims instead of reloading the active user from MySQL.
- Frontend session reload could lose the user email.
- Frontend API error parsing expected `field`, while backend validation returns `path`.
- Frontend API client had no request timeout.
- Route params and query strings used unchecked `Number(...)` in several controllers.
- Auth, report, booking, invoice, payment, inventory, HR, CRM, and admin DB inputs now have stricter Zod validation.
- `schema.sql` and `seed.sql` hardcoded `USE tripfly_erp`, which is unsafe for Railway-managed database names.
- Frontend shipped one oversized JavaScript bundle; routes are now lazy-loaded.
- Vercel SPA fallback and security headers were missing.
- Railway configs now use deterministic `npm ci` installs.

## Verification Completed

- Backend build: `npm run build`
- Frontend build: `npm run build`
- Backend high-severity audit: `npm audit --audit-level=high`
- Frontend high-severity audit: `npm audit --audit-level=high`
- Backend app import check after build: `node -e "require('./dist/app'); console.log('app import ok')"`

Local MySQL execution was not completed because `mysql` is not available on PATH in this workspace and no local MySQL process is running. The SQL has been adjusted for Railway compatibility by targeting the selected database from the connection string.

## Railway Backend Variables

Set these in the Railway backend service:

```bash
NODE_ENV=production
PORT=4000
CORS_ORIGIN=https://your-frontend.vercel.app,https://erp.yourdomain.com
DATABASE_URL=${{MySQL.DATABASE_URL}}
DB_CONNECTION_LIMIT=20
JWT_ACCESS_SECRET=<64+ random characters>
JWT_REFRESH_SECRET=<different 64+ random characters>
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_TTL_DAYS=7
BCRYPT_ROUNDS=12
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX=300
AUTH_RATE_LIMIT_WINDOW_MS=900000
AUTH_RATE_LIMIT_MAX=20
```

If Railway does not expose `DATABASE_URL`, use its native MySQL variables instead:

```bash
MYSQLHOST=${{MySQL.MYSQLHOST}}
MYSQLPORT=${{MySQL.MYSQLPORT}}
MYSQLUSER=${{MySQL.MYSQLUSER}}
MYSQLPASSWORD=${{MySQL.MYSQLPASSWORD}}
MYSQLDATABASE=${{MySQL.MYSQLDATABASE}}
```

## Vercel Frontend Variables

Set this in Vercel for Production, Preview, and Development as needed:

```bash
VITE_API_URL=https://your-backend.up.railway.app
```

## Database Import

For Railway MySQL, connect to the Railway database and run:

```bash
mysql "$DATABASE_URL" < database/schema.sql
mysql "$DATABASE_URL" < database/seed.sql
```

For local MySQL:

```bash
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS tripfly_erp CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -u root -p tripfly_erp < database/schema.sql
mysql -u root -p tripfly_erp < database/seed.sql
```

Run `schema.sql` only on an empty database or during an intentional reset because it drops and recreates application tables.

## Railway Backend Deployment

1. Create a Railway MySQL service.
2. Create a Railway backend service from this repo.
3. Set the service root directory to `backend`.
4. Railway will read `backend/railway.json`.
5. Add the backend environment variables listed above.
6. Deploy the backend.
7. Confirm health check: `https://your-backend.up.railway.app/api/health`.

## Vercel Frontend Deployment

1. Import this repository into Vercel.
2. Set the project root directory to `frontend`.
3. Vercel will read `frontend/vercel.json`.
4. Add `VITE_API_URL`.
5. Deploy.
6. Add the Vercel production URL to backend `CORS_ORIGIN`.
7. Redeploy the backend after changing `CORS_ORIGIN`.

## Production Checklist

- Generate unique production JWT secrets.
- Change or remove seeded demo accounts before public launch.
- Import schema and seed only into the intended database.
- Configure Railway automated database backups.
- Add custom domains for Vercel and Railway if needed.
- Add all frontend domains to backend `CORS_ORIGIN`.
- Enable Railway deployment health checks.
- Verify login, refresh, logout, and role-restricted routes.
- Verify PDF invoice and payslip downloads.
- Verify customer booking to invoice to payment flow.
- Verify payroll generate to approve to pay flow.
- Keep `.env` files out of git; use platform variables for production.
