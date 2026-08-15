import { app } from './app';
import { env } from './config/env';
import { pool } from './config/db';

async function main() {
  // Start the server first so that Railway's healthcheck can respond quickly
  app.listen(env.port, '0.0.0.0', () => {
    console.log(`ERP API listening on port ${env.port}`);
  });

  // Then check the database connection in the background (will not crash the app if connection fails)
  try {
    await pool.query('SELECT 1');
    console.log('Database connected successfully');
  } catch (error: any) {
    console.error('Warning: Initial database connection failed:', error?.message);
    console.error('Code:', error?.code);
    if (!env.isProduction) {
      console.error('Database config:', {
        host: env.db.host,
        port: env.db.port,
        user: env.db.user,
        database: env.db.database,
      });
    }
  }
}

main().catch((error: any) => {
  console.error('Fatal: could not start server', error);
  console.error('Code:', error?.code);
  console.error('Message:', error?.message);
  if (!env.isProduction) {
    console.error('Stack:', error?.stack);
  }
  process.exit(1);
});