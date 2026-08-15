import dotenv from 'dotenv';

if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

const isProduction = process.env.NODE_ENV === 'production';
const nodeEnv = process.env.NODE_ENV ?? 'development';

const required = (key: string, fallback?: string): string => {
  const v = process.env[key] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing required env var: ${key}`);
  return v;
};

const requiredInProduction = (key: string, fallback?: string): string =>
  required(key, isProduction ? undefined : fallback);

const first = (...values: Array<string | undefined>): string | undefined =>
  values.find((value) => value !== undefined && value !== '');

const databaseUrl = first(process.env.DATABASE_URL, process.env.MYSQL_URL);
const databaseUrlConfig = databaseUrl ? new URL(databaseUrl) : undefined;

const fromDatabaseUrl = (field: 'host' | 'port' | 'user' | 'password' | 'database'): string | undefined => {
  if (!databaseUrlConfig) return undefined;
  if (field === 'host') return databaseUrlConfig.hostname;
  if (field === 'port') return databaseUrlConfig.port;
  if (field === 'user') return decodeURIComponent(databaseUrlConfig.username);
  if (field === 'password') return decodeURIComponent(databaseUrlConfig.password);
  return databaseUrlConfig.pathname.replace(/^\//, '') || undefined;
};

const dbConfig = (
  keys: string[],
  value: string | undefined,
  developmentFallback?: string
): string => {
  const resolved = value ?? (isProduction ? undefined : developmentFallback);
  if (resolved === undefined) {
    throw new Error(`Missing DB config: set ${keys.join(' or ')}`);
  }
  return resolved;
};

const numberFromEnv = (key: string, fallback: string, min = 0): number => {
  const raw = required(key, fallback);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`Invalid numeric env var: ${key}`);
  }
  return value;
};

const splitList = (value: string): string[] =>
  value.split(',').map((item) => item.trim()).filter(Boolean);

const appSlug = (process.env.APP_SLUG ?? 'erp').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'erp';

/**
 * The timezone the business keeps its books in. Every "is this voucher
 * back/future dated?" decision is made against the calendar date in THIS zone,
 * not the server's UTC date — otherwise a voucher posted at 3am in Dhaka
 * (UTC+6) would be judged against yesterday's UTC date and rejected as
 * future-dated. Validated at boot so a typo fails fast instead of silently
 * falling back to UTC.
 */
const businessTimezone = required('BUSINESS_TIMEZONE', 'Asia/Dhaka');
try {
  new Intl.DateTimeFormat('en-CA', { timeZone: businessTimezone });
} catch {
  throw new Error(`Invalid BUSINESS_TIMEZONE: ${businessTimezone}`);
}

const corsOriginValue = requiredInProduction('CORS_ORIGIN', 'http://localhost:5173,http://127.0.0.1:5173');
const corsOrigins = splitList(corsOriginValue);

if (isProduction && corsOrigins.includes('*')) {
  throw new Error('CORS_ORIGIN cannot be "*" in production when credentials are enabled');
}

const accessSecret = requiredInProduction('JWT_ACCESS_SECRET', 'dev_access_secret_change_in_production_!!');
const refreshSecret = requiredInProduction('JWT_REFRESH_SECRET', 'dev_refresh_secret_change_in_production_!');

if (isProduction) {
  if (accessSecret.length < 32 || refreshSecret.length < 32) {
    throw new Error('JWT secrets must be at least 32 characters in production');
  }
  if (accessSecret === refreshSecret) {
    throw new Error('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different');
  }
}

export const env = {
  port: numberFromEnv('PORT', '4000', 1),
  nodeEnv,
  isProduction,
  corsOrigins,
  appSlug,
  businessTimezone,
  db: {
    host: dbConfig(['DB_HOST', 'MYSQLHOST', 'DATABASE_URL', 'MYSQL_URL'], first(process.env.DB_HOST, process.env.MYSQLHOST, fromDatabaseUrl('host')), 'localhost'),
    port: Number(first(process.env.DB_PORT, process.env.MYSQLPORT, fromDatabaseUrl('port')) ?? '3306'),
    user: dbConfig(['DB_USER', 'MYSQLUSER', 'DATABASE_URL', 'MYSQL_URL'], first(process.env.DB_USER, process.env.MYSQLUSER, fromDatabaseUrl('user')), 'root'),
    password: dbConfig(['DB_PASSWORD', 'MYSQLPASSWORD', 'DATABASE_URL', 'MYSQL_URL'], first(process.env.DB_PASSWORD, process.env.MYSQLPASSWORD, fromDatabaseUrl('password')), ''),
    database: dbConfig(['DB_NAME', 'MYSQLDATABASE', 'MYSQL_DATABASE', 'DATABASE_URL', 'MYSQL_URL'], first(process.env.DB_NAME, process.env.MYSQLDATABASE, process.env.MYSQL_DATABASE, fromDatabaseUrl('database')), `${appSlug}_db`),
    connectionLimit: numberFromEnv('DB_CONNECTION_LIMIT', isProduction ? '20' : '10', 1),
  },
  jwt: {
    accessSecret,
    refreshSecret,
    accessTtl: required('ACCESS_TOKEN_TTL', '15m'),
    refreshTtlDays: numberFromEnv('REFRESH_TOKEN_TTL_DAYS', '7', 1),
    issuer: required('JWT_ISSUER', `${appSlug}-api`),
    audience: required('JWT_AUDIENCE', appSlug),
  },
  bcryptRounds: numberFromEnv('BCRYPT_ROUNDS', isProduction ? '12' : '10', 10),
  mail: {
    host: process.env.SMTP_HOST ?? '',
    port: Number(process.env.SMTP_PORT ?? '587'),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER ?? '',
    password: process.env.SMTP_PASSWORD ?? '',
    from: process.env.MAIL_FROM ?? '',
  },
  rateLimit: {
    windowMs: numberFromEnv('RATE_LIMIT_WINDOW_MS', '900000', 1000),
    max: numberFromEnv('RATE_LIMIT_MAX', isProduction ? '300' : '1000', 1),
    authWindowMs: numberFromEnv('AUTH_RATE_LIMIT_WINDOW_MS', '900000', 1000),
    authMax: numberFromEnv('AUTH_RATE_LIMIT_MAX', isProduction ? '20' : '100', 1),
  },
};
